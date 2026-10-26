import { createHash } from 'node:crypto';

import {
  BatchGetCommand,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { ulid } from 'ulid';

import { AppError } from '../../shared/errors';
import { getDocumentClient } from '../../shared/db';
import { gsi1, pk, sk } from '../../shared/db/keys';
import type { QueryPage } from '../../shared/db/pagination';
import type { CreateTenantInput, Tenant, TenantIdDocument, UpdateTenantInput } from './types';

export type TenantRecord = Tenant & {
  PK: string;
  SK: string;
  entityType: 'Tenant';
  sortName: string;
  idDocument?: TenantIdDocument;
  deletedAt?: string;
  schemaVersion: number;
  GSI1PK?: string;
  GSI1SK?: string;
};

export type TenantLeaseRecord = {
  id: string;
  propertyId: string;
  startDate: string;
  endDate: string;
  status: 'draft' | 'active' | 'terminated' | 'expired';
};

export type TenantListOptions = {
  limit: number;
  cursor?: Record<string, unknown>;
};

export type TenantRepository = {
  list: (options: TenantListOptions) => Promise<QueryPage<TenantRecord>>;
  getById: (tenantId: string) => Promise<TenantRecord | undefined>;
  create: (input: CreateTenantInput, idempotencyKey: string) => Promise<TenantRecord>;
  update: (tenantId: string, expectedVersion: number, input: UpdateTenantInput) => Promise<TenantRecord>;
  setIdDocument: (tenantId: string, expectedVersion: number, document: TenantIdDocument) => Promise<TenantRecord>;
  getLeases: (tenantId: string) => Promise<TenantLeaseRecord[]>;
  hasActiveLease: (tenantId: string) => Promise<boolean>;
  softDelete: (tenantId: string, expectedVersion: number, deletedAt: string) => Promise<void>;
};

type TenantRepositoryOptions = {
  accountId: string;
  client?: DynamoDBDocumentClient;
  tableName?: string;
};

const isConditionalFailure = (error: unknown): boolean =>
  !!error &&
  typeof error === 'object' &&
  'name' in error &&
  (error.name === 'ConditionalCheckFailedException' || error.name === 'TransactionCanceledException');

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }

  return value;
};

const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
const toTenantRecord = (item: Record<string, unknown>): TenantRecord => ({ ...item } as TenantRecord);

const batchGet = async (
  client: DynamoDBDocumentClient,
  tableName: string,
  keys: Array<{ PK: string; SK: string }>,
): Promise<Record<string, unknown>[]> => {
  const items: Record<string, unknown>[] = [];
  for (let offset = 0; offset < keys.length; offset += 100) {
    let requestKeys = keys.slice(offset, offset + 100);
    for (let retry = 0; retry <= 4; retry += 1) {
      const response = await client.send(
        new BatchGetCommand({
          RequestItems: {
            [tableName]: { Keys: requestKeys, ConsistentRead: true },
          },
        }),
      );
      items.push(...((response.Responses?.[tableName] ?? []) as Record<string, unknown>[]));
      const unprocessedKeys = response.UnprocessedKeys?.[tableName]?.Keys;
      if (!unprocessedKeys?.length) {
        break;
      }
      if (retry === 4) {
        throw new Error('DynamoDB did not process all tenant lease lookup keys after retries.');
      }
      requestKeys = unprocessedKeys as Array<{ PK: string; SK: string }>;
      await new Promise((resolve) => setTimeout(resolve, 25 * 2 ** retry));
    }
  }

  return items;
};

export const createTenantRepository = ({
  accountId,
  client = getDocumentClient(),
  tableName = process.env.TABLE_NAME,
}: TenantRepositoryOptions): TenantRepository => {
  if (!tableName) {
    throw new Error('TABLE_NAME must be configured before creating tenant repositories.');
  }

  const partitionKey = pk.account(accountId);
  const tenantDirectory = gsi1.tenantDirectory(accountId);
  const tenantLeasePrefix = (tenantId: string): string => `LINK#TENANT#${tenantId}#LEASE#`;

  const readLeases = async (tenantId: string): Promise<TenantLeaseRecord[]> => {
    const linkKeys: Array<{ PK: string; SK: string }> = [];
    let exclusiveStartKey: Record<string, unknown> | undefined;

    do {
      const result = await client.send(
        new QueryCommand({
          TableName: tableName,
          KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
          ExpressionAttributeValues: { ':pk': partitionKey, ':prefix': tenantLeasePrefix(tenantId) },
          ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
          ConsistentRead: true,
        }),
      );
      for (const link of result.Items ?? []) {
        if (
          link.entityType !== 'TenantLeaseLink' ||
          link.accountId !== accountId ||
          link.tenantId !== tenantId ||
          typeof link.leaseId !== 'string'
        ) {
          throw new Error('DynamoDB tenant lease link is invalid or outside the repository account.');
        }
        linkKeys.push({ PK: partitionKey, SK: sk.lease(link.leaseId) });
      }
      exclusiveStartKey = result.LastEvaluatedKey;
    } while (exclusiveStartKey);

    const uniqueKeys = [...new Map(linkKeys.map((key) => [key.SK, key])).values()];
    const leaseItems = await batchGet(client, tableName, uniqueKeys);

    return leaseItems
      .filter(
        (lease) =>
          lease.entityType === 'Lease' &&
          lease.accountId === accountId &&
          lease.PK === partitionKey &&
          lease.status === 'active' &&
          typeof lease.id === 'string' &&
          typeof lease.propertyId === 'string' &&
          typeof lease.startDate === 'string' &&
          typeof lease.endDate === 'string',
      )
      .map((lease) => ({
        id: String(lease.id),
        propertyId: String(lease.propertyId),
        startDate: String(lease.startDate),
        endDate: String(lease.endDate),
        status: 'active' as const,
      }));
  };

  return {
    async list({ limit, cursor }): Promise<QueryPage<TenantRecord>> {
      if (
        cursor &&
        (cursor.PK !== partitionKey ||
          cursor.GSI1PK !== tenantDirectory ||
          typeof cursor.GSI1SK !== 'string' ||
          !cursor.GSI1SK.startsWith('TENANT#'))
      ) {
        throw new AppError('Invalid tenant pagination cursor.', 400, 'VALIDATION_ERROR');
      }

      const result = await client.send(
        new QueryCommand({
          TableName: tableName,
          IndexName: 'GSI1',
          KeyConditionExpression: 'GSI1PK = :gsi1pk AND begins_with(GSI1SK, :prefix)',
          ExpressionAttributeValues: { ':gsi1pk': tenantDirectory, ':prefix': 'TENANT#' },
          Limit: limit,
          ...(cursor ? { ExclusiveStartKey: cursor } : {}),
          ConsistentRead: false,
        }),
      );

      return {
        items: (result.Items ?? [])
          .filter(
            (item) =>
              item.entityType === 'Tenant' &&
              item.accountId === accountId &&
              item.PK === partitionKey &&
              !item.deletedAt,
          )
          .map((item) => toTenantRecord(item as Record<string, unknown>)),
        nextCursor: result.LastEvaluatedKey,
      };
    },

    async getById(tenantId): Promise<TenantRecord | undefined> {
      const result = await client.send(
        new GetCommand({
          TableName: tableName,
          Key: { PK: partitionKey, SK: sk.tenant(tenantId) },
          ConsistentRead: true,
        }),
      );
      const item = result.Item as Record<string, unknown> | undefined;
      if (!item || item.entityType !== 'Tenant' || item.deletedAt) {
        return undefined;
      }
      if (item.accountId !== accountId || item.PK !== partitionKey) {
        throw new Error('DynamoDB tenant does not belong to the repository account.');
      }

      return toTenantRecord(item);
    },

    async create(input, idempotencyKey): Promise<TenantRecord> {
      const requestHash = hash(JSON.stringify(canonicalize(input)));
      const idempotencySortKey = sk.idempotency(hash(idempotencyKey));
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
        const previousTenant = await this.getById(String(existing.tenantId ?? ''));
        if (!previousTenant) {
          throw new AppError('Idempotent tenant creation no longer exists.', 409, 'IDEMPOTENCY_RESULT_UNAVAILABLE');
        }

        return previousTenant;
      }

      const now = new Date().toISOString();
      const id = ulid();
      const sortName = `${input.lastName.trim().toLocaleLowerCase()}#${input.firstName.trim().toLocaleLowerCase()}`;
      const tenant: TenantRecord = {
        ...input,
        id,
        accountId,
        idDocumentType: null,
        idDocumentLast4: null,
        PK: partitionKey,
        SK: sk.tenant(id),
        entityType: 'Tenant',
        sortName,
        GSI1PK: tenantDirectory,
        GSI1SK: `TENANT#${sortName}#${id}`,
        version: 1,
        schemaVersion: 1,
        createdAt: now,
        updatedAt: now,
      };
      const idempotencyRecord = {
        PK: partitionKey,
        SK: idempotencySortKey,
        entityType: 'IdempotencyRecord',
        accountId,
        idempotencyKeyHash: hash(idempotencyKey),
        requestHash,
        tenantId: id,
        createdAt: now,
        ttl: Math.floor(Date.now() / 1000) + 24 * 60 * 60,
      };

      try {
        await client.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                Put: {
                  TableName: tableName,
                  Item: tenant,
                  ConditionExpression: 'attribute_not_exists(PK) AND attribute_not_exists(SK)',
                },
              },
              {
                Put: {
                  TableName: tableName,
                  Item: idempotencyRecord,
                  ConditionExpression: 'attribute_not_exists(PK) AND attribute_not_exists(SK)',
                },
              },
            ],
          }),
        );
      } catch (error) {
        if (isConditionalFailure(error)) {
          const retry = await client.send(
            new GetCommand({
              TableName: tableName,
              Key: { PK: partitionKey, SK: idempotencySortKey },
              ConsistentRead: true,
            }),
          );
          const retryRecord = retry.Item as Record<string, unknown> | undefined;
          if (retryRecord?.requestHash === requestHash) {
            const retryTenant = await this.getById(String(retryRecord.tenantId ?? ''));
            if (retryTenant) {
              return retryTenant;
            }
          }
          if (retryRecord) {
            throw new AppError('Idempotency key was already used for another request.', 409, 'IDEMPOTENCY_KEY_REUSED');
          }
        }

        throw error;
      }

      return tenant;
    },

    async update(tenantId, expectedVersion, input): Promise<TenantRecord> {
      const attributes = Object.entries(input).filter(([, value]) => value !== undefined);
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
      for (const [key, value] of attributes) {
        names[`#${key}`] = key;
        values[`:${key}`] = value;
        assignments.push(`#${key} = :${key}`);
      }
      const firstName = input.firstName;
      const lastName = input.lastName;
      if (firstName !== undefined || lastName !== undefined) {
        const current = await this.getById(tenantId);
        if (!current) {
          throw new AppError('Tenant version does not match or tenant is unavailable.', 409, 'CONFLICT_VERSION_MISMATCH');
        }
        const sortName = `${(lastName ?? current.lastName).trim().toLocaleLowerCase()}#${(firstName ?? current.firstName).trim().toLocaleLowerCase()}`;
        assignments.push('sortName = :sortName', 'GSI1SK = :gsi1sk');
        values[':sortName'] = sortName;
        values[':gsi1sk'] = `TENANT#${sortName}#${tenantId}`;
      }

      try {
        const result = await client.send(
          new UpdateCommand({
            TableName: tableName,
            Key: { PK: partitionKey, SK: sk.tenant(tenantId) },
            UpdateExpression: `SET ${assignments.join(', ')}`,
            ConditionExpression: '#accountId = :accountId AND #version = :expectedVersion AND attribute_not_exists(#deletedAt)',
            ExpressionAttributeNames: names,
            ExpressionAttributeValues: values,
            ReturnValues: 'ALL_NEW',
          }),
        );

        return toTenantRecord(result.Attributes as Record<string, unknown>);
      } catch (error) {
        if (isConditionalFailure(error)) {
          throw new AppError('Tenant version does not match or tenant is unavailable.', 409, 'CONFLICT_VERSION_MISMATCH');
        }

        throw error;
      }
    },

    async setIdDocument(tenantId, expectedVersion, document): Promise<TenantRecord> {
      try {
        const result = await client.send(
          new UpdateCommand({
            TableName: tableName,
            Key: { PK: partitionKey, SK: sk.tenant(tenantId) },
            UpdateExpression: 'SET idDocument = :document, idDocumentType = :type, idDocumentLast4 = :last4, updatedAt = :now, #version = :nextVersion',
            ConditionExpression: 'accountId = :accountId AND #version = :expectedVersion AND attribute_not_exists(deletedAt)',
            ExpressionAttributeNames: { '#version': 'version' },
            ExpressionAttributeValues: {
              ':accountId': accountId,
              ':expectedVersion': expectedVersion,
              ':nextVersion': expectedVersion + 1,
              ':document': document,
              ':type': document.type,
              ':last4': document.last4,
              ':now': new Date().toISOString(),
            },
            ReturnValues: 'ALL_NEW',
          }),
        );

        return toTenantRecord(result.Attributes as Record<string, unknown>);
      } catch (error) {
        if (isConditionalFailure(error)) {
          throw new AppError('Tenant version does not match or tenant is unavailable.', 409, 'CONFLICT_VERSION_MISMATCH');
        }

        throw error;
      }
    },

    getLeases: readLeases,

    async hasActiveLease(tenantId): Promise<boolean> {
      return (await readLeases(tenantId)).length > 0;
    },

    async softDelete(tenantId, expectedVersion, deletedAt): Promise<void> {
      try {
        await client.send(
          new UpdateCommand({
            TableName: tableName,
            Key: { PK: partitionKey, SK: sk.tenant(tenantId) },
            UpdateExpression: 'SET deletedAt = :deletedAt, updatedAt = :deletedAt, #version = :nextVersion REMOVE GSI1PK, GSI1SK',
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
          throw new AppError('Tenant version does not match or tenant is unavailable.', 409, 'CONFLICT_VERSION_MISMATCH');
        }

        throw error;
      }
    },
  };
};