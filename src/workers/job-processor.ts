import type { SQSRecord } from 'aws-lambda';

import type { JobCompletion, JobRepository } from './job-repository';

export class NonRetryableWorkerError extends Error {
  public readonly code: string;
  public readonly safeMessage: string;

  constructor(code: string, safeMessage: string) {
    super(safeMessage);
    this.name = 'NonRetryableWorkerError';
    this.code = code;
    this.safeMessage = safeMessage;
  }
}

type JobPayload = {
  jobId: string;
  accountId: string;
};

type JobProcessorOptions<T extends JobPayload> = {
  jobsForAccount: (accountId: string) => JobRepository;
  handle: (payload: T, record: SQSRecord) => Promise<void | JobCompletion>;
  expectedJobType: 'PDF_GENERATE' | 'REPORT_EXPORT' | 'NOTIFY';
  maxReceiveCount?: number;
  staleAfterMs: number;
  now?: () => Date;
};

export const createIdempotentJobProcessor = <T extends JobPayload>({
  jobsForAccount,
  handle,
  expectedJobType,
  maxReceiveCount = 3,
  staleAfterMs,
  now = () => new Date(),
}: JobProcessorOptions<T>) => {
  if (!Number.isFinite(staleAfterMs) || staleAfterMs <= 0 || !Number.isInteger(maxReceiveCount) || maxReceiveCount < 1) {
    throw new Error('Worker retry and stale-timeout settings must be positive.');
  }

  return async (payload: T, record: SQSRecord): Promise<void> => {
    const jobs = jobsForAccount(payload.accountId);
    const job = await jobs.get(payload.jobId);

    if (!job) {
      throw new NonRetryableWorkerError('JOB_NOT_FOUND', 'Job not found.');
    }

    if (job.accountId !== payload.accountId) {
      throw new NonRetryableWorkerError('JOB_ACCOUNT_MISMATCH', 'Job does not belong to this account.');
    }

    if (job.status === 'succeeded' || job.status === 'failed') {
      return;
    }

    const startedAt = job.startedAt === undefined ? Number.NEGATIVE_INFINITY : Date.parse(job.startedAt);
    const nowDate = now();

    if (
      job.status === 'processing' &&
      Number.isFinite(startedAt) &&
      nowDate.getTime() - startedAt <= staleAfterMs
    ) {
      return;
    }

    const claimedJob = await jobs.claim(
      payload.jobId,
      nowDate.toISOString(),
      new Date(nowDate.getTime() - staleAfterMs).toISOString(),
    );

    if (!claimedJob) {
      const currentJob = await jobs.get(payload.jobId);
      const currentStartedAt =
        currentJob?.startedAt === undefined ? Number.NaN : Date.parse(currentJob.startedAt);

      if (
        currentJob?.status === 'succeeded' ||
        currentJob?.status === 'failed' ||
        (currentJob?.status === 'processing' &&
          Number.isFinite(currentStartedAt) &&
          now().getTime() - currentStartedAt <= staleAfterMs)
      ) {
        return;
      }

      throw new Error('Job could not be claimed; retry the SQS message.');
    }

    if (claimedJob.status !== 'processing') {
      throw new Error('Claimed job was not returned in processing state.');
    }

    if (claimedJob.jobType !== expectedJobType) {
      const markedFailed = await jobs.markFailed(payload.jobId, now().toISOString(), {
        code: 'JOB_TYPE_MISMATCH',
        message: 'Job type does not match this worker.',
      });

      if (!markedFailed) {
        throw new Error('Could not mark mismatched job as failed.');
      }

      throw new NonRetryableWorkerError('JOB_TYPE_MISMATCH', 'Job type does not match this worker.');
    }

    try {
      const completion = await handle(payload, record);
      const jobCompletion: JobCompletion | undefined =
        completion === undefined ? undefined : completion;
      const succeeded = await jobs.markSucceeded(payload.jobId, now().toISOString(), jobCompletion);

      if (!succeeded) {
        throw new Error('Could not mark job as succeeded.');
      }
    } catch (error) {
      const latestJob = await jobs.get(payload.jobId);

      if (latestJob?.status === 'succeeded') {
        return;
      }

      const failedAt = now().toISOString();

      if (error instanceof NonRetryableWorkerError) {
        const markedFailed = await jobs.markFailed(payload.jobId, failedAt, {
          code: error.code,
          message: error.safeMessage,
        });

        if (!markedFailed) {
          throw new Error('Could not mark non-retryable job failure.');
        }

        return;
      }

      const receiveCount = Number(record.attributes.ApproximateReceiveCount);

      if (Number.isFinite(receiveCount) && receiveCount >= maxReceiveCount) {
        const markedFailed = await jobs.markFailed(payload.jobId, failedAt, {
          code: 'WORKER_RETRIES_EXHAUSTED',
          message: 'Processing failed after the permitted number of attempts.',
        });

        if (!markedFailed) {
          throw new Error('Could not mark exhausted job as failed.');
        }

        throw error;
      }

      const returnedToQueue = await jobs.markRetryable(payload.jobId, failedAt, {
        code: 'WORKER_RETRYABLE_FAILURE',
        message: 'Processing failed; the job will be retried.',
      });

      if (!returnedToQueue) {
        throw new Error('Could not release failed job for retry.');
      }

      throw error;
    }
  };
};
