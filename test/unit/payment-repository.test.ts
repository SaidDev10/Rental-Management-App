import {
  BatchGetCommand,
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createPaymentRepository } from '../../src/modules/payment/repository';

const clientMock = mockClient(DynamoDBDocumentClient);
const accountId = 'payment-repository-account';
const tableName = 'payment-repository-test';
const previousUseDynamoAuth = process.env.USE_DYNAMO_AUTH;

beforeEach(() => {
  process.env.USE_DYNAMO_AUTH = 'true';
});

afterEach(() => clientMock.reset());
afterAll(() => {
  if (previousUseDynamoAuth === undefined) {
    delete process.env.USE_DYNAMO_AUTH;
  } else {
    process.env.USE_DYNAMO_AUTH = previousUseDynamoAuth;
  }
});

describe('payment repository', () => {
  const repository = (forAccount = accountId) =>
    createPaymentRepository({
      accountId: forAccount,
      client: clientMock as unknown as DynamoDBDocumentClient,
      tableName,
    });

  it('lists payments through the account partition and validates cursor ownership', async () => {
    clientMock.on(QueryCommand).resolves({
      Items: [{
        PK: `ACCOUNT#${accountId}`,
        SK: 'PAYMENT#payment-1',
        accountId,
        entityType: 'Payment',
        id: 'payment-1',
        leaseId: 'lease-1',
        status: 'due',
        dueDate: '2026-01-05',
      }],
    });

    const page = await repository().list({ limit: 25, status: 'due' });
    expect(page.items).toHaveLength(1);
    expect(clientMock.commandCalls(QueryCommand)[0]?.args[0].input).toMatchObject({
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      ExpressionAttributeValues: {
        ':pk': `ACCOUNT#${accountId}`,
        ':accountId': accountId,
        ':status': 'due',
      },
      ConsistentRead: true,
    });
    await expect(
      repository().list({ limit: 25, cursor: { PK: 'ACCOUNT#other', SK: 'PAYMENT#payment-1' } }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('updates paid amount and the status index with optimistic concurrency', async () => {
    clientMock.on(GetCommand).resolves({
      Item: {
        PK: `ACCOUNT#${accountId}`,
        SK: 'PAYMENT#payment-1',
        accountId,
        entityType: 'Payment',
        id: 'payment-1',
        leaseId: 'lease-1',
        amountDue: 100000,
        amountPaid: 0,
        status: 'due',
        version: 1,
      },
    });
    clientMock.on(UpdateCommand).resolves({
      Attributes: {
        PK: `ACCOUNT#${accountId}`,
        SK: 'PAYMENT#payment-1',
        accountId,
        entityType: 'Payment',
        id: 'payment-1',
        leaseId: 'lease-1',
        amountDue: 100000,
        amountPaid: 25000,
        status: 'partial',
        version: 2,
      },
    });

    await repository().recordPaid(
      'payment-1',
      1,
      { amountPaid: 25000, paidAt: '2026-01-05T12:00:00.000Z', paymentMethod: 'cash' },
      'partial',
    );
    expect(clientMock.commandCalls(UpdateCommand)[0]?.args[0].input).toMatchObject({
      ConditionExpression: expect.stringContaining('#version = :expectedVersion'),
      ExpressionAttributeValues: {
        ':gsi2pk': `ACCOUNT#${accountId}#STATUS#partial`,
        ':nextStatus': 'partial',
        ':amountPaid': 25000,
      },
    });
  });

  it('queries overdue records through the account status index and rejects cross-account reads', async () => {
    clientMock.on(BatchGetCommand).resolves({ Responses: { [tableName]: [] } });
    clientMock.on(QueryCommand).resolves({
      Items: [{ PK: `ACCOUNT#${accountId}`, SK: 'PAYMENT#payment-1' }],
    });
    const repo = repository();
    const overdue = await repo.listOverdue('2026-10-01');

    expect(clientMock.commandCalls(QueryCommand)).toHaveLength(2);
    expect(clientMock.commandCalls(QueryCommand)[0]?.args[0].input).toMatchObject({
      IndexName: 'GSI2',
      ExpressionAttributeValues: {
        ':statusPk': `ACCOUNT#${accountId}#STATUS#late`,
        ':today': '2026-10-01',
      },
    });
    expect(overdue).toHaveLength(0);

    clientMock.on(GetCommand).resolves({
      Item: {
        PK: `ACCOUNT#${accountId}`,
        SK: 'PAYMENT#payment-1',
        accountId,
        entityType: 'Payment',
      },
    });
    await expect(repository('another-account').getById('payment-1')).rejects.toThrow(
      'DynamoDB payment does not belong to the repository account.',
    );
  });

  it('marks past-due records late with a conditional status and version update', async () => {
    clientMock.on(QueryCommand).resolvesOnce({
      Items: [{ PK: `ACCOUNT#${accountId}`, SK: 'PAYMENT#payment-1' }],
    }).resolvesOnce({ Items: [] });
    clientMock.on(BatchGetCommand).resolves({
      Responses: {
        [tableName]: [{
          PK: `ACCOUNT#${accountId}`,
          SK: 'PAYMENT#payment-1',
          accountId,
          entityType: 'Payment',
          id: 'payment-1',
          status: 'due',
          version: 1,
        }],
      },
    });
    clientMock.on(UpdateCommand).resolves({});

    await expect(repository().markOverdue('2026-10-01')).resolves.toBe(1);
    expect(clientMock.commandCalls(UpdateCommand)[0]?.args[0].input).toMatchObject({
      ConditionExpression: expect.stringContaining('#version = :version'),
      ExpressionAttributeValues: {
        ':expectedStatus': 'due',
        ':late': 'late',
        ':gsi2pk': `ACCOUNT#${accountId}#STATUS#late`,
      },
    });
  });
});
