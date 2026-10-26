import {
  BatchGetCommand,
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, describe, expect, it } from 'vitest';

import { createTenantRepository } from '../../src/modules/tenant/repository';

const clientMock = mockClient(DynamoDBDocumentClient);
const accountId = 'tenant-repository-account';
const tableName = 'tenant-repository-test';

afterEach(() => {
  clientMock.reset();
});

describe('tenant repository', () => {
  const repository = () =>
    createTenantRepository({
      accountId,
      client: clientMock as unknown as DynamoDBDocumentClient,
      tableName,
    });

  it('queries the sorted tenant directory through the account-scoped GSI1 key', async () => {
    clientMock.on(QueryCommand).resolves({
      Items: [{
        PK: `ACCOUNT#${accountId}`,
        SK: 'TENANT#tenant-1',
        accountId,
        entityType: 'Tenant',
        id: 'tenant-1',
        firstName: 'Sara',
        lastName: 'Amrani',
      }],
    });

    await expect(repository().list({ limit: 25 })).resolves.toMatchObject({
      items: [{ id: 'tenant-1' }],
    });

    expect(clientMock.commandCalls(QueryCommand)[0]?.args[0].input).toMatchObject({
      TableName: tableName,
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :gsi1pk AND begins_with(GSI1SK, :prefix)',
      ExpressionAttributeValues: {
        ':gsi1pk': `ACCOUNT#${accountId}#ACCOUNT#${accountId}`,
        ':prefix': 'TENANT#',
      },
      ConsistentRead: false,
    });
  });

  it('creates tenant and idempotency records atomically with account-scoped keys', async () => {
    clientMock.on(GetCommand).resolves({});
    clientMock.on(TransactWriteCommand).resolves({});

    const tenant = await repository().create({
      firstName: 'Sara',
      lastName: 'Amrani',
      email: 'sara@example.test',
      phone: '+212600000000',
      dateOfBirth: null,
      address: null,
    }, 'tenant-create');

    expect(tenant.PK).toBe(`ACCOUNT#${accountId}`);
    expect(tenant.GSI1PK).toBe(`ACCOUNT#${accountId}#ACCOUNT#${accountId}`);
    expect(tenant.GSI1SK).toContain('TENANT#amrani#sara#');
    const transaction = clientMock.commandCalls(TransactWriteCommand)[0]?.args[0].input;
    expect(transaction?.TransactItems).toHaveLength(2);
    expect(transaction?.TransactItems?.[0]?.Put?.Item).toMatchObject({
      entityType: 'Tenant',
      PK: `ACCOUNT#${accountId}`,
    });
  });

  it('resolves linked active leases using the account partition and batch-get access pattern', async () => {
    clientMock.on(QueryCommand).resolves({
      Items: [{
        entityType: 'TenantLeaseLink',
        accountId,
        tenantId: 'tenant-1',
        leaseId: 'lease-1',
      }],
    });
    let batchGetAttempts = 0;
    clientMock.on(BatchGetCommand).callsFake(async () => {
      batchGetAttempts += 1;
      if (batchGetAttempts === 1) {
        return {
          UnprocessedKeys: {
            [tableName]: { Keys: [{ PK: `ACCOUNT#${accountId}`, SK: 'LEASE#lease-1' }] },
          },
        };
      }

      return {
        Responses: {
          [tableName]: [{
            PK: `ACCOUNT#${accountId}`,
            SK: 'LEASE#lease-1',
            entityType: 'Lease',
            accountId,
            id: 'lease-1',
            propertyId: 'property-1',
            startDate: '2026-01-01',
            endDate: '2026-12-31',
            status: 'active',
          }],
        },
      };
    });

    await expect(repository().getLeases('tenant-1')).resolves.toEqual([{
      id: 'lease-1',
      propertyId: 'property-1',
      startDate: '2026-01-01',
      endDate: '2026-12-31',
      status: 'active',
    }]);
    expect(clientMock.commandCalls(QueryCommand)[0]?.args[0].input).toMatchObject({
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      ExpressionAttributeValues: {
        ':pk': `ACCOUNT#${accountId}`,
        ':prefix': 'LINK#TENANT#tenant-1#LEASE#',
      },
      ConsistentRead: true,
    });
    expect(clientMock.commandCalls(BatchGetCommand)).toHaveLength(2);
  });
});