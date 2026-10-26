import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, describe, expect, it } from 'vitest';

import { createLeaseRepository } from '../../src/modules/lease/repository';

const clientMock = mockClient(DynamoDBDocumentClient);
const accountId = 'lease-repository-account';
const tableName = 'lease-repository-test';

afterEach(() => clientMock.reset());

describe('lease repository', () => {
  const repository = () =>
    createLeaseRepository({
      accountId,
      client: clientMock as unknown as DynamoDBDocumentClient,
      tableName,
    });

  it('creates the lease and tenant link items in one conditional transaction', async () => {
    clientMock.on(TransactWriteCommand).resolves({});
    clientMock.on(PutCommand).resolves({});

    const lease = await repository().create({
      propertyId: 'property-1',
      tenantIds: ['tenant-1', 'tenant-2'],
      startDate: '2026-01-01',
      endDate: '2026-12-31',
      rentAmount: 700000,
      chargesAmount: 50000,
      depositAmount: 700000,
      paymentDayOfMonth: 5,
      billingFrequency: 'quarterly',
      indexation: { enabled: false },
      status: 'active',
    }, 'create-lease-1');

    const transaction = clientMock.commandCalls(TransactWriteCommand)[0]?.args[0].input;
    expect(lease.PK).toBe(`ACCOUNT#${accountId}`);
    expect(transaction?.TransactItems).toHaveLength(3);
    expect(transaction?.TransactItems?.[0]?.Put?.Item).toMatchObject({
      entityType: 'Lease',
      GSI1PK: `ACCOUNT#${accountId}#PROPERTY#property-1`,
    });
    expect(transaction?.TransactItems?.[1]?.Put?.Item).toMatchObject({
      entityType: 'TenantLeaseLink',
      tenantId: 'tenant-1',
    });
    expect(clientMock.commandCalls(PutCommand)).toHaveLength(4);
  });

  it('queries payment records by account-scoped lease GSI and paginates every page', async () => {
    clientMock.on(QueryCommand).resolvesOnce({
      Items: [],
      LastEvaluatedKey: { PK: `ACCOUNT#${accountId}`, SK: 'PAYMENT#first' },
    }).resolvesOnce({
      Items: [{
        PK: `ACCOUNT#${accountId}`,
        SK: 'PAYMENT#payment-1',
        accountId,
        entityType: 'Payment',
        leaseId: 'lease-1',
        id: 'payment-1',
        dueDate: '2026-01-05',
        status: 'due',
      }],
    });

    const payments = await repository().getPayments('lease-1');

    expect(payments).toHaveLength(1);
    expect(clientMock.commandCalls(QueryCommand)).toHaveLength(2);
    expect(clientMock.commandCalls(QueryCommand)[0]?.args[0].input).toMatchObject({
      IndexName: 'GSI1',
      ExpressionAttributeValues: {
        ':gsi1pk': `ACCOUNT#${accountId}#LEASE#lease-1`,
        ':prefix': 'PAYMENT#',
      },
    });
  });
});
