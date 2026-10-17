import type { DynamoDBRecord } from 'aws-lambda';

import { baseLogger } from '../shared/logger';
import { createConfiguredStreamRecordProcessor } from '../workers/processors/stream-aggregator';

type StreamEvent = {
  Records: DynamoDBRecord[];
};

type StreamResponse = {
  batchItemFailures: Array<{ itemIdentifier: string }>;
};

export const createStreamAggregatorHandler = (
  processRecord: (record: DynamoDBRecord) => Promise<void>,
) =>
  async (event: StreamEvent): Promise<StreamResponse> => {
    const batchItemFailures: Array<{ itemIdentifier: string }> = [];

    for (const record of event.Records) {
      const sequenceNumber = record.dynamodb?.SequenceNumber;

      if (!sequenceNumber) {
        baseLogger.error({ eventName: record.eventName }, 'DynamoDB stream record has no sequence number');

        throw new Error('DynamoDB stream record has no sequence number.');
      }

      try {
        await processRecord(record);
      } catch (error) {
        baseLogger.error(
          {
            errorType: error instanceof Error ? error.name : typeof error,
            sequenceNumber,
          },
          'Failed to process DynamoDB stream record',
        );
        batchItemFailures.push({ itemIdentifier: sequenceNumber });
      }
    }

    return { batchItemFailures };
  };

export const handler = createStreamAggregatorHandler(createConfiguredStreamRecordProcessor());

export default handler;
