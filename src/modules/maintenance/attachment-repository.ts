import { GetCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { getDocumentClient } from '../../shared/db';
import { pk } from '../../shared/db/keys';
import { NotFoundError } from '../../shared/errors';

export type MaintenanceAttachmentRepository = {
  assertTicketExists: (ticketId: string) => Promise<void>;
};

type Options = {
  accountId: string;
  client?: DynamoDBDocumentClient;
  tableName?: string;
};

export const createMaintenanceAttachmentRepository = ({
  accountId,
  client = getDocumentClient(),
  tableName = process.env.TABLE_NAME,
}: Options): MaintenanceAttachmentRepository => {
  if (!tableName) {
    throw new Error('TABLE_NAME must be configured before creating maintenance attachment repositories.');
  }

  const partitionKey = pk.account(accountId);

  return {
    async assertTicketExists(ticketId) {
      const response = await client.send(new GetCommand({
        TableName: tableName,
        Key: { PK: partitionKey, SK: `TICKET#${ticketId}` },
        ConsistentRead: true,
        ProjectionExpression: 'PK, SK, deletedAt',
      }));

      if (!response.Item || response.Item.deletedAt) {
        throw new NotFoundError('MAINTENANCE_TICKET_NOT_FOUND');
      }
    },
  };
};
