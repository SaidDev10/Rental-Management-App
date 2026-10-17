import type { SQSRecord } from 'aws-lambda';

import { createConsumer } from '../shared/sqs';
import { pdfJobSchema, type PdfJobPayload } from '../workers/payloads';
import { createIdempotentJobProcessor, NonRetryableWorkerError } from '../workers/job-processor';
import type { JobCompletion, JobRepository } from '../workers/job-repository';
import { createWorkerJobRepository } from '../workers/repositories';
import { createPdfProcessor } from '../workers/processors/pdf';

type PdfWorkerOptions = {
  jobsForAccount?: (accountId: string) => JobRepository;
  processJob: (payload: PdfJobPayload, record: SQSRecord) => Promise<void | JobCompletion>;
  now?: () => Date;
};

export const createPdfWorkerHandler = ({ jobsForAccount, processJob, now }: PdfWorkerOptions) => {
  const handle = createIdempotentJobProcessor<PdfJobPayload>({
    jobsForAccount: jobsForAccount ?? createWorkerJobRepository,
    handle: processJob,
    expectedJobType: 'PDF_GENERATE',
    maxReceiveCount: 3,
    staleAfterMs: 120_000,
    ...(now === undefined ? {} : { now }),
  });

  return createConsumer({
    schema: pdfJobSchema,
    workerName: 'pdf-worker',
    concurrency: 4,
    handle,
    shouldRetry: (error) => !(error instanceof NonRetryableWorkerError),
  });
};

export const handler = createPdfWorkerHandler({
  processJob: createPdfProcessor(),
});

export default handler;
