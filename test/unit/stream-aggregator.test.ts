import type { DynamoDBRecord } from 'aws-lambda';
import { DynamoDBDocumentClient, GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { marshall } from '@aws-sdk/util-dynamodb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { pk, sk } from '../../src/shared/db/keys';
import {
  applySummaryDeltas,
  createStreamRecordProcessor,
  type SummaryDelta,
} from '../../src/workers/processors/stream-aggregator';

const dynamoMock = mockClient(DynamoDBDocumentClient);
type StreamImage = NonNullable<NonNullable<DynamoDBRecord['dynamodb']>['NewImage']>;

const paymentImage = (values: Record<string, unknown>): StreamImage => {
  return marshall({
    PK: pk.account('account-1'),
    SK: 'PAYMENT#payment-1',
    accountId: 'account-1',
    entityType: 'Payment',
    periodStart: '2025-01-10',
    amountPaid: 0,
    status: 'due',
    ...values,
  }) as StreamImage;
};

const record = (
  eventID: string,
  oldImage?: StreamImage,
  newImage?: StreamImage,
): DynamoDBRecord => ({
  eventID,
  eventName: 'MODIFY',
  dynamodb: {
    ...(oldImage === undefined ? {} : { OldImage: oldImage }),
    ...(newImage === undefined ? {} : { NewImage: newImage }),
  },
});

describe('stream summary aggregation', () => {
  beforeEach(() => {
    dynamoMock.reset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('atomically writes the dedupe marker and account-scoped summary update', async () => {
    dynamoMock.on(TransactWriteCommand).resolves({});

    await applySummaryDeltas(
      'account-1',
      'event-1',
      new Map([
        [
          '2025-01',
          {
            totalIncome: 2500,
            totalExpenses: 0,
            netYield: 0,
            occupiedProperties: 0,
            totalProperties: 0,
            latePayments: 0,
            paidPayments: 1,
            openTickets: 0,
          },
        ],
      ]),
      'rental-table',
    );

    const transaction = dynamoMock.commandCalls(TransactWriteCommand)[0]?.args[0].input;

    const items = transaction?.TransactItems ?? [];

    expect(items).toHaveLength(2);
    expect(items[0]?.Put?.Item).toMatchObject({
      PK: pk.account('account-1'),
      SK: sk.processed('event-1'),
      eventId: 'event-1',
    });
    expect(items[1]?.Update?.Key).toEqual({
      PK: pk.account('account-1'),
      SK: sk.summary('2025-01'),
    });
  });

  it('reverses the old month and applies a payment update to the new month', async () => {
    const observedDeltas: Map<string, SummaryDelta>[] = [];
    const apply = vi.fn(async (...args: Parameters<typeof applySummaryDeltas>) => {
      observedDeltas.push(args[2]);
    });
    const processRecord = createStreamRecordProcessor('rental-table', apply);

    await processRecord({
      ...record(
        'event-2',
        paymentImage({ periodStart: '2025-01-10', amountPaid: 100, status: 'late' }),
        paymentImage({ periodStart: '2025-02-10', amountPaid: 500, status: 'paid' }),
      ),
      eventName: 'MODIFY',
    });

    const monthDeltas = observedDeltas[0];

    expect(monthDeltas?.get('2025-01')).toMatchObject({
      totalIncome: -100,
      latePayments: -1,
    });
    expect(monthDeltas?.get('2025-02')).toMatchObject({
      totalIncome: 500,
      paidPayments: 1,
    });
  });

  it('does not retry an event whose dedupe marker already exists', async () => {
    const error = Object.assign(new Error('transaction cancelled'), {
      name: 'TransactionCanceledException',
    });
    const apply = vi.fn(async () => {
      throw error;
    });
    const processRecord = createStreamRecordProcessor('rental-table', apply);
    dynamoMock.on(GetCommand).resolves({
      Item: { PK: pk.account('account-1'), SK: sk.processed('event-3') },
    });

    await expect(
      processRecord({
        ...record('event-3', undefined, paymentImage({})),
        eventName: 'INSERT',
      }),
    ).resolves.toBeUndefined();
    expect(dynamoMock.commandCalls(GetCommand)[0]?.args[0].input.ConsistentRead).toBe(true);
  });

  it('does not apply the same event delta twice when a delivery is replayed', async () => {
    const processedEventIds = new Set<string>();
    let appliedIncome = 0;
    dynamoMock.on(TransactWriteCommand).callsFake(async ({ TransactItems }) => {
      const marker = TransactItems?.[0]?.Put?.Item;
      const eventId = String(marker?.eventId);

      if (processedEventIds.has(eventId)) {
        throw Object.assign(new Error('conditional transaction cancelled'), {
          name: 'TransactionCanceledException',
        });
      }

      processedEventIds.add(eventId);
      appliedIncome += Number(
        TransactItems?.[1]?.Update?.ExpressionAttributeValues?.[':totalIncome'] ?? 0,
      );

      return {};
    });
    dynamoMock.on(GetCommand).callsFake(async ({ Key }) => {
      const eventId = String(Key?.SK).replace('PROCESSED#', '');

      return processedEventIds.has(eventId)
        ? { Item: { PK: Key?.PK, SK: Key?.SK } }
        : {};
    });

    const processRecord = createStreamRecordProcessor('rental-table');
    const replay = {
      ...record('event-replayed', undefined, paymentImage({
        periodStart: '2025-01-10',
        amountPaid: 125,
        status: 'paid',
      })),
      eventName: 'INSERT' as const,
    };

    await processRecord(replay);
    await processRecord(replay);

    expect(dynamoMock.commandCalls(TransactWriteCommand)).toHaveLength(2);
    expect(processedEventIds).toEqual(new Set(['event-replayed']));
    expect(appliedIncome).toBe(125);
    expect(dynamoMock.commandCalls(GetCommand)).toHaveLength(1);
  });

  it('skips unrelated entities without writing an aggregation event', async () => {
    const apply = vi.fn(async () => undefined);
    const processRecord = createStreamRecordProcessor('rental-table', apply);

    await processRecord({
      ...record('event-4', undefined, marshall({
        PK: pk.account('account-1'),
        SK: 'JOB#job-1',
        accountId: 'account-1',
        entityType: 'Job',
      }) as StreamImage),
      eventName: 'INSERT',
    });

    expect(apply).not.toHaveBeenCalled();
  });
});
