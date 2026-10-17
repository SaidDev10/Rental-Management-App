import type { SQSEvent, SQSRecord, DynamoDBRecord } from 'aws-lambda';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { createConsumer } from '../../src/shared/sqs';
import { createStreamAggregatorHandler } from '../../src/lambdas/stream-aggregator';

const record = (messageId: string, body: string): SQSRecord =>
  ({
    messageId,
    body,
  }) as SQSRecord;

describe('SQS consumer', () => {
  it('reports only invalid and failed records for partial batch retry', async () => {
    const handle = vi.fn(async (payload: { jobId: string }) => {
      if (payload.jobId === 'fail') {
        throw new Error('processing failed');
      }
    });
    const handler = createConsumer({
      schema: z.object({ jobId: z.string() }),
      workerName: 'test-worker',
      concurrency: 2,
      handle,
    });

    const response = await handler({
      Records: [
        record('succeeded', JSON.stringify({ jobId: 'ok' })),
        record('failed', JSON.stringify({ jobId: 'fail' })),
        record('malformed', '{'),
      ],
    } as SQSEvent);

    expect(response.batchItemFailures).toEqual([
      { itemIdentifier: 'failed' },
      { itemIdentifier: 'malformed' },
    ]);
    expect(handle).toHaveBeenCalledTimes(2);
  });

  it('rejects a non-positive worker concurrency setting', () => {
    expect(() =>
      createConsumer({
        schema: z.string(),
        workerName: 'test-worker',
        concurrency: 0,
        handle: async () => undefined,
      }),
    ).toThrow(/positive integer/);
  });
});

describe('DynamoDB stream consumer', () => {
  it('returns failed sequence numbers for retry', async () => {
    const processRecord = vi.fn(async (input: DynamoDBRecord) => {
      if (input.dynamodb?.SequenceNumber === '2') {
        throw new Error('processing failed');
      }
    });
    const handler = createStreamAggregatorHandler(processRecord);
    const response = await handler({
      Records: [
        { dynamodb: { SequenceNumber: '1' } },
        { dynamodb: { SequenceNumber: '2' } },
      ] as DynamoDBRecord[],
    });

    expect(response.batchItemFailures).toEqual([{ itemIdentifier: '2' }]);
    expect(processRecord).toHaveBeenCalledTimes(2);
  });

  it('throws when a stream record cannot be retried by sequence number', async () => {
    const handler = createStreamAggregatorHandler(async () => undefined);

    await expect(handler({ Records: [{ eventName: 'INSERT' }] as DynamoDBRecord[] })).rejects.toThrow(
      /no sequence number/,
    );
  });
});
