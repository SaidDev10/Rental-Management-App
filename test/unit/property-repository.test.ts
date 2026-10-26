import { DynamoDBDocumentClient, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, describe, expect, it } from 'vitest';

import { createPropertyRepository } from '../../src/modules/property/repository';

const clientMock = mockClient(DynamoDBDocumentClient);
const accountId = 'account-1';
const propertyId = 'property-1';

afterEach(() => {
  clientMock.reset();
});

describe('property repository', () => {
  const repository = () =>
    createPropertyRepository({
      accountId,
      client: clientMock as unknown as DynamoDBDocumentClient,
      tableName: 'properties-test',
    });

  it('finds an active lease id through the property GSI access pattern', async () => {
    clientMock.on(QueryCommand).resolves({
      Items: [{ entityType: 'Lease', status: 'active', SK: 'LEASE#lease-1' }],
    });

    await expect(repository().findActiveLeaseId(propertyId)).resolves.toBe('lease-1');

    const command = clientMock.commandCalls(QueryCommand)[0]?.args[0];
    expect(command?.input).toMatchObject({
      TableName: 'properties-test',
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :gsi1pk',
      ExpressionAttributeValues: { ':gsi1pk': 'ACCOUNT#account-1#PROPERTY#property-1' },
      ConsistentRead: false,
    });
  });

  it('appends photos with account, version, and photo-count conditions', async () => {
    clientMock.on(UpdateCommand).resolves({
      Attributes: {
        PK: 'ACCOUNT#account-1',
        SK: 'PROPERTY#property-1',
        entityType: 'Property',
        accountId,
        id: propertyId,
        photoKeys: ['accounts/account-1/properties/property-1/photo.jpg'],
        version: 2,
      },
    });

    await repository().addPhoto(propertyId, 1, 'accounts/account-1/properties/property-1/photo.jpg');

    const command = clientMock.commandCalls(UpdateCommand)[0]?.args[0];
    expect(command?.input.Key).toEqual({
      PK: 'ACCOUNT#account-1',
      SK: 'PROPERTY#property-1',
    });
    expect(command?.input.ConditionExpression).toContain('accountId = :accountId');
    expect(command?.input.ConditionExpression).toContain('#version = :expectedVersion');
    expect(command?.input.ConditionExpression).toContain('size(photoKeys) < :photoLimit');
    expect(command?.input.ExpressionAttributeValues).toMatchObject({
      ':accountId': accountId,
      ':expectedVersion': 1,
      ':photoLimit': 20,
    });
  });
});
