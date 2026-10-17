import type { SQSRecord } from 'aws-lambda';

import { createConsumer } from '../shared/sqs';
import { notificationJobSchema, type NotificationJobPayload } from '../workers/payloads';
import { createIdempotentJobProcessor, NonRetryableWorkerError } from '../workers/job-processor';
import type { JobRepository } from '../workers/job-repository';
import { createWorkerJobRepository } from '../workers/repositories';
import { createNotificationProcessor } from '../workers/processors/notification';
import { readNotificationWorkerConfig } from '../shared/config';
import { getSecret } from '../shared/config/secrets';

type NotificationWorkerOptions = {
  jobsForAccount?: (accountId: string) => JobRepository;
  processJob: (payload: NotificationJobPayload, record: SQSRecord) => Promise<void>;
  now?: () => Date;
};

export const createNotificationWorkerHandler = ({
  jobsForAccount,
  processJob,
  now,
}: NotificationWorkerOptions) => {
  const handle = createIdempotentJobProcessor<NotificationJobPayload>({
    jobsForAccount: jobsForAccount ?? createWorkerJobRepository,
    handle: processJob,
    expectedJobType: 'NOTIFY',
    maxReceiveCount: 3,
    staleAfterMs: 60_000,
    ...(now === undefined ? {} : { now }),
  });

  return createConsumer({
    schema: notificationJobSchema,
    workerName: 'notification-worker',
    concurrency: 4,
    handle,
    shouldRetry: (error) => !(error instanceof NonRetryableWorkerError),
  });
};

const config = readNotificationWorkerConfig();
const secretPrefix = config.SSM_PARAM_PREFIX;

await Promise.all([
  getSecret(`${secretPrefix}/twilio/account-sid`),
  getSecret(`${secretPrefix}/twilio/auth-token`),
  getSecret(`${secretPrefix}/twilio/whatsapp-from`),
]);

export const handler = createNotificationWorkerHandler({
  processJob: createNotificationProcessor(),
});

export default handler;
