import { GetCommand, PutCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { pk, sk } from './keys';
import type { AccountItem } from './scoped-repository';

export type AccountRepositoryOptions = {
  accountId: string;
  client: DynamoDBDocumentClient;
  tableName: string;
};

export const createAccountRepository = ({
  accountId,
  client,
  tableName,
}: AccountRepositoryOptions) => {
  const partitionKey = pk.account(accountId);

  return {
    async get<T extends AccountItem>(sortKey: string): Promise<T | undefined> {
      const result = await client.send(
        new GetCommand({
          TableName: tableName,
          Key: { PK: partitionKey, SK: sortKey },
          ConsistentRead: true,
        }),
      );
      const item = result.Item as T | undefined;

      if (item && (item.PK !== partitionKey || item.accountId !== accountId)) {
        throw new Error('DynamoDB item does not belong to this account.');
      }

      return item;
    },

    async put<T extends AccountItem>(item: T): Promise<void> {
      if (item.PK !== partitionKey || item.accountId !== accountId) {
        throw new Error('DynamoDB item must belong to this account.');
      }

      await client.send(new PutCommand({ TableName: tableName, Item: item }));
    },

    partitionKey,
    metaKey: sk.meta(),
  };
};
