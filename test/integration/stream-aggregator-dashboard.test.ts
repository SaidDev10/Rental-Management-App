import {
  CreateTableCommand,
  DeleteTableCommand,
  DynamoDBClient,
  waitUntilTableExists,
} from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
} from '@aws-sdk/lib-dynamodb';
import type { DynamoDBRecord } from 'aws-lambda';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { marshall } from '@aws-sdk/util-dynamodb';

import { createDashboardRepository } from '../../src/modules/dashboard/repository';
import { dashboardService } from '../../src/modules/dashboard/service';
import { pk, sk } from '../../src/shared/db/keys';
import {
  applySummaryDeltas,
  createStreamRecordProcessor,
} from '../../src/workers/processors/stream-aggregator';

const endpoint = process.env.DYNAMODB_ENDPOINT;
const endpointUrl = endpoint ? new URL(endpoint) : undefined;
const isLocalEndpoint =
  endpointUrl !== undefined &&
  endpointUrl.protocol === 'http:' &&
  ['localhost', '127.0.0.1', '[::1]'].includes(endpointUrl.hostname);

if (endpoint && !isLocalEndpoint) {
  throw new Error('Aggregation integration tests are restricted to a local HTTP DynamoDB endpoint.');
}

const localSuite = describe.skipIf(!isLocalEndpoint);
const accountId = `p5-t3-${randomUUID()}`;
const tableName = `rental-p5-t3-${randomUUID().replaceAll('-', '')}`;
const lowLevelClient = new DynamoDBClient({
  region: 'eu-west-1',
  endpoint: endpoint ?? 'http://127.0.0.1:8000',
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
});
const documentClient = DynamoDBDocumentClient.from(lowLevelClient, {
  marshallOptions: { removeUndefinedValues: true },
});
let tableCreated = false;
type StreamImage = NonNullable<NonNullable<DynamoDBRecord['dynamodb']>['NewImage']>;

const paymentImage = marshall({
  PK: pk.account(accountId),
  SK: 'PAYMENT#payment-replay',
  accountId,
  entityType: 'Payment',
  periodStart: '2026-10-10',
  amountPaid: 125_000,
  status: 'paid',
}) as StreamImage;

const replayedRecord: DynamoDBRecord = {
  eventID: 'p5-t3-replay-event',
  eventName: 'INSERT',
  dynamodb: {
    SequenceNumber: '1',
    NewImage: paymentImage,
  },
};

localSuite('DynamoDB Local stream replay and dashboard integration', () => {
  beforeAll(async () => {
    await lowLevelClient.send(
      new CreateTableCommand({
        TableName: tableName,
        BillingMode: 'PAY_PER_REQUEST',
        KeySchema: [
          { AttributeName: 'PK', KeyType: 'HASH' },
          { AttributeName: 'SK', KeyType: 'RANGE' },
        ],
        AttributeDefinitions: [
          { AttributeName: 'PK', AttributeType: 'S' },
          { AttributeName: 'SK', AttributeType: 'S' },
          { AttributeName: 'GSI2PK', AttributeType: 'S' },
          { AttributeName: 'GSI2SK', AttributeType: 'S' },
        ],
        GlobalSecondaryIndexes: [
          {
            IndexName: 'GSI2',
            KeySchema: [
              { AttributeName: 'GSI2PK', KeyType: 'HASH' },
              { AttributeName: 'GSI2SK', KeyType: 'RANGE' },
            ],
            Projection: { ProjectionType: 'ALL' },
          },
        ],
      }),
    );
    tableCreated = true;
    await waitUntilTableExists(
      { client: lowLevelClient, maxWaitTime: 30 },
      { TableName: tableName },
    );
  });

  afterAll(async () => {
    if (tableCreated) {
      await lowLevelClient.send(new DeleteTableCommand({ TableName: tableName }));
    }
    lowLevelClient.destroy();
  });

  it('replays a DynamoDB record without double-applying its summary delta, then reads it on the dashboard', async () => {
    const processRecord = createStreamRecordProcessor(
      tableName,
      applySummaryDeltas,
      documentClient,
    );

    await processRecord(replayedRecord);
    await processRecord(replayedRecord);

    const storedSummary = await documentClient.send(
      new GetCommand({
        TableName: tableName,
        Key: { PK: pk.account(accountId), SK: sk.summary('2026-10') },
        ConsistentRead: true,
      }),
    );
    const processedMarker = await documentClient.send(
      new GetCommand({
        TableName: tableName,
        Key: { PK: pk.account(accountId), SK: sk.processed('p5-t3-replay-event') },
        ConsistentRead: true,
      }),
    );

    expect(storedSummary.Item).toMatchObject({
      accountId,
      entityType: 'Summary',
      totalIncome: 125_000,
      paidPayments: 1,
      version: 1,
    });
    expect(processedMarker.Item).toMatchObject({
      accountId,
      entityType: 'ProcessedEvent',
      eventId: 'p5-t3-replay-event',
    });

    const repository = createDashboardRepository({
      accountId,
      client: documentClient,
      tableName,
    });
    const dashboard = await dashboardService.dashboard(
      accountId,
      new Date('2026-10-31T12:00:00.000Z'),
      repository,
    );

    expect(dashboard.currentMonth).toMatchObject({
      month: '2026-10',
      totalIncome: 125_000,
      paidPayments: 1,
    });
  });
});
