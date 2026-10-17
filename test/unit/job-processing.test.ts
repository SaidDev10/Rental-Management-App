import type { SQSEvent, SQSRecord } from 'aws-lambda';
import { describe, expect, it, vi } from 'vitest';

import { createPdfWorkerHandler } from '../../src/lambdas/pdf-worker';
import { NonRetryableWorkerError, createIdempotentJobProcessor } from '../../src/workers/job-processor';
import type { JobRecord, JobRepository } from '../../src/workers/job-repository';
import type { PdfJobPayload } from '../../src/workers/payloads';

const accountId = '01JEXAMPLEACCOUNT00000000001';
const jobId = '01JEXAMPLEJOB000000000000001';
const now = new Date('2026-10-17T10:00:00.000Z');
const record = {
  messageId: 'message-1',
  body: JSON.stringify({ jobId, accountId, documentType: 'QUITTANCE', paymentId: 'payment-1' }),
  attributes: { ApproximateReceiveCount: '1' },
} as SQSRecord;

const makeJob = (overrides: Partial<JobRecord> = {}): JobRecord => ({
  PK: `ACCOUNT#${accountId}`,
  SK: `JOB#${jobId}`,
  accountId,
  entityType: 'Job',
  jobType: 'PDF_GENERATE',
  status: 'queued',
  attempts: 0,
  updatedAt: now.toISOString(),
  ...overrides,
});

const makeRepository = (initialJob: JobRecord | undefined = makeJob()) => {
  let currentJob = initialJob;
  const get = vi.fn(async () => currentJob);
  const claim = vi.fn(async () => {
    if (!currentJob || currentJob.status !== 'queued') {
      return undefined;
    }

    currentJob = makeJob({
      ...currentJob,
      status: 'processing',
      startedAt: now.toISOString(),
      attempts: currentJob.attempts + 1,
    });

    return currentJob;
  });
  const markSucceeded = vi.fn(async () => {
    if (!currentJob || currentJob.status !== 'processing') {
      return false;
    }

    currentJob = makeJob({ ...currentJob, status: 'succeeded' });

    return true;
  });
  const markRetryable = vi.fn(async () => {
    if (!currentJob || currentJob.status !== 'processing') {
      return false;
    }

    currentJob = makeJob({ ...currentJob, status: 'queued' });

    return true;
  });
  const markFailed = vi.fn(async () => {
    if (!currentJob || currentJob.status !== 'processing') {
      return false;
    }

    currentJob = makeJob({ ...currentJob, status: 'failed' });

    return true;
  });

  return {
    repository: {
      get,
      claim,
      markSucceeded,
      markRetryable,
      markFailed,
    } as unknown as JobRepository,
    get,
    claim,
    markSucceeded,
    markRetryable,
    markFailed,
  };
};

const payload = { jobId, accountId };

describe('idempotent job processor', () => {
  it('claims queued work, invokes the processor, and marks success', async () => {
    const jobs = makeRepository();
    const process = vi.fn(async () => undefined);
    const handler = createIdempotentJobProcessor({
      jobsForAccount: () => jobs.repository,
      handle: process,
      expectedJobType: 'PDF_GENERATE',
      staleAfterMs: 120_000,
      now: () => now,
    });

    await handler(payload, record);

    expect(jobs.claim).toHaveBeenCalledWith(
      jobId,
      now.toISOString(),
      new Date(now.getTime() - 120_000).toISOString(),
    );
    expect(process).toHaveBeenCalledOnce();
    expect(jobs.markSucceeded).toHaveBeenCalledOnce();
  });

  it('acks terminal jobs and active processing jobs without repeating side effects', async () => {
    const completed = makeRepository(makeJob({ status: 'succeeded' }));
    const inProgress = makeRepository(
      makeJob({ status: 'processing', startedAt: new Date(now.getTime() - 30_000).toISOString() }),
    );
    const process = vi.fn(async () => undefined);
    const handler = createIdempotentJobProcessor({
      jobsForAccount: () => completed.repository,
      handle: process,
      expectedJobType: 'PDF_GENERATE',
      staleAfterMs: 120_000,
      now: () => now,
    });

    await handler(payload, record);

    const activeHandler = createIdempotentJobProcessor({
      jobsForAccount: () => inProgress.repository,
      handle: process,
      expectedJobType: 'PDF_GENERATE',
      staleAfterMs: 120_000,
      now: () => now,
    });

    await activeHandler(payload, record);

    expect(completed.claim).not.toHaveBeenCalled();
    expect(inProgress.claim).not.toHaveBeenCalled();
    expect(process).not.toHaveBeenCalled();
  });

  it('resets retryable jobs before rethrowing so the SQS record is retried', async () => {
    const jobs = makeRepository();
    const process = vi.fn(async () => {
      throw new Error('transient failure');
    });
    const handler = createIdempotentJobProcessor({
      jobsForAccount: () => jobs.repository,
      handle: process,
      expectedJobType: 'PDF_GENERATE',
      staleAfterMs: 120_000,
      now: () => now,
    });

    await expect(handler(payload, record)).rejects.toThrow('transient failure');

    expect(jobs.markRetryable).toHaveBeenCalledWith(jobId, now.toISOString(), {
      code: 'WORKER_RETRYABLE_FAILURE',
      message: 'Processing failed; the job will be retried.',
    });
  });

  it('records non-retryable failures as terminal and acknowledges them', async () => {
    const jobs = makeRepository();
    const process = vi.fn(async () => {
      throw new NonRetryableWorkerError('INVALID_DOCUMENT', 'Document cannot be rendered.');
    });
    const handler = createIdempotentJobProcessor({
      jobsForAccount: () => jobs.repository,
      handle: process,
      expectedJobType: 'PDF_GENERATE',
      staleAfterMs: 120_000,
      now: () => now,
    });

    await expect(handler(payload, record)).resolves.toBeUndefined();

    expect(jobs.markFailed).toHaveBeenCalledWith(jobId, now.toISOString(), {
      code: 'INVALID_DOCUMENT',
      message: 'Document cannot be rendered.',
    });
  });

  it('marks a queued job routed to the wrong worker failed', async () => {
    const jobs = makeRepository(makeJob({ jobType: 'REPORT_EXPORT' }));
    const process = vi.fn(async () => undefined);
    const handler = createIdempotentJobProcessor({
      jobsForAccount: () => jobs.repository,
      handle: process,
      expectedJobType: 'PDF_GENERATE',
      staleAfterMs: 120_000,
      now: () => now,
    });

    await expect(handler(payload, record)).rejects.toMatchObject({
      code: 'JOB_TYPE_MISMATCH',
    });
    expect(jobs.claim).toHaveBeenCalledOnce();
    expect(jobs.markFailed).toHaveBeenCalledWith(jobId, now.toISOString(), {
      code: 'JOB_TYPE_MISMATCH',
      message: 'Job type does not match this worker.',
    });
  });

  it('marks retry exhaustion terminal while preserving SQS redrive failure', async () => {
    const jobs = makeRepository();
    const handler = createIdempotentJobProcessor<PdfJobPayload>({
      jobsForAccount: () => jobs.repository,
      handle: async () => {
        throw new Error('transient failure');
      },
      expectedJobType: 'PDF_GENERATE',
      maxReceiveCount: 3,
      staleAfterMs: 120_000,
      now: () => now,
    });
    const lastAttempt = {
      ...record,
      attributes: { ApproximateReceiveCount: '3' },
    } as SQSRecord;

    await expect(
      handler(
        { jobId, accountId, documentType: 'QUITTANCE', paymentId: 'payment-1' },
        lastAttempt,
      ),
    ).rejects.toThrow('transient failure');

    expect(jobs.markFailed).toHaveBeenCalledWith(jobId, now.toISOString(), {
      code: 'WORKER_RETRIES_EXHAUSTED',
      message: 'Processing failed after the permitted number of attempts.',
    });
    expect(jobs.markRetryable).not.toHaveBeenCalled();
  });

  it('connects the PDF SQS handler to job idempotency and partial batch failures', async () => {
    const jobs = makeRepository();
    const process = vi.fn(async () => {
      throw new Error('transient failure');
    });
    const handler = createPdfWorkerHandler({
      jobsForAccount: () => jobs.repository,
      processJob: process,
      now: () => now,
    });

    const response = await handler({
      Records: [record],
    } as SQSEvent);

    expect(process).toHaveBeenCalledOnce();
    expect(jobs.markRetryable).toHaveBeenCalledOnce();
    expect(response.batchItemFailures).toEqual([{ itemIdentifier: 'message-1' }]);
  });

  it('acknowledges a non-retryable worker error after recording the terminal job state', async () => {
    const jobs = makeRepository();
    const handler = createPdfWorkerHandler({
      jobsForAccount: () => jobs.repository,
      processJob: async () => {
        throw new NonRetryableWorkerError('INVALID_DOCUMENT', 'Document cannot be rendered.');
      },
      now: () => now,
    });

    const response = await handler({ Records: [record] } as SQSEvent);

    expect(jobs.markFailed).toHaveBeenCalledOnce();
    expect(response.batchItemFailures).toEqual([]);
  });
});
