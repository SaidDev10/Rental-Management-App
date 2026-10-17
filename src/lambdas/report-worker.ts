import type { SQSRecord } from 'aws-lambda';

import { createConsumer } from '../shared/sqs';
import { reportJobSchema, type ReportJobPayload } from '../workers/payloads';
import { createIdempotentJobProcessor, NonRetryableWorkerError } from '../workers/job-processor';
import type { JobCompletion, JobRepository } from '../workers/job-repository';
import { createWorkerJobRepository } from '../workers/repositories';
import { createReportProcessor } from '../workers/processors/report';

type ReportWorkerOptions = {
  jobsForAccount?: (accountId: string) => JobRepository;
  processJob: (payload: ReportJobPayload, record: SQSRecord) => Promise<void | JobCompletion>;
  now?: () => Date;
};

export const createReportWorkerHandler = ({ jobsForAccount, processJob, now }: ReportWorkerOptions) => {
  const handle = createIdempotentJobProcessor<ReportJobPayload>({
    jobsForAccount: jobsForAccount ?? createWorkerJobRepository,
    handle: processJob,
    expectedJobType: 'REPORT_EXPORT',
    maxReceiveCount: 3,
    staleAfterMs: 240_000,
    ...(now === undefined ? {} : { now }),
  });

  return createConsumer({
    schema: reportJobSchema,
    workerName: 'report-worker',
    concurrency: 2,
    handle,
    shouldRetry: (error) => !(error instanceof NonRetryableWorkerError),
  });
};

export const handler = createReportWorkerHandler({
  processJob: createReportProcessor(),
});

export default handler;
