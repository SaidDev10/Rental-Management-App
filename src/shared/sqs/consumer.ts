import type { SQSBatchResponse, SQSEvent, SQSRecord } from 'aws-lambda';
import { z } from 'zod';

import { baseLogger } from '../logger';

type ConsumerOptions<T> = {
  schema: z.ZodType<T>;
  concurrency?: number;
  handle: (payload: T, record: SQSRecord) => Promise<void>;
  shouldRetry?: (error: unknown) => boolean;
  workerName: string;
};

const parseBody = <T>(body: string, schema: z.ZodType<T>): T => {
  const json: unknown = JSON.parse(body);

  return schema.parse(json);
};

export const createConsumer = <T>({
  schema,
  concurrency = 4,
  handle,
  shouldRetry = () => true,
  workerName,
}: ConsumerOptions<T>) => {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error('SQS consumer concurrency must be a positive integer.');
  }

  return async (event: SQSEvent): Promise<SQSBatchResponse> => {
    const failedMessageIds = new Set<string>();
    let nextRecordIndex = 0;

    const processNext = async (): Promise<void> => {
      const index = nextRecordIndex;
      nextRecordIndex += 1;

      const record = event.Records[index];

      if (record === undefined) {
        return;
      }

      try {
        const payload = parseBody(record.body, schema);

        await handle(payload, record);
      } catch (error) {
        if (shouldRetry(error)) {
          failedMessageIds.add(record.messageId);
        }

        baseLogger.error(
          {
            errorType: error instanceof Error ? error.name : typeof error,
            messageId: record.messageId,
            workerName,
          },
          'Failed to process SQS message',
        );
      }

      await processNext();
    };

    const workerCount = Math.min(concurrency, event.Records.length);

    await Promise.all(Array.from({ length: workerCount }, () => processNext()));

    return {
      batchItemFailures: event.Records
        .filter((record) => failedMessageIds.has(record.messageId))
        .map((record) => ({ itemIdentifier: record.messageId })),
    };
  };
};
