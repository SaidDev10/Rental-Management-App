import { createHash } from 'node:crypto';

import { GetCommand, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { ulid } from 'ulid';

import { AppError } from '../../shared/errors';
import { getDocumentClient } from '../../shared/db';
import { pk, sk } from '../../shared/db/keys';
import type { QueryPage } from '../../shared/db/pagination';
import { PROPERTY_PHOTO_LIMIT, type CreatePropertyInput, type Property, type UpdatePropertyInput } from './types';

export type PropertyRecord = Property & {
  PK: string;
  SK: string;
  entityType: 'Property';
  deletedAt?: string;
  schemaVersion: number;
  GSI2PK?: string;
  GSI2SK?: string;
};

export type PropertyRepository = {
  list: (options: PropertyListOptions) => Promise<QueryPage<PropertyRecord>>;
  getById: (propertyId: string) => Promise<PropertyRecord | undefined>;
  create: (input: CreatePropertyInput, idempotencyKey?: string) => Promise<PropertyRecord>;
  update: (propertyId: string, expectedVersion: number, input: UpdatePropertyInput) => Promise<PropertyRecord>;
  addPhoto: (propertyId: string, expectedVersion: number, photoKey: string) => Promise<PropertyRecord>;
  findActiveLeaseId: (propertyId: string) => Promise<string | undefined>;
  hasActiveLease: (propertyId: string) => Promise<boolean>;
  softDelete: (propertyId: string, expectedVersion: number, deletedAt: string) => Promise<void>;
};

export type PropertyListOptions = {
  limit: number;
  cursor?: Record<string, unknown>;
};

type PropertyRepositoryOptions = {
  accountId: string;
  client?: DynamoDBDocumentClient;
  tableName?: string;
};

const isConditionalFailure = (error: unknown): boolean =>
  !!error &&
  typeof error === 'object' &&
  'name' in error &&
  (error.name === 'ConditionalCheckFailedException' || error.name === 'TransactionCanceledException');

const toProperty = (item: Record<string, unknown>): PropertyRecord => ({
  ...(item as unknown as PropertyRecord),
});

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }

  return value;
};

const hash = (value: string): string => createHash('sha256').update(value).digest('hex');

export const createPropertyRepository = ({
  accountId,
  client = getDocumentClient(),
  tableName = process.env.TABLE_NAME,
}: PropertyRepositoryOptions): PropertyRepository => {
  if (!tableName) {
    throw new Error('TABLE_NAME must be configured before creating property repositories.');
  }

  const partitionKey = pk.account(accountId);

  return {
    async list({ limit, cursor }): Promise<QueryPage<PropertyRecord>> {
      if (
        cursor &&
        (cursor.PK !== partitionKey || typeof cursor.SK !== 'string' || !cursor.SK.startsWith('PROPERTY#'))
      ) {
        throw new AppError('Invalid property pagination cursor.', 400, 'VALIDATION_ERROR');
      }

      const result = await client.send(
        new QueryCommand({
          TableName: tableName,
          KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
          ExpressionAttributeValues: { ':pk': partitionKey, ':prefix': 'PROPERTY#' },
          Limit: limit,
          ...(cursor ? { ExclusiveStartKey: cursor } : {}),
          ConsistentRead: true,
        }),
      );

      return {
        items: (result.Items ?? [])
          .filter((item) => item.entityType === 'Property' && !item.deletedAt)
          .map(toProperty),
        nextCursor: result.LastEvaluatedKey,
      };
    },

    async getById(propertyId): Promise<PropertyRecord | undefined> {
      const result = await client.send(
        new GetCommand({
          TableName: tableName,
          Key: { PK: partitionKey, SK: sk.property(propertyId) },
          ConsistentRead: true,
        }),
      );
      const item = result.Item as Record<string, unknown> | undefined;

      if (!item || item.entityType !== 'Property' || item.deletedAt) {
        return undefined;
      }

      if (item.accountId !== accountId || item.PK !== partitionKey) {
        throw new Error('DynamoDB property does not belong to the repository account.');
      }

      return toProperty(item);
    },

    async create(input, idempotencyKey): Promise<PropertyRecord> {
      const requestHash = idempotencyKey ? hash(JSON.stringify(canonicalize(input))) : undefined;
      const idempotencySortKey = idempotencyKey ? sk.idempotency(hash(idempotencyKey)) : undefined;
      if (idempotencySortKey && requestHash) {
        const existingResult = await client.send(
          new GetCommand({
            TableName: tableName,
            Key: { PK: partitionKey, SK: idempotencySortKey },
            ConsistentRead: true,
          }),
        );
        const existing = existingResult.Item as Record<string, unknown> | undefined;
        if (existing) {
          if (existing.requestHash !== requestHash) {
            throw new AppError('Idempotency key was already used for another request.', 409, 'IDEMPOTENCY_KEY_REUSED');
          }

          const existingProperty = await this.getById(String(existing.propertyId ?? ''));
          if (!existingProperty) {
            throw new AppError('Idempotent property creation no longer exists.', 409, 'IDEMPOTENCY_RESULT_UNAVAILABLE');
          }

          return existingProperty;
        }
      }

      const now = new Date().toISOString();
      const id = ulid();
      const property: PropertyRecord = {
        ...input,
        photoKeys: [],
        id,
        accountId,
        PK: partitionKey,
        SK: sk.property(id),
        entityType: 'Property',
        GSI2PK: `${partitionKey}#STATUS#${input.status}`,
        GSI2SK: `PROPERTY#${id}`,
        version: 1,
        schemaVersion: 1,
        createdAt: now,
        updatedAt: now,
      };

      try {
        if (idempotencySortKey && requestHash && idempotencyKey) {
          await client.send(
            new TransactWriteCommand({
              TransactItems: [
                {
                  Put: {
                    TableName: tableName,
                    Item: property,
                    ConditionExpression: 'attribute_not_exists(PK) AND attribute_not_exists(SK)',
                  },
                },
                {
                  Put: {
                    TableName: tableName,
                    Item: {
                      PK: partitionKey,
                      SK: idempotencySortKey,
                      entityType: 'IdempotencyRecord',
                      accountId,
                      idempotencyKeyHash: hash(idempotencyKey),
                      requestHash,
                      propertyId: id,
                      createdAt: now,
                      ttl: Math.floor(Date.now() / 1000) + 24 * 60 * 60,
                    },
                    ConditionExpression: 'attribute_not_exists(PK) AND attribute_not_exists(SK)',
                  },
                },
              ],
            }),
          );
        } else {
          await client.send(
            new PutCommand({
              TableName: tableName,
              Item: property,
              ConditionExpression: 'attribute_not_exists(PK) AND attribute_not_exists(SK)',
            }),
          );
        }
      } catch (error) {
        if (idempotencySortKey && requestHash && isConditionalFailure(error)) {
          const existingResult = await client.send(
            new GetCommand({
              TableName: tableName,
              Key: { PK: partitionKey, SK: idempotencySortKey },
              ConsistentRead: true,
            }),
          );
          const existing = existingResult.Item as Record<string, unknown> | undefined;
          if (existing?.requestHash === requestHash) {
            const existingProperty = await this.getById(String(existing.propertyId ?? ''));
            if (existingProperty) {
              return existingProperty;
            }
          }
          if (existing) {
            throw new AppError('Idempotency key was already used for another request.', 409, 'IDEMPOTENCY_KEY_REUSED');
          }
        }

        throw error;
      }

      return property;
    },

    async update(propertyId, expectedVersion, input): Promise<PropertyRecord> {
      const names: Record<string, string> = {
        '#accountId': 'accountId',
        '#deletedAt': 'deletedAt',
        '#updatedAt': 'updatedAt',
        '#version': 'version',
      };
      const values: Record<string, unknown> = {
        ':accountId': accountId,
        ':expectedVersion': expectedVersion,
        ':nextVersion': expectedVersion + 1,
        ':now': new Date().toISOString(),
      };
      const assignments = ['#updatedAt = :now', '#version = :nextVersion'];

      for (const [key, value] of Object.entries(input)) {
        if (value === undefined) {
          continue;
        }

        names[`#${key}`] = key;
        values[`:${key}`] = value;
        assignments.push(`#${key} = :${key}`);
      }
      if (input.status !== undefined) {
        assignments.push('GSI2PK = :gsi2pk', 'GSI2SK = :gsi2sk');
        values[':gsi2pk'] = `${partitionKey}#STATUS#${input.status}`;
        values[':gsi2sk'] = `PROPERTY#${propertyId}`;
      }

      try {
        const result = await client.send(
          new UpdateCommand({
            TableName: tableName,
            Key: { PK: partitionKey, SK: sk.property(propertyId) },
            UpdateExpression: `SET ${assignments.join(', ')}`,
            ConditionExpression: '#accountId = :accountId AND #version = :expectedVersion AND attribute_not_exists(#deletedAt)',
            ExpressionAttributeNames: names,
            ExpressionAttributeValues: values,
            ReturnValues: 'ALL_NEW',
          }),
        );

        return toProperty(result.Attributes as Record<string, unknown>);
      } catch (error) {
        if (isConditionalFailure(error)) {
          throw new AppError('Property version does not match or property is unavailable.', 409, 'CONFLICT_VERSION_MISMATCH');
        }

        throw error;
      }
    },

    async addPhoto(propertyId, expectedVersion, photoKey): Promise<PropertyRecord> {
      try {
        const result = await client.send(
          new UpdateCommand({
            TableName: tableName,
            Key: { PK: partitionKey, SK: sk.property(propertyId) },
            UpdateExpression:
              'SET photoKeys = list_append(if_not_exists(photoKeys, :emptyList), :photoKeys), updatedAt = :now, #version = :nextVersion',
            ConditionExpression:
              'accountId = :accountId AND #version = :expectedVersion AND attribute_not_exists(deletedAt) AND (attribute_not_exists(photoKeys) OR size(photoKeys) < :photoLimit)',
            ExpressionAttributeNames: { '#version': 'version' },
            ExpressionAttributeValues: {
              ':accountId': accountId,
              ':expectedVersion': expectedVersion,
              ':nextVersion': expectedVersion + 1,
              ':emptyList': [],
              ':photoKeys': [photoKey],
              ':photoLimit': PROPERTY_PHOTO_LIMIT,
              ':now': new Date().toISOString(),
            },
            ReturnValues: 'ALL_NEW',
          }),
        );

        return toProperty(result.Attributes as Record<string, unknown>);
      } catch (error) {
        if (!isConditionalFailure(error)) {
          throw error;
        }

        const current = await this.getById(propertyId);
        if (current?.photoKeys.includes(photoKey)) {
          return current;
        }
        if (current && current.photoKeys.length >= PROPERTY_PHOTO_LIMIT) {
          throw new AppError('A property cannot have more than 20 photos.', 409, 'PROPERTY_PHOTO_LIMIT');
        }

        throw new AppError('Property version does not match or property is unavailable.', 409, 'CONFLICT_VERSION_MISMATCH');
      }
    },

    async findActiveLeaseId(propertyId): Promise<string | undefined> {
      let exclusiveStartKey: Record<string, unknown> | undefined;

      do {
        const result = await client.send(
          new QueryCommand({
            TableName: tableName,
            IndexName: 'GSI1',
            KeyConditionExpression: 'GSI1PK = :gsi1pk',
            ExpressionAttributeValues: { ':gsi1pk': `${partitionKey}#PROPERTY#${propertyId}` },
            ConsistentRead: false,
            ExclusiveStartKey: exclusiveStartKey,
          }),
        );
        const activeLease = (result.Items ?? []).find(
          (item) => item.entityType === 'Lease' && item.status === 'active',
        );
        if (activeLease) {
          const sortKey = activeLease.SK;
          if (typeof sortKey !== 'string' || !sortKey.startsWith('LEASE#') || sortKey.length === 'LEASE#'.length) {
            throw new Error('DynamoDB active lease has an invalid sort key.');
          }

          return sortKey.slice('LEASE#'.length);
        }
        exclusiveStartKey = result.LastEvaluatedKey;
      } while (exclusiveStartKey);

      return undefined;
    },

    async hasActiveLease(propertyId): Promise<boolean> {
      return (await this.findActiveLeaseId(propertyId)) !== undefined;
    },

    async softDelete(propertyId, expectedVersion, deletedAt): Promise<void> {
      try {
        await client.send(
          new UpdateCommand({
            TableName: tableName,
            Key: { PK: partitionKey, SK: sk.property(propertyId) },
            UpdateExpression: 'SET deletedAt = :deletedAt, updatedAt = :deletedAt, #version = :nextVersion REMOVE GSI2PK, GSI2SK',
            ConditionExpression: 'accountId = :accountId AND #version = :expectedVersion AND attribute_not_exists(deletedAt)',
            ExpressionAttributeNames: { '#version': 'version' },
            ExpressionAttributeValues: {
              ':accountId': accountId,
              ':deletedAt': deletedAt,
              ':expectedVersion': expectedVersion,
              ':nextVersion': expectedVersion + 1,
            },
          }),
        );
      } catch (error) {
        if (isConditionalFailure(error)) {
          throw new AppError('Property version does not match or property is unavailable.', 409, 'CONFLICT_VERSION_MISMATCH');
        }

        throw error;
      }
    },
  };
};
