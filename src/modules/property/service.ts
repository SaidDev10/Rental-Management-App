import { createPropertyRepository, type PropertyRecord } from './repository';
import type { Property } from './types';

export const propertyService = {
  async list(
    accountId: string,
    repository = createPropertyRepository({ accountId }),
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
