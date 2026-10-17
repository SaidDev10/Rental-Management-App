import type { Property } from './types';

export const propertyService = {
  async list(accountId: string): Promise<Property[]> {
    return [
      {
        id: 'prop_1',
        accountId,
        title: 'Apartment Medina',
        status: 'active',
      },
    ];
  },
};
