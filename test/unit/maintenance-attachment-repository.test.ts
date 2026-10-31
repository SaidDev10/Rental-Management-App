import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, describe, expect, it } from 'vitest';

import { createMaintenanceAttachmentRepository } from '../../src/modules/maintenance/attachment-repository';

const clientMock = mockClient(DynamoDBDocumentClient);

afterEach(() => clientMock.reset());

describe('maintenance attachment repository', () => {
  it('looks up ticket existence in the caller account partition', async () => {
    clientMock.on(GetCommand).resolves({ Item: { PK: 'ACCOUNT#owner-account', SK: 'TICKET#ticket-1' } });
    const repository = createMaintenanceAttachmentRepository({
      accountId: 'owner-account',
      client: clientMock as unknown as DynamoDBDocumentClient,
      tableName: 'table-test',
    });

    await expect(repository.assertTicketExists('ticket-1')).resolves.toBeUndefined();
    expect(clientMock.commandCalls(GetCommand)[0]?.args[0].input).toMatchObject({
      Key: { PK: 'ACCOUNT#owner-account', SK: 'TICKET#ticket-1' },
      ConsistentRead: true,
    });
  });

  it('returns not found for a ticket missing from the caller account', async () => {
    clientMock.on(GetCommand).resolves({});
    const repository = createMaintenanceAttachmentRepository({
      accountId: 'owner-account',
      client: clientMock as unknown as DynamoDBDocumentClient,
      tableName: 'table-test',
    });

    await expect(repository.assertTicketExists('foreign-ticket')).rejects.toMatchObject({
      status: 404,
      message: 'MAINTENANCE_TICKET_NOT_FOUND',
    });
  });

  it('persists only attachment metadata on an account-scoped, active ticket', async () => {
    clientMock.on(UpdateCommand).resolves({});
    const repository = createMaintenanceAttachmentRepository({
      accountId: 'owner-account',
      client: clientMock as unknown as DynamoDBDocumentClient,
      tableName: 'table-test',
    });
    const attachment = {
      s3Key: 'accounts/owner-account/documents/01JABCDEF0123456789ABCDEFG.jpg',
      mimeType: 'image/jpeg' as const,
      sizeBytes: 123,
    };

    await repository.addAttachment('ticket-1', attachment);
    expect(clientMock.commandCalls(UpdateCommand)[0]?.args[0].input).toMatchObject({
      Key: { PK: 'ACCOUNT#owner-account', SK: 'TICKET#ticket-1' },
      UpdateExpression: 'SET #attachments = list_append(if_not_exists(#attachments, :empty), :attachment), #updatedAt = :now',
      ConditionExpression: 'attribute_exists(PK) AND attribute_not_exists(#deletedAt)',
      ExpressionAttributeValues: { ':attachment': [attachment] },
    });
  });

  it('does not attach to a missing or deleted ticket', async () => {
    clientMock.on(UpdateCommand).rejects(Object.assign(new Error('conditional failure'), {
      name: 'ConditionalCheckFailedException',
    }));
    const repository = createMaintenanceAttachmentRepository({
      accountId: 'owner-account',
      client: clientMock as unknown as DynamoDBDocumentClient,
      tableName: 'table-test',
    });

    await expect(repository.addAttachment('missing-ticket', {
      s3Key: 'accounts/owner-account/documents/01JABCDEF0123456789ABCDEFG.jpg',
      mimeType: 'image/jpeg',
      sizeBytes: 123,
    })).rejects.toMatchObject({ status: 404, message: 'MAINTENANCE_TICKET_NOT_FOUND' });
  });
});
