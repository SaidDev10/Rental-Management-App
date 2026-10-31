import { GetCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { getDocumentClient } from '../../shared/db';
import { pk } from '../../shared/db/keys';
import { NotFoundError } from '../../shared/errors';
import type { DocumentContentType } from '../document/types';

export type MaintenanceAttachmentRepository = {
  assertTicketExists: (ticketId: string) => Promise<void>;
  addAttachment: (ticketId: string, attachment: {
    s3Key: string;
    mimeType: DocumentContentType;
    sizeBytes: number;
  }) => Promise<void>;
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

    async addAttachment(ticketId, attachment) {
      try {
        await client.send(new UpdateCommand({
          TableName: tableName,
          Key: { PK: partitionKey, SK: `TICKET#${ticketId}` },
          UpdateExpression: 'SET #attachments = list_append(if_not_exists(#attachments, :empty), :attachment), #updatedAt = :now',
          ConditionExpression: 'attribute_exists(PK) AND attribute_not_exists(#deletedAt)',
          ExpressionAttributeNames: {
            '#attachments': 'attachments',
            '#deletedAt': 'deletedAt',
            '#updatedAt': 'updatedAt',
          },
          ExpressionAttributeValues: {
            ':empty': [],
            ':attachment': [attachment],
            ':now': new Date().toISOString(),
          },
        }));
      } catch (error) {
        if (error && typeof error === 'object' && 'name' in error && error.name === 'ConditionalCheckFailedException') {
          throw new NotFoundError('MAINTENANCE_TICKET_NOT_FOUND');
        }

        throw error;
      }
    },
  };
};
