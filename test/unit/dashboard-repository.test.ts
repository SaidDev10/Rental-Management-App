import {
  BatchGetCommand,
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  ScanCommand,
} from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDashboardRepository } from '../../src/modules/dashboard/repository';

const clientMock = mockClient(DynamoDBDocumentClient);
const accountId = 'dashboard-repository-account';
const tableName = 'dashboard-repository-test';

beforeEach(() => {
  clientMock.reset();
});

afterEach(() => clientMock.reset());

const repository = () =>
  createDashboardRepository({
    accountId,
    client: clientMock as unknown as DynamoDBDocumentClient,
    tableName,
  });

describe('dashboard repository', () => {
  it('reads one account-scoped monthly SUMMARY item without a query or scan', async () => {
    clientMock.on(GetCommand).resolves({
      Item: {
        PK: `ACCOUNT#${accountId}`,
        SK: 'SUMMARY#2026-10',
        accountId,
        totalIncome: 30000,
        totalExpenses: 5000,
        openTickets: 2,
      },
    });

    await expect(repository().getSummary('2026-10')).resolves.toMatchObject({
      month: '2026-10',
      totalIncome: 30000,
      totalExpenses: 5000,
      openTickets: 2,
      netYield: 0,
    });
    expect(clientMock.commandCalls(GetCommand)[0]?.args[0].input).toMatchObject({
      Key: { PK: `ACCOUNT#${accountId}`, SK: 'SUMMARY#2026-10' },
      ConsistentRead: true,
    });
    expect(clientMock.commandCalls(QueryCommand)).toHaveLength(0);
    expect(clientMock.commandCalls(ScanCommand)).toHaveLength(0);
  });

  it('loads reports exclusively with account-scoped SUMMARY GetItem requests', async () => {
    clientMock.on(GetCommand).callsFake(async ({ Key }) => ({
      Item: {
        PK: `ACCOUNT#${accountId}`,
        SK: Key?.SK,
        accountId,
        totalIncome: 100,
      },
    }));

    await expect(repository().getSummaries(['2026-01', '2026-02'])).resolves.toMatchObject([
      { month: '2026-01', totalIncome: 100 },
      { month: '2026-02', totalIncome: 100 },
    ]);
    expect(clientMock.commandCalls(GetCommand)).toHaveLength(2);
    expect(clientMock.commandCalls(QueryCommand)).toHaveLength(0);
    expect(clientMock.commandCalls(ScanCommand)).toHaveLength(0);
  });

  it('gets due and partial payments from the account status index within 30 days', async () => {
    clientMock.on(QueryCommand).callsFake(async (input) => ({
      Items: [{
        PK: `ACCOUNT#${accountId}`,
        SK: input.ExpressionAttributeValues?.[':statusPk'] === `ACCOUNT#${accountId}#STATUS#due`
          ? 'PAYMENT#due-1'
          : 'PAYMENT#partial-1',
      }],
    }));
    clientMock.on(BatchGetCommand).resolves({
      Responses: {
        [tableName]: [
          {
            PK: `ACCOUNT#${accountId}`,
            SK: 'PAYMENT#due-1',
            accountId,
            entityType: 'Payment',
            id: 'due-1',
            dueDate: '2026-11-02',
            status: 'due',
          },
          {
            PK: `ACCOUNT#${accountId}`,
            SK: 'PAYMENT#partial-1',
            accountId,
            entityType: 'Payment',
            id: 'partial-1',
            dueDate: '2026-11-04',
            status: 'partial',
          },
        ],
      },
    });

    const result = await repository().listDueNext30Days(10, '2026-10-31');
    expect(result.map((payment) => payment.id)).toEqual(['due-1', 'partial-1']);
    expect(result[0]).not.toHaveProperty('PK');
    expect(result[0]).not.toHaveProperty('GSI2PK');
    expect(clientMock.commandCalls(QueryCommand)).toHaveLength(2);
    expect(clientMock.commandCalls(QueryCommand)[0]?.args[0].input).toMatchObject({
      IndexName: 'GSI2',
      KeyConditionExpression: 'GSI2PK = :statusPk AND GSI2SK BETWEEN :from AND :to',
      ExpressionAttributeValues: {
        ':from': '2026-10-31#',
        ':to': `2026-11-30#\uffff`,
      },
    });
    expect(clientMock.commandCalls(BatchGetCommand)).toHaveLength(1);
    expect(clientMock.commandCalls(ScanCommand)).toHaveLength(0);
  });

  it('counts open and in-progress tickets with status-index queries only', async () => {
    clientMock.on(QueryCommand).resolves({ Count: 3 });

    await expect(repository().countOpenTickets()).resolves.toBe(6);
    expect(clientMock.commandCalls(QueryCommand)).toHaveLength(2);
    expect(clientMock.commandCalls(QueryCommand).map(({ args }) =>
      args[0].input.ExpressionAttributeValues?.[':statusPk'],
    )).toEqual([
      `ACCOUNT#${accountId}#STATUS#open`,
      `ACCOUNT#${accountId}#STATUS#in_progress`,
    ]);
    expect(clientMock.commandCalls(ScanCommand)).toHaveLength(0);
  });
});
