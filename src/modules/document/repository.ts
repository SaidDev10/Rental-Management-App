import {
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { getDocumentClient } from '../../shared/db';
import { pk, sk } from '../../shared/db/keys';
import { AppError, NotFoundError } from '../../shared/errors';
import type { CreateDocumentInput, Document, LinkedEntityType } from './types';

export type DocumentRecord = Document & {
  PK: string;
  SK: string;
  entityType: 'Document';
  schemaVersion: number;
  deletedAt?: string;
};

export type DocumentRepository = {
  list: (options: { linkedEntityType?: LinkedEntityType; linkedEntityId?: string; documentType?: string; cursor?: Record<string, unknown> }) => Promise<{ items: DocumentRecord[]; nextCursor?: Record<string, unknown> }>;
  getById: (id: string) => Promise<DocumentRecord | undefined>;
  assertLinkedEntityExists: (type: LinkedEntityType, id: string) => Promise<void>;
  create: (input: CreateDocumentInput) => Promise<DocumentRecord>;
  softDelete: (id: string) => Promise<void>;
};

type Options = { accountId: string; client?: DynamoDBDocumentClient; tableName?: string };

const entitySortKey = (type: LinkedEntityType, id: string): string => {
  switch (type) {
    case 'Lease': return sk.lease(id);
    case 'Payment': return sk.payment(id);
    case 'Tenant': return sk.tenant(id);
    case 'Property': return sk.property(id);
    case 'MaintenanceTicket': return `TICKET#${id}`;
  }
};

export const createDocumentRepository = ({
  accountId,
  client = getDocumentClient(),
  tableName = process.env.TABLE_NAME,
}: Options): DocumentRepository => {
  if (!tableName) throw new Error('TABLE_NAME must be configured before creating document repositories.');
  const partitionKey = pk.account(accountId);

  return {
    async list({ linkedEntityType, linkedEntityId, documentType, cursor }) {
      const response = await client.send(new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
        ExpressionAttributeValues: { ':pk': partitionKey, ':prefix': 'DOC#' },
        ...(cursor ? { ExclusiveStartKey: cursor } : {}),
        Limit: 100,
        ScanIndexForward: false,
      }));
      const items = (response.Items ?? []) as DocumentRecord[];

      return {
        items: items.filter((item) =>
          !item.deletedAt &&
          (!linkedEntityType || item.linkedEntityType === linkedEntityType) &&
          (!linkedEntityId || item.linkedEntityId === linkedEntityId) &&
          (!documentType || item.documentType === documentType),
        ),
        ...(response.LastEvaluatedKey ? { nextCursor: response.LastEvaluatedKey } : {}),
      };
    },

    async getById(id) {
      const response = await client.send(new GetCommand({
        TableName: tableName,
        Key: { PK: partitionKey, SK: sk.document(id) },
        ConsistentRead: true,
      }));
      const record = response.Item as DocumentRecord | undefined;

      return record && !record.deletedAt ? record : undefined;
    },

    async assertLinkedEntityExists(type, id) {
      const response = await client.send(new GetCommand({
        TableName: tableName,
        Key: { PK: partitionKey, SK: entitySortKey(type, id) },
        ConsistentRead: true,
      }));
      if (!response.Item || response.Item.deletedAt) {
        throw new NotFoundError(`${type.toUpperCase()}_NOT_FOUND`);
      }
    },

    async create(input) {
      const now = new Date().toISOString();
      const record: DocumentRecord = {
        ...input,
        accountId,
        PK: partitionKey,
        SK: sk.document(input.id),
        entityType: 'Document',
        schemaVersion: 1,
        generatedBy: 'upload',
        retentionClass: 'standard',
        createdAt: now,
        updatedAt: now,
      };
      try {
        if (input.linkedEntityType === 'MaintenanceTicket') {
          await client.send(new TransactWriteCommand({
            TransactItems: [
              {
                Put: {
                  TableName: tableName,
                  Item: record,
                  ConditionExpression: 'attribute_not_exists(PK)',
                },
              },
              {
                Update: {
                  TableName: tableName,
                  Key: { PK: partitionKey, SK: `TICKET#${input.linkedEntityId}` },
                  UpdateExpression: 'SET #attachments = list_append(if_not_exists(#attachments, :empty), :attachment), #updatedAt = :now',
                  ConditionExpression: 'attribute_exists(PK) AND attribute_not_exists(#deletedAt)',
                  ExpressionAttributeNames: {
                    '#attachments': 'attachments',
                    '#deletedAt': 'deletedAt',
                    '#updatedAt': 'updatedAt',
                  },
                  ExpressionAttributeValues: {
                    ':empty': [],
                    ':attachment': [{
                      s3Key: input.s3Key,
                      mimeType: input.mimeType,
                      sizeBytes: input.sizeBytes,
                    }],
                    ':now': now,
                  },
                },
              },
            ],
          }));
        } else {
          await client.send(new PutCommand({
            TableName: tableName,
            Item: record,
            ConditionExpression: 'attribute_not_exists(PK)',
          }));
        }
      } catch (error) {
        if (error && typeof error === 'object' && 'name' in error && error.name === 'ConditionalCheckFailedException') {
          throw new AppError('Document already exists.', 409, 'DOCUMENT_ALREADY_EXISTS');
        }
        throw error;
      }

      return record;
    },

    async softDelete(id) {
      try {
        await client.send(new UpdateCommand({
          TableName: tableName,
          Key: { PK: partitionKey, SK: sk.document(id) },
          UpdateExpression: 'SET #deletedAt = :now, #updatedAt = :now',
          ConditionExpression: 'attribute_exists(PK) AND attribute_not_exists(#deletedAt)',
          ExpressionAttributeNames: { '#deletedAt': 'deletedAt', '#updatedAt': 'updatedAt' },
          ExpressionAttributeValues: { ':now': new Date().toISOString() },
        }));
      } catch (error) {
        if (error && typeof error === 'object' && 'name' in error && error.name === 'ConditionalCheckFailedException') {
          throw new NotFoundError('DOCUMENT_NOT_FOUND');
        }
        throw error;
      }
    },
  };
};
