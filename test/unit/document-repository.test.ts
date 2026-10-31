import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, describe, expect, it } from 'vitest';

import { createDocumentRepository } from '../../src/modules/document/repository';

const clientMock = mockClient(DynamoDBDocumentClient);

afterEach(() => clientMock.reset());

describe('document repository', () => {
  it('lists only the authenticated account partition and applies supplied metadata filters', async () => {
    clientMock.on(QueryCommand).resolves({
      Items: [{
        PK: 'ACCOUNT#account-1',
        SK: 'DOC#doc-1',
        id: 'doc-1',
        documentType: 'lease',
        linkedEntityType: 'Lease',
        linkedEntityId: 'lease-1',
      }],
      LastEvaluatedKey: { PK: 'ACCOUNT#account-1', SK: 'DOC#doc-1' },
    });
    const repository = createDocumentRepository({
      accountId: 'account-1',
      client: clientMock as unknown as DynamoDBDocumentClient,
      tableName: 'table-test',
    });
    const result = await repository.list({ linkedEntityType: 'Lease', linkedEntityId: 'lease-1', documentType: 'lease' });
    expect(result.items).toHaveLength(1);
    expect(result.nextCursor).toEqual({ PK: 'ACCOUNT#account-1', SK: 'DOC#doc-1' });
    expect(clientMock.commandCalls(QueryCommand)[0]?.args[0].input).toMatchObject({
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      ExpressionAttributeValues: { ':pk': 'ACCOUNT#account-1', ':prefix': 'DOC#' },
    });
  });

  it('checks linked entity ownership through the account partition and soft-deletes metadata only', async () => {
    clientMock.on(GetCommand).resolves({ Item: { PK: 'ACCOUNT#account-1', SK: 'PROPERTY#property-1' } });
    clientMock.on(PutCommand).resolves({});
    clientMock.on(UpdateCommand).resolves({});
    const repository = createDocumentRepository({
      accountId: 'account-1',
      client: clientMock as unknown as DynamoDBDocumentClient,
      tableName: 'table-test',
    });
    await repository.assertLinkedEntityExists('Property', 'property-1');
    await repository.create({
      id: 'doc-1',
      documentType: 'other',
      s3Bucket: 'documents-test',
      s3Key: 'accounts/account-1/documents/key.jpg',
      mimeType: 'image/jpeg',
      sizeBytes: 100,
      checksumSha256: null,
      linkedEntityType: 'Property',
      linkedEntityId: 'property-1',
    });
    await repository.softDelete('doc-1');

    expect(clientMock.commandCalls(GetCommand)[0]?.args[0].input.Key).toEqual({
      PK: 'ACCOUNT#account-1',
      SK: 'PROPERTY#property-1',
    });
    expect(clientMock.commandCalls(PutCommand)[0]?.args[0].input.ConditionExpression).toBe('attribute_not_exists(PK)');
    expect(clientMock.commandCalls(UpdateCommand)[0]?.args[0].input).toMatchObject({
      Key: { PK: 'ACCOUNT#account-1', SK: 'DOC#doc-1' },
      ConditionExpression: 'attribute_exists(PK) AND attribute_not_exists(#deletedAt)',
    });
  });

  it('atomically records a confirmed maintenance document and appends its attachment to the same ticket', async () => {
    clientMock.on(TransactWriteCommand).resolves({});
    const repository = createDocumentRepository({
      accountId: 'account-1',
      client: clientMock as unknown as DynamoDBDocumentClient,
      tableName: 'table-test',
    });
    await repository.create({
      id: 'doc-1',
      documentType: 'other',
      s3Bucket: 'documents-test',
      s3Key: 'accounts/account-1/documents/key.jpg',
      mimeType: 'image/jpeg',
      sizeBytes: 100,
      checksumSha256: null,
      linkedEntityType: 'MaintenanceTicket',
      linkedEntityId: 'ticket-1',
    });

    const transaction = clientMock.commandCalls(TransactWriteCommand)[0]?.args[0].input;
    expect(transaction?.TransactItems).toHaveLength(2);
    expect(transaction?.TransactItems?.[0]?.Put).toMatchObject({
      TableName: 'table-test',
      Item: { PK: 'ACCOUNT#account-1', SK: 'DOC#doc-1' },
      ConditionExpression: 'attribute_not_exists(PK)',
    });
    expect(transaction?.TransactItems?.[1]?.Update).toMatchObject({
      Key: { PK: 'ACCOUNT#account-1', SK: 'TICKET#ticket-1' },
      UpdateExpression: 'SET #attachments = list_append(if_not_exists(#attachments, :empty), :attachment), #updatedAt = :now',
      ConditionExpression: 'attribute_exists(PK) AND attribute_not_exists(#deletedAt)',
      ExpressionAttributeValues: {
        ':attachment': [{ s3Key: 'accounts/account-1/documents/key.jpg', mimeType: 'image/jpeg', sizeBytes: 100 }],
      },
    });
  });
});
