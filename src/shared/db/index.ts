import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { getDocumentClient } from './client';
import { createScopedRepository } from './scoped-repository';

export { createDocumentClient, getDocumentClient } from './client';
export { createAccountRepository } from './account-repository';
export { gsi1, gsi2, pk, sk } from './keys';
export { createScopedRepository } from './scoped-repository';
export type { AccountItem, QueryPage, ScopedRepository } from './scoped-repository';

type ScopedRepositoriesOptions = {
  accountId: string;
  client?: DynamoDBDocumentClient;
  tableName?: string;
};

export const createScopedRepositories = ({
  accountId,
  client = getDocumentClient(),
  tableName = process.env.TABLE_NAME,
}: ScopedRepositoriesOptions) => {
  if (!tableName) {
    throw new Error('TABLE_NAME must be configured before creating repositories.');
  }

  return {
    account: createScopedRepository({ accountId, client, tableName }),
  };
};
