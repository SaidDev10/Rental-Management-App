import { getDynamoDocumentClient } from '../aws/clients';
import { createScopedRepository } from './scoped-repository';

export type WorkerEntity = {
  PK: string;
  SK: string;
  accountId: string;
  entityType: string;
  [attribute: string]: unknown;
};

export const getWorkerData = (accountId: string) => {
  const tableName = process.env.TABLE_NAME;

  if (!tableName) {
    throw new Error('TABLE_NAME must be configured before accessing worker data.');
  }

  const repository = createScopedRepository<WorkerEntity>({
    accountId,
    client: getDynamoDocumentClient(),
    tableName,
  });

  return {
    ...repository,
    tableName,
  };
};
