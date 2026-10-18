import {
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';

import { gsi2, pk } from './keys';

export type AccountItem = {
  PK: string;
  SK: string;
  accountId: string;
  [attribute: string]: unknown;
};

export type QueryPage<T extends AccountItem> = {
  items: T[];
  lastEvaluatedKey?: Record<string, unknown>;
};

type ScopedRepositoryOptions = {
  accountId: string;
  client: DynamoDBDocumentClient;
  tableName: string;
};

type QueryOptions = {
  limit?: number;
  exclusiveStartKey?: Record<string, unknown>;
  sortKeyPrefix?: string;
};

const assertAccountItem = (accountId: string, item: AccountItem): void => {
  const accountPartition = pk.account(accountId);
  const hasInvalidGsi1 =
    item.GSI1PK !== undefined &&
    (typeof item.GSI1PK !== 'string' || !item.GSI1PK.startsWith(`${accountPartition}#`));
  const hasInvalidGsi2 =
    item.GSI2PK !== undefined &&
    (typeof item.GSI2PK !== 'string' || !item.GSI2PK.startsWith(`${accountPartition}#`));

  if (
    item.accountId !== accountId ||
    item.PK !== accountPartition ||
    hasInvalidGsi1 ||
    hasInvalidGsi2
  ) {
    throw new Error('DynamoDB item must belong to the repository account.');
  }
};

const validateCursor = (
  accountId: string,
  cursor: Record<string, unknown> | undefined,
  partitionAttribute: 'PK' | 'GSI1PK' | 'GSI2PK',
  partitionValue: string,
): void => {
  const accountPartition = pk.account(accountId);

  if (
    cursor &&
    (cursor.PK !== accountPartition ||
      cursor[partitionAttribute] !== partitionValue ||
      (typeof cursor.GSI1PK === 'string' && !cursor.GSI1PK.startsWith(`${accountPartition}#`)) ||
      (typeof cursor.GSI2PK === 'string' && !cursor.GSI2PK.startsWith(`${accountPartition}#`)))
  ) {
    throw new Error('DynamoDB cursor must belong to the repository account.');
  }
};

const pageFrom = <T extends AccountItem>(
  accountId: string,
  partitionAttribute: 'PK' | 'GSI1PK' | 'GSI2PK',
  partitionValue: string,
  result: { Items?: T[]; LastEvaluatedKey?: Record<string, unknown> },
): QueryPage<T> => {
  const items = result.Items ?? [];

  for (const item of items) {
    assertAccountItem(accountId, item);
  }

  validateCursor(accountId, result.LastEvaluatedKey, partitionAttribute, partitionValue);

  return {
    items,
    ...(result.LastEvaluatedKey === undefined ? {} : { lastEvaluatedKey: result.LastEvaluatedKey }),
  };
};

export const createScopedRepository = <T extends AccountItem>({
  accountId,
  client,
  tableName,
}: ScopedRepositoryOptions) => {
  const partitionKey = pk.account(accountId);

  const queryPage = async (
    indexName: 'GSI1' | 'GSI2' | undefined,
    partitionAttribute: 'PK' | 'GSI1PK' | 'GSI2PK',
    partitionValue: string,
    options: QueryOptions = {},
  ): Promise<QueryPage<T>> => {
    validateCursor(accountId, options.exclusiveStartKey, partitionAttribute, partitionValue);

    const sortAttribute = indexName === 'GSI1' ? 'GSI1SK' : indexName === 'GSI2' ? 'GSI2SK' : 'SK';
    const expressionValues: Record<string, string> = { ':partition': partitionValue };
    const filterByPrefix = options.sortKeyPrefix !== undefined;

    if (options.sortKeyPrefix !== undefined) {
      expressionValues[':sortPrefix'] = options.sortKeyPrefix;
    }

    const result = await client.send(
      new QueryCommand({
        TableName: tableName,
        ...(indexName === undefined ? {} : { IndexName: indexName }),
        KeyConditionExpression: filterByPrefix
          ? '#partition = :partition AND begins_with(#sort, :sortPrefix)'
          : '#partition = :partition',
        ExpressionAttributeNames: {
          '#partition': partitionAttribute,
          ...(filterByPrefix ? { '#sort': sortAttribute } : {}),
        },
        ExpressionAttributeValues: expressionValues,
        ...(options.limit === undefined ? {} : { Limit: options.limit }),
        ...(options.exclusiveStartKey === undefined ? {} : { ExclusiveStartKey: options.exclusiveStartKey }),
      }),
    );

    return pageFrom(
      accountId,
      partitionAttribute,
      partitionValue,
      result as { Items?: T[]; LastEvaluatedKey?: Record<string, unknown> },
    );
  };

  return {
    async get(sortKey: string): Promise<T | undefined> {
      const result = await client.send(
        new GetCommand({
          TableName: tableName,
          Key: { PK: partitionKey, SK: sortKey },
          ConsistentRead: true,
        }),
      );

      if (result.Item === undefined) {
        return undefined;
      }

      const item = result.Item as T;
      assertAccountItem(accountId, item);

      return item;
    },

    async put(item: T): Promise<void> {
      assertAccountItem(accountId, item);

      await client.send(
        new PutCommand({
          TableName: tableName,
          Item: item,
        }),
      );
    },

    async query(options: QueryOptions = {}): Promise<QueryPage<T>> {
      return queryPage(undefined, 'PK', partitionKey, options);
    },

    async queryGsi1(
      partitionValue: string,
      options: QueryOptions = {},
    ): Promise<QueryPage<T>> {
      if (!partitionValue.startsWith(`${partitionKey}#`)) {
        throw new Error('GSI1 partition key must be prefixed with the repository account.');
      }

      return queryPage('GSI1', 'GSI1PK', partitionValue, options);
    },

    async queryGsi2Status(status: string, options: QueryOptions = {}): Promise<QueryPage<T>> {
      return queryPage('GSI2', 'GSI2PK', gsi2.status(accountId, status), options);
    },

    async queryGsi2Email(email: string, options: QueryOptions = {}): Promise<QueryPage<T>> {
      return queryPage('GSI2', 'GSI2PK', gsi2.email(accountId, email), options);
    },

    async softDelete(sortKey: string, deletedAt: string): Promise<void> {
      await client.send(
        new UpdateCommand({
          TableName: tableName,
          Key: { PK: partitionKey, SK: sortKey },
          UpdateExpression: 'SET #deletedAt = :deletedAt, #updatedAt = :deletedAt',
          ConditionExpression: 'attribute_exists(PK) AND #accountId = :accountId',
          ExpressionAttributeNames: {
            '#accountId': 'accountId',
            '#deletedAt': 'deletedAt',
            '#updatedAt': 'updatedAt',
          },
          ExpressionAttributeValues: {
            ':accountId': accountId,
            ':deletedAt': deletedAt,
          },
        }),
      );
    },
  };
};

export type ScopedRepository<T extends AccountItem> = ReturnType<typeof createScopedRepository<T>>;
