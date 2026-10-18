import { createPropertyRepository, type PropertyRecord } from './repository';
import type { Property } from './types';

const fallbackPropertyRepository = {
  list: async (): Promise<PropertyRecord[]> => [
    {
      PK: 'ACCOUNT#demo-account',
      SK: 'PROPERTY#prop_1',
      accountId: 'demo-account',
      entityType: 'Property',
      propertyId: 'prop_1',
      title: 'Apartment Medina',
      status: 'active',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    },
  ],
  getById: async () => undefined,
  create: async () => {
    throw new Error('not implemented in fallback repository');
  },
};

export const propertyService = {
  async list(
    accountId: string,
    repository = accountId === 'demo-account' ? fallbackPropertyRepository : createPropertyRepository({ accountId }),
  ): Promise<Property[]> {
    const records = await repository.list();

    return records.map((record: PropertyRecord) => ({
      id: record.propertyId,
      accountId: record.accountId,
      title: record.title,
      status: record.status,
    }));
  },
};
