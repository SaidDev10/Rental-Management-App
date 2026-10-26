import { describe, expect, it } from 'vitest';

import type { PropertyRecord, PropertyRepository } from '../../src/modules/property/repository';
import { propertyService } from '../../src/modules/property/service';
import type { CreatePropertyInput } from '../../src/modules/property/types';

const propertyInput: CreatePropertyInput = {
  label: 'Medina apartment',
  address: { line1: '1 Medina Street', city: 'Marrakech', country: 'MA' },
  propertyType: 'apartment',
  areaSqm: 80,
  rooms: 3,
  purchaseDate: null,
  purchasePrice: null,
  notes: null,
  status: 'active',
};

const createRecord = (overrides: Partial<PropertyRecord> = {}): PropertyRecord => ({
  PK: 'ACCOUNT#tenant-1',
  SK: 'PROPERTY#prop_1',
  accountId: 'tenant-1',
  entityType: 'Property',
  schemaVersion: 1,
  id: 'prop_1',
  ...propertyInput,
  photoKeys: [],
  version: 1,
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
  ...overrides,
});

const createRepository = (record = createRecord()): PropertyRepository => {
  let current: PropertyRecord | undefined = record;

  return {
    list: async () => ({
      items: current && !current.deletedAt ? [current] : [],
      nextCursor: undefined,
    }),
    getById: async () => (current && !current.deletedAt ? current : undefined),
    create: async (input) => {
      current = createRecord({ ...input, id: 'prop_created', SK: 'PROPERTY#prop_created' });

      return current;
    },
    update: async (_propertyId, expectedVersion, input) => {
      if (!current || current.version !== expectedVersion) {
        throw new Error('unexpected version');
      }
      current = Object.assign(
        {},
        current,
        Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)),
        { version: current.version + 1 },
      );

      return current;
    },
    addPhoto: async (_propertyId, expectedVersion, photoKey) => {
      if (!current || current.version !== expectedVersion) {
        throw new Error('unexpected version');
      }
      current = {
        ...current,
        photoKeys: [...current.photoKeys, photoKey],
        version: current.version + 1,
      };

      return current;
    },
    findActiveLeaseId: async () => undefined,
    hasActiveLease: async () => false,
    softDelete: async (_propertyId, _version, deletedAt) => {
      if (current) {
        current = { ...current, deletedAt, version: current.version + 1 };
      }
    },
  };
};

describe('property service', () => {
  it('lists account-scoped non-deleted properties from the repository', async () => {
    const repository = createRepository();

    await expect(propertyService.list('tenant-1', { limit: 25 }, repository)).resolves.toMatchObject({
      items: [
        {
          id: 'prop_1',
          accountId: 'tenant-1',
          label: 'Medina apartment',
          status: 'active',
        },
      ],
      nextCursor: undefined,
    });
  });

  it('creates and updates properties with optimistic versioning', async () => {
    const repository = createRepository();
    const created = await propertyService.create('tenant-1', propertyInput, undefined, repository);
    const updated = await propertyService.update(
      'tenant-1',
      created.id,
      created.version,
      { label: 'Updated label' },
      repository,
    );

    expect(created.version).toBe(1);
    expect(updated).toMatchObject({ id: 'prop_created', label: 'Updated label', version: 2 });
  });

  it('prevents deleting a property with an active lease', async () => {
    const repository = {
      ...createRepository(),
      hasActiveLease: async () => true,
      softDelete: async () => {
        throw new Error('must not delete');
      },
    };

    await expect(propertyService.delete('tenant-1', 'prop_1', 1, repository)).rejects.toMatchObject({
      status: 409,
      code: 'PROPERTY_HAS_ACTIVE_LEASE',
    });
  });

  it('includes the active lease id in property detail responses', async () => {
    const repository = {
      ...createRepository(),
      findActiveLeaseId: async () => 'lease_1',
    };

    await expect(propertyService.get('tenant-1', 'prop_1', repository)).resolves.toMatchObject({
      id: 'prop_1',
      activeLeaseId: 'lease_1',
    });
  });

  it('records photos idempotently and enforces the photo limit', async () => {
    const repository = createRepository();
    const photoKey = 'accounts/tenant-1/properties/prop_1/photo.jpg';

    const first = await propertyService.addPhoto('tenant-1', 'prop_1', photoKey, repository);
    const repeated = await propertyService.addPhoto('tenant-1', 'prop_1', photoKey, repository);

    expect(first.photoKeys).toEqual([photoKey]);
    expect(first.version).toBe(2);
    expect(repeated.version).toBe(2);

    const fullRepository = createRepository(
      createRecord({ photoKeys: Array.from({ length: 20 }, (_, index) => `photo-${index}`) }),
    );
    await expect(propertyService.addPhoto('tenant-1', 'prop_1', 'photo-21', fullRepository)).rejects.toMatchObject({
      status: 409,
      code: 'PROPERTY_PHOTO_LIMIT',
    });
  });

  it('soft-deletes properties and makes them unavailable to reads', async () => {
    const repository = createRepository();

    await propertyService.delete('tenant-1', 'prop_1', 1, repository);

    await expect(propertyService.list('tenant-1', { limit: 25 }, repository)).resolves.toMatchObject({
      items: [],
      nextCursor: undefined,
    });
    await expect(propertyService.get('tenant-1', 'prop_1', repository)).rejects.toMatchObject({
      status: 404,
    });
  });
});
