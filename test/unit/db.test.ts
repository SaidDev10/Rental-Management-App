import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, describe, expect, it } from 'vitest';

import { gsi1, gsi2, pk, sk } from '../../src/shared/db/keys';
import { createScopedRepository } from '../../src/shared/db/scoped-repository';

const clientMock = mockClient(DynamoDBDocumentClient);
const accountId = '01JEXAMPLEACCOUNT00000000001';
const tableName = 'rental-app-main';

afterEach(() => {
  clientMock.reset();
});

describe('DynamoDB key builders', () => {
  it('builds account-scoped partition and GSI keys', () => {
    expect(pk.account(accountId)).toBe(`ACCOUNT#${accountId}`);
    expect(gsi1.property(accountId, 'property-id')).toBe(
      `ACCOUNT#${accountId}#PROPERTY#property-id`,
    );
    expect(gsi2.status(accountId, 'active')).toBe(`ACCOUNT#${accountId}#STATUS#active`);
    expect(gsi2.email(accountId, 'OWNER@EXAMPLE.COM')).toBe(
      `ACCOUNT#${accountId}#EMAIL#owner@example.com`,
    );
    expect(sk.property('property-id')).toBe('PROPERTY#property-id');
  });

  it('rejects unvalidated key parts', () => {
    expect(() => pk.account('')).toThrow();
    expect(() => sk.property('one#two')).toThrow();
  });
});

describe('account-scoped repository', () => {
  const repository = () =>
    createScopedRepository<{ PK: string; SK: string; accountId: string; [key: string]: unknown }>({
      accountId,
      client: clientMock as unknown as DynamoDBDocumentClient,
      tableName,
    });

  it('always scopes point reads to its account partition', async () => {
    clientMock.on(GetCommand).resolves({ Item: undefined });

    await repository().get(sk.property('property-id'));

    const command = clientMock.commandCalls(GetCommand)[0]?.args[0];
    expect(command?.input.Key).toEqual({
      PK: `ACCOUNT#${accountId}`,
      SK: 'PROPERTY#property-id',
    });
    expect(command?.input.ConsistentRead).toBe(true);
  });

  it('rejects data that is inconsistent with the account partition', async () => {
    clientMock.on(GetCommand).resolves({
      Item: {
        PK: `ACCOUNT#${accountId}`,
        SK: 'PROPERTY#property-id',
        accountId: 'another-account',
      },
    });

    await expect(repository().get(sk.property('property-id'))).rejects.toThrow(
      /belong to the repository account/,
    );
  });

  it('rejects writes that escape the account partition or GSIs', async () => {
    const repo = repository();

    await expect(
      repo.put({
        PK: 'ACCOUNT#another-account',
        SK: 'PROPERTY#property-id',
        accountId,
      }),
    ).rejects.toThrow(/belong to the repository account/);
    await expect(
      repo.put({
        PK: `ACCOUNT#${accountId}`,
        SK: 'PROPERTY#property-id',
        accountId,
        GSI2PK: 'ACCOUNT#another-account#STATUS#active',
      }),
    ).rejects.toThrow(/belong to the repository account/);

    expect(clientMock.commandCalls(PutCommand)).toHaveLength(0);
  });

  it('queries a status GSI with the account prefix', async () => {
    clientMock.on(QueryCommand).resolves({ Items: [] });

    await repository().queryGsi2Status('active', { sortKeyPrefix: 'PROPERTY#', limit: 10 });

    const command = clientMock.commandCalls(QueryCommand)[0]?.args[0];
    expect(command?.input.IndexName).toBe('GSI2');
    expect(command?.input.ExpressionAttributeValues).toEqual({
      ':partition': `ACCOUNT#${accountId}#STATUS#active`,
      ':sortPrefix': 'PROPERTY#',
    });
    expect(command?.input.Limit).toBe(10);
  });

  it('rejects a foreign-account GSI query and pagination cursor', async () => {
    const repo = repository();

    await expect(repo.queryGsi1('ACCOUNT#another-account#PROPERTY#x')).rejects.toThrow(
      /repository account/,
    );
    await expect(
      repo.query({ exclusiveStartKey: { PK: 'ACCOUNT#another-account', SK: 'PROPERTY#x' } }),
    ).rejects.toThrow(/repository account/);
    await expect(
      repo.queryGsi2Status('active', {
        exclusiveStartKey: {
          PK: `ACCOUNT#${accountId}`,
          GSI2PK: 'ACCOUNT#another-account#STATUS#active',
          GSI2SK: 'PROPERTY#x',
        },
      }),
    ).rejects.toThrow(/repository account/);

    expect(clientMock.commandCalls(QueryCommand)).toHaveLength(0);
  });
});
