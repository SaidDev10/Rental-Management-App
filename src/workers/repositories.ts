import { getDynamoDocumentClient } from '../shared/aws/clients';
import { createJobRepository } from './job-repository';

export const createWorkerJobRepository = (accountId: string) => {
  const tableName = process.env.TABLE_NAME;

  if (!tableName) {
    throw new Error('TABLE_NAME must be configured before creating worker repositories.');
  }

  return createJobRepository({
    accountId,
    client: getDynamoDocumentClient(),
    tableName,
  });
};
