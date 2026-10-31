import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
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
});
