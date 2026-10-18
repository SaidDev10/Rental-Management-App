import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { getDocumentClient } from '../../shared/db';
import { createScopedRepository, type AccountItem } from '../../shared/db';
import { pk, sk } from '../../shared/db/keys';
import type { Property } from './types';

export type PropertyRecord = AccountItem & {
  entityType: 'Property';
  propertyId: string;
  title: string;
  status: Property['status'];
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
};

export type PropertyRepository = {
  list: () => Promise<PropertyRecord[]>;
  getById: (propertyId: string) => Promise<PropertyRecord | undefined>;
  create: (input: {
    propertyId: string;
    title: string;
    status: Property['status'];
    createdAt?: string;
    updatedAt?: string;
  }) => Promise<PropertyRecord>;
};

type PropertyRepositoryOptions = {
  accountId: string;
  client?: DynamoDBDocumentClient;
  tableName?: string;
};

export const createPropertyRepository = ({
  accountId,
  client = getDocumentClient(),
  tableName = process.env.TABLE_NAME,
}: PropertyRepositoryOptions): PropertyRepository => {
  if (!tableName) {
    throw new Error('TABLE_NAME must be configured before creating property repositories.');
  }

  const repository = createScopedRepository<PropertyRecord>({ accountId, client, tableName });

  return {
    async list(): Promise<PropertyRecord[]> {
      const page = await repository.query({ sortKeyPrefix: 'PROPERTY#' });

      return page.items.filter((item) => item.entityType === 'Property');
    },

    async getById(propertyId: string): Promise<PropertyRecord | undefined> {
      return repository.get(sk.property(propertyId));
    },

    async create(input): Promise<PropertyRecord> {
      const now = new Date().toISOString();
      const record: PropertyRecord = {
        PK: pk.account(accountId),
        SK: sk.property(input.propertyId),
        accountId,
        entityType: 'Property',
        propertyId: input.propertyId,
        title: input.title,
        status: input.status,
        createdAt: input.createdAt ?? now,
        updatedAt: input.updatedAt ?? now,
      };

      await repository.put(record);

      return record;
    },
  };
};
