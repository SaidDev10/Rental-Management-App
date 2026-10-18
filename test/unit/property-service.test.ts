import { describe, expect, it } from 'vitest';

import type { PropertyRecord } from '../../src/modules/property/repository';
import { propertyService } from '../../src/modules/property/service';

describe('property service', () => {
  it('lists account-scoped properties from the repository', async () => {
    const repository = {
      list: async (): Promise<PropertyRecord[]> => [
        {
          PK: 'ACCOUNT#tenant-1',
          SK: 'PROPERTY#prop_1',
          accountId: 'tenant-1',
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
        throw new Error('not used in this test');
      },
    };

    await expect(propertyService.list('tenant-1', repository)).resolves.toEqual([
      {
        id: 'prop_1',
        accountId: 'tenant-1',
        title: 'Apartment Medina',
        status: 'active',
      },
    ]);
  });
});
