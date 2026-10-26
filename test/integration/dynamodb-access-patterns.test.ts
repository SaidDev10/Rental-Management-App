import {
  BatchGetCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  CreateTableCommand,
  DeleteTableCommand,
  DynamoDBClient as LowLevelDynamoDBClient,
  waitUntilTableExists,
} from '@aws-sdk/client-dynamodb';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPaymentRepository } from '../../src/modules/payment/repository';

const endpoint = process.env.DYNAMODB_ENDPOINT;
const endpointUrl = endpoint ? new URL(endpoint) : undefined;
const isLocalEndpoint =
  endpointUrl !== undefined &&
  ['localhost', '127.0.0.1', '[::1]'].includes(endpointUrl.hostname);
const integrationSuite = describe.skipIf(!isLocalEndpoint);
const accountId = `integration-${randomUUID()}`;
const accountPk = `ACCOUNT#${accountId}`;
const tableName = `rental-app-integration-${randomUUID().replaceAll('-', '')}`;
let tableCreated = false;
const lowLevelClient = new LowLevelDynamoDBClient({
  region: 'eu-west-1',
  endpoint: endpoint ?? 'http://127.0.0.1:8000',
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
});
const client = DynamoDBDocumentClient.from(lowLevelClient);

const accountItem = (SK: string, extra: Record<string, unknown> = {}) => ({
  PK: accountPk,
  SK,
  accountId,
  ...extra,
});

const query = async (
  keyConditionExpression: string,
  expressionAttributeValues: Record<string, string>,
  options: {
    indexName?: string;
    expressionAttributeNames?: Record<string, string>;
    projectionExpression?: string;
  } = {},
) =>
  client.send(
    new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: keyConditionExpression,
      ExpressionAttributeValues: expressionAttributeValues,
      ...(options.indexName ? { IndexName: options.indexName } : {}),
      ...(options.expressionAttributeNames
        ? { ExpressionAttributeNames: options.expressionAttributeNames }
        : {}),
      ...(options.projectionExpression ? { ProjectionExpression: options.projectionExpression } : {}),
    }),
  );

const queryGsiAndLoadItems = async (
  indexName: 'GSI1' | 'GSI2',
  partitionName: 'GSI1PK' | 'GSI2PK',
  partitionValue: string,
  sortPrefix?: string,
) => {
  const result = await query(
    sortPrefix
      ? '#partition = :partition AND begins_with(#sort, :sortPrefix)'
      : '#partition = :partition',
    {
      ':partition': partitionValue,
      ...(sortPrefix ? { ':sortPrefix': sortPrefix } : {}),
    },
    {
      indexName,
      expressionAttributeNames: {
        '#partition': partitionName,
        ...(sortPrefix ? { '#sort': indexName === 'GSI1' ? 'GSI1SK' : 'GSI2SK' } : {}),
      },
    },
  );
  const keys = (result.Items ?? []).map(({ PK, SK }) => ({ PK, SK }));

  if (keys.length === 0) {
    return [];
  }

  const loaded = await client.send(
    new BatchGetCommand({
      RequestItems: {
        [tableName]: { Keys: keys },
      },
    }),
  );

  return loaded.Responses?.[tableName] ?? [];
};

integrationSuite('DynamoDB Local access patterns', () => {
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
          { AttributeName: 'GSI1PK', AttributeType: 'S' },
          { AttributeName: 'GSI1SK', AttributeType: 'S' },
          { AttributeName: 'GSI2PK', AttributeType: 'S' },
          { AttributeName: 'GSI2SK', AttributeType: 'S' },
        ],
        GlobalSecondaryIndexes: [
          {
            IndexName: 'GSI1',
            KeySchema: [
              { AttributeName: 'GSI1PK', KeyType: 'HASH' },
              { AttributeName: 'GSI1SK', KeyType: 'RANGE' },
            ],
            Projection: { ProjectionType: 'ALL' },
          },
          {
            IndexName: 'GSI2',
            KeySchema: [
              { AttributeName: 'GSI2PK', KeyType: 'HASH' },
              { AttributeName: 'GSI2SK', KeyType: 'RANGE' },
            ],
            Projection: { ProjectionType: 'KEYS_ONLY' },
          },
        ],
      }),
    );
    tableCreated = true;
    await waitUntilTableExists(
      { client: lowLevelClient, maxWaitTime: 30 },
      { TableName: tableName },
    );

    const tenantDirectoryPk = `${accountPk}#ACCOUNT#${accountId}`;
    const propertyPk = `${accountPk}#PROPERTY#property-1`;
    const leasePk = `${accountPk}#LEASE#lease-1`;
    const lateStatusPk = `${accountPk}#STATUS#late`;
    const dueStatusPk = `${accountPk}#STATUS#due`;
    const openStatusPk = `${accountPk}#STATUS#open`;
    const queuedStatusPk = `${accountPk}#STATUS#queued`;
    const items = [
      accountItem('META', { entityType: 'Account', name: 'Integration account' }),
      accountItem('PROPERTY#property-1', { entityType: 'Property' }),
      accountItem('PROPERTY#property-2', { entityType: 'Property' }),
      accountItem('TENANT#tenant-1', {
        entityType: 'Tenant',
        GSI1PK: tenantDirectoryPk,
        GSI1SK: 'TENANT#doe#jane#tenant-1',
      }),
      accountItem('TENANT#tenant-2', {
        entityType: 'Tenant',
        GSI1PK: tenantDirectoryPk,
        GSI1SK: 'TENANT#smith#john#tenant-2',
      }),
      accountItem('LEASE#lease-1', {
        entityType: 'Lease',
        GSI1PK: propertyPk,
        GSI1SK: 'LEASE#2026-01-01#lease-1',
      }),
      accountItem('LEASE#lease-2', {
        entityType: 'Lease',
        GSI1PK: propertyPk,
        GSI1SK: 'LEASE#2026-02-01#lease-2',
      }),
      accountItem('PAYMENT#payment-late', {
        entityType: 'Payment',
        id: 'payment-late',
        leaseId: 'lease-1',
        propertyId: 'property-1',
        tenantId: 'tenant-1',
        status: 'late',
        amountDue: 100000,
        amountPaid: 0,
        version: 1,
        GSI1PK: leasePk,
        GSI1SK: 'PAYMENT#2026-01-01#payment-late',
        GSI2PK: lateStatusPk,
        GSI2SK: '2026-01-01#payment-late',
      }),
      accountItem('PAYMENT#payment-due', {
        entityType: 'Payment',
        id: 'payment-due',
        leaseId: 'lease-1',
        propertyId: 'property-1',
        tenantId: 'tenant-1',
        status: 'due',
        amountDue: 100000,
        amountPaid: 0,
        version: 1,
        GSI1PK: leasePk,
        GSI1SK: 'PAYMENT#2026-02-01#payment-due',
        GSI2PK: dueStatusPk,
        GSI2SK: '2026-02-01#payment-due',
      }),
      accountItem('DOC#document-1', {
        entityType: 'Document',
        GSI1PK: leasePk,
        GSI1SK: 'DOC#lease#2026-01-01#document-1',
      }),
      accountItem('TICKET#ticket-1', {
        entityType: 'MaintenanceTicket',
        GSI2PK: openStatusPk,
        GSI2SK: 'medium#2026-01-01#ticket-1',
      }),
      accountItem('SUMMARY#2026-01', { entityType: 'Summary', totalIncome: 100 }),
      accountItem('COUNTER#quittance', { entityType: 'Counter', nextNumber: 0 }),
      {
        PK: 'SYSTEM',
        SK: 'EMAIL#owner@example.test',
        entityType: 'EmailDirectory',
        accountId,
        userId: 'user-1',
      },
      accountItem('USER#user-1', { entityType: 'User', email: 'owner@example.test' }),
      accountItem('LINK#TENANT#tenant-1#LEASE#lease-1', {
        entityType: 'TenantLeaseLink',
        leaseId: 'lease-1',
      }),
      accountItem('JOB#job-1', {
        entityType: 'Job',
        GSI2PK: queuedStatusPk,
        GSI2SK: '2026-01-01#job-1',
      }),
    ];

    for (const item of items) {
      await client.send(new PutCommand({ TableName: tableName, Item: item }));
    }
  });

  afterAll(async () => {
    if (tableCreated) {
      await lowLevelClient.send(new DeleteTableCommand({ TableName: tableName }));
    }
    client.destroy();
  });

  it('supports all 17 specified table and index access patterns', async () => {
    const account = await client.send(
      new GetCommand({ TableName: tableName, Key: { PK: accountPk, SK: 'META' } }),
    );
    expect(account.Item?.entityType).toBe('Account');

    const properties = await query('PK = :pk AND begins_with(SK, :prefix)', {
      ':pk': accountPk,
      ':prefix': 'PROPERTY#',
    });
    expect(properties.Items).toHaveLength(2);

    const tenants = await query(
      'GSI1PK = :partition AND begins_with(GSI1SK, :prefix)',
      { ':partition': `${accountPk}#ACCOUNT#${accountId}`, ':prefix': 'TENANT#' },
      { indexName: 'GSI1' },
    );
    expect(tenants.Items?.map((item) => item.SK)).toEqual(['TENANT#tenant-1', 'TENANT#tenant-2']);

    const leases = await query('PK = :pk AND begins_with(SK, :prefix)', {
      ':pk': accountPk,
      ':prefix': 'LEASE#',
    });
    expect(leases.Items).toHaveLength(2);

    const payments = await query('PK = :pk AND begins_with(SK, :prefix)', {
      ':pk': accountPk,
      ':prefix': 'PAYMENT#',
    });
    expect(payments.Items).toHaveLength(2);

    const propertyLeases = await query('GSI1PK = :partition', { ':partition': `${accountPk}#PROPERTY#property-1` }, { indexName: 'GSI1' });
    expect(propertyLeases.Items).toHaveLength(2);

    const leasePayments = await query(
      'GSI1PK = :partition AND begins_with(GSI1SK, :prefix)',
      { ':partition': `${accountPk}#LEASE#lease-1`, ':prefix': 'PAYMENT#' },
      { indexName: 'GSI1' },
    );
    expect(leasePayments.Items).toHaveLength(2);

    const leaseDocuments = await query(
      'GSI1PK = :partition AND begins_with(GSI1SK, :prefix)',
      { ':partition': `${accountPk}#LEASE#lease-1`, ':prefix': 'DOC#' },
      { indexName: 'GSI1' },
    );
    expect(leaseDocuments.Items).toHaveLength(1);

    const latePayments = await queryGsiAndLoadItems('GSI2', 'GSI2PK', `${accountPk}#STATUS#late`);
    expect(latePayments.map((item) => item.SK)).toEqual(['PAYMENT#payment-late']);

    const duePayments = await queryGsiAndLoadItems('GSI2', 'GSI2PK', `${accountPk}#STATUS#due`);
    expect(duePayments.map((item) => item.SK)).toEqual(['PAYMENT#payment-due']);

    const openTickets = await queryGsiAndLoadItems('GSI2', 'GSI2PK', `${accountPk}#STATUS#open`);
    expect(openTickets.map((item) => item.SK)).toEqual(['TICKET#ticket-1']);

    const summary = await client.send(
      new GetCommand({ TableName: tableName, Key: { PK: accountPk, SK: 'SUMMARY#2026-01' } }),
    );
    expect(summary.Item?.totalIncome).toBe(100);

    const counter = await client.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { PK: accountPk, SK: 'COUNTER#quittance' },
        UpdateExpression: 'ADD nextNumber :one',
        ExpressionAttributeValues: { ':one': 1 },
        ReturnValues: 'ALL_NEW',
      }),
    );
    expect(counter.Attributes?.nextNumber).toBe(1);

    const email = await client.send(
      new GetCommand({
        TableName: tableName,
        Key: { PK: 'SYSTEM', SK: 'EMAIL#owner@example.test' },
      }),
    );
    expect(email.Item?.userId).toBe('user-1');
    const user = await client.send(
      new GetCommand({
        TableName: tableName,
        Key: { PK: accountPk, SK: 'USER#user-1' },
      }),
    );
    expect(user.Item?.email).toBe('owner@example.test');

    await client.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: tableName,
              Item: {
                PK: 'SYSTEM',
                SK: 'EMAIL#new-owner@example.test',
                entityType: 'EmailDirectory',
                accountId,
                userId: 'user-2',
              },
              ConditionExpression: 'attribute_not_exists(PK)',
            },
          },
        ],
      }),
    );
    await expect(
      client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: tableName,
                Item: {
                  PK: 'SYSTEM',
                  SK: 'EMAIL#new-owner@example.test',
                  entityType: 'EmailDirectory',
                  accountId,
                  userId: 'user-3',
                },
                ConditionExpression: 'attribute_not_exists(PK)',
              },
            },
          ],
        }),
      ),
    ).rejects.toThrow();

    const tenantLinks = await query('PK = :pk AND begins_with(SK, :prefix)', {
      ':pk': accountPk,
      ':prefix': 'LINK#TENANT#tenant-1#LEASE#',
    });
    const linkedLeases = await client.send(
      new BatchGetCommand({
        RequestItems: {
          [tableName]: {
            Keys: (tenantLinks.Items ?? []).map(({ leaseId }) => ({
              PK: accountPk,
              SK: `LEASE#${leaseId}`,
            })),
          },
        },
      }),
    );
    expect(linkedLeases.Responses?.[tableName]?.map((item) => item.SK)).toEqual([
      'LEASE#lease-1',
    ]);

    const queuedJobs = await queryGsiAndLoadItems(
      'GSI2',
      'GSI2PK',
      `${accountPk}#STATUS#queued`,
    );
    expect(queuedJobs.map((item) => item.SK)).toEqual(['JOB#job-1']);
  });

  it('conditionally records and cancels a payment while updating its status index', async () => {
    const previousUseDynamoAuth = process.env.USE_DYNAMO_AUTH;
    process.env.USE_DYNAMO_AUTH = 'true';
    try {
      const repository = createPaymentRepository({
        accountId,
        client,
        tableName,
      });
      const partial = await repository.recordPaid(
        'payment-due',
        1,
        {
          amountPaid: 25000,
          paidAt: '2026-02-01T12:00:00.000Z',
          paymentMethod: 'bank_transfer',
        },
        'partial',
      );
      expect(partial).toMatchObject({ status: 'partial', amountPaid: 25000, version: 2 });
      expect(partial.GSI2PK).toBe(`${accountPk}#STATUS#partial`);

      const cancelled = await repository.cancel('payment-due', partial.version);
      expect(cancelled).toMatchObject({ status: 'cancelled', version: 3 });
      expect(cancelled.GSI2PK).toBe(`${accountPk}#STATUS#cancelled`);

      const stored = await client.send(
        new GetCommand({
          TableName: tableName,
          Key: { PK: accountPk, SK: 'PAYMENT#payment-due' },
          ConsistentRead: true,
        }),
      );
      expect(stored.Item).toMatchObject({
        status: 'cancelled',
        amountPaid: 25000,
        GSI2PK: `${accountPk}#STATUS#cancelled`,
        version: 3,
      });
    } finally {
      if (previousUseDynamoAuth === undefined) {
        delete process.env.USE_DYNAMO_AUTH;
      } else {
        process.env.USE_DYNAMO_AUTH = previousUseDynamoAuth;
      }
    }
  });
});
