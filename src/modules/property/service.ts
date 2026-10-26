import { ulid } from 'ulid';

import { AppError, NotFoundError } from '../../shared/errors';
import { pk, sk } from '../../shared/db/keys';
import type { QueryPage } from '../../shared/db/pagination';
import { createPropertyRepository, type PropertyListOptions, type PropertyRecord, type PropertyRepository } from './repository';
import { PROPERTY_PHOTO_LIMIT, type CreatePropertyInput, type Property, type PropertyDetail, type UpdatePropertyInput } from './types';

const localProperties = new Map<string, Map<string, PropertyRecord>>();
const localIdempotencyKeys = new Map<string, Map<string, { requestBody: string; propertyId: string }>>();
const localLeases = new Map<string, Map<string, Map<string, 'draft' | 'active' | 'terminated' | 'expired'>>>();

const getLocalProperties = (accountId: string): Map<string, PropertyRecord> => {
  let properties = localProperties.get(accountId);
  if (!properties) {
    properties = new Map();
    localProperties.set(accountId, properties);
  }

  if (accountId === 'demo-account' && properties.size === 0) {
    const now = '2024-01-01T00:00:00.000Z';
    const demoProperty: PropertyRecord = {
      PK: pk.account(accountId),
      SK: sk.property('prop_1'),
      accountId,
      entityType: 'Property',
      schemaVersion: 1,
      id: 'prop_1',
      label: 'Apartment Medina',
      address: { line1: '1 Medina Street', city: 'Marrakech', country: 'MA' },
      propertyType: 'apartment',
      areaSqm: null,
      rooms: null,
      purchaseDate: null,
      purchasePrice: null,
      notes: null,
      photoKeys: [],
      status: 'active',
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    properties.set(demoProperty.id, demoProperty);
  }

  return properties;
};

const isLocalAuthMode = (): boolean =>
  process.env.STAGE !== 'prod' && process.env.USE_DYNAMO_AUTH === 'false';

const createLocalRepository = (accountId: string): PropertyRepository => {
  const properties = getLocalProperties(accountId);

  return {
    async list({ limit, cursor }: PropertyListOptions): Promise<QueryPage<PropertyRecord>> {
      const available = [...properties.values()]
        .filter((property) => !property.deletedAt)
        .sort((left, right) => left.SK.localeCompare(right.SK));
      const cursorIndex = cursor
        ? available.findIndex((property) => property.PK === cursor.PK && property.SK === cursor.SK)
        : -1;
      if (cursor && cursorIndex < 0) {
        throw new AppError('Invalid property pagination cursor.', 400, 'VALIDATION_ERROR');
      }

      const startIndex = cursorIndex + 1;
      const page = available.slice(startIndex, startIndex + limit);
      const lastProperty = page.at(-1);

      return {
        items: page,
        nextCursor:
          lastProperty && startIndex + page.length < available.length
            ? { PK: lastProperty.PK, SK: lastProperty.SK }
            : undefined,
      };
    },
    async getById(propertyId) {
      const property = properties.get(propertyId);

      return property && !property.deletedAt ? property : undefined;
    },
    async create(input, idempotencyKey) {
      const idempotencyRecords = localIdempotencyKeys.get(accountId) ?? new Map();
      if (idempotencyKey) {
        const previous = idempotencyRecords.get(idempotencyKey);
        if (previous) {
          if (previous.requestBody !== JSON.stringify(input)) {
            throw new AppError('Idempotency key was already used for another request.', 409, 'IDEMPOTENCY_KEY_REUSED');
          }
          const previousProperty = properties.get(previous.propertyId);
          if (previousProperty && !previousProperty.deletedAt) {
            return previousProperty;
          }
          throw new AppError('Idempotent property creation no longer exists.', 409, 'IDEMPOTENCY_RESULT_UNAVAILABLE');
        }
      }

      const now = new Date().toISOString();
      const id = ulid();
      const property: PropertyRecord = {
        ...input,
        photoKeys: [],
        id,
        accountId,
        PK: pk.account(accountId),
        SK: sk.property(id),
        entityType: 'Property',
        GSI2PK: `${pk.account(accountId)}#STATUS#${input.status}`,
        GSI2SK: `PROPERTY#${id}`,
        schemaVersion: 1,
        version: 1,
        createdAt: now,
        updatedAt: now,
      };
      properties.set(id, property);
      if (idempotencyKey) {
        idempotencyRecords.set(idempotencyKey, { requestBody: JSON.stringify(input), propertyId: id });
        localIdempotencyKeys.set(accountId, idempotencyRecords);
      }

      return property;
    },
    async update(propertyId, expectedVersion, input) {
      const current = properties.get(propertyId);
      if (!current || current.deletedAt || current.version !== expectedVersion) {
        throw new AppError('Property version does not match or property is unavailable.', 409, 'CONFLICT_VERSION_MISMATCH');
      }

      const definedInput = Object.fromEntries(
        Object.entries(input).filter(([, value]) => value !== undefined),
      );
      const updated: PropertyRecord = Object.assign({}, current, definedInput, {
        version: current.version + 1,
        updatedAt: new Date().toISOString(),
      });
      if (input.status !== undefined) {
        updated.GSI2PK = `${pk.account(accountId)}#STATUS#${input.status}`;
        updated.GSI2SK = `PROPERTY#${propertyId}`;
      }
      properties.set(propertyId, updated);

      return updated;
    },
    async hasActiveLease(propertyId) {
      return [...(localLeases.get(accountId)?.get(propertyId)?.values() ?? [])].includes('active');
    },
    async findActiveLeaseId(propertyId) {
      const leases = localLeases.get(accountId)?.get(propertyId);

      return [...(leases ?? [])].find(([, status]) => status === 'active')?.[0];
    },
    async addPhoto(propertyId, expectedVersion, photoKey) {
      const current = properties.get(propertyId);
      if (!current || current.deletedAt || current.version !== expectedVersion) {
        throw new AppError('Property version does not match or property is unavailable.', 409, 'CONFLICT_VERSION_MISMATCH');
      }
      if (current.photoKeys.includes(photoKey)) {
        return current;
      }
      if (current.photoKeys.length >= PROPERTY_PHOTO_LIMIT) {
        throw new AppError('A property cannot have more than 20 photos.', 409, 'PROPERTY_PHOTO_LIMIT');
      }

      const updated: PropertyRecord = {
        ...current,
        photoKeys: [...current.photoKeys, photoKey],
        version: current.version + 1,
        updatedAt: new Date().toISOString(),
      };
      properties.set(propertyId, updated);

      return updated;
    },
    async softDelete(propertyId, expectedVersion, deletedAt) {
      const current = properties.get(propertyId);
      if (!current || current.deletedAt || current.version !== expectedVersion) {
        throw new AppError('Property version does not match or property is unavailable.', 409, 'CONFLICT_VERSION_MISMATCH');
      }

      const deletedProperty = { ...current };
      delete deletedProperty.GSI2PK;
      delete deletedProperty.GSI2SK;
      properties.set(propertyId, {
        ...deletedProperty,
        deletedAt,
        updatedAt: deletedAt,
        version: current.version + 1,
      });
    },
  };
};

const repositoryFor = (accountId: string): PropertyRepository =>
  isLocalAuthMode()
    ? createLocalRepository(accountId)
    : createPropertyRepository({ accountId });

const toProperty = (record: PropertyRecord): Property => ({
  id: record.id,
  accountId: record.accountId,
  label: record.label,
  address: record.address,
  propertyType: record.propertyType,
  areaSqm: record.areaSqm,
  rooms: record.rooms,
  purchaseDate: record.purchaseDate,
  purchasePrice: record.purchasePrice,
  notes: record.notes,
  photoKeys: record.photoKeys,
  status: record.status,
  version: record.version,
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
});

export const propertyService = {
  recordLocalLeaseLink(
    accountId: string,
    lease: { id: string; propertyId: string; status: 'draft' | 'active' | 'terminated' | 'expired' },
  ): void {
    if (!isLocalAuthMode()) {
      return;
    }
    const properties = localLeases.get(accountId) ?? new Map();
    const leases = properties.get(lease.propertyId) ?? new Map();
    leases.set(lease.id, lease.status);
    properties.set(lease.propertyId, leases);
    localLeases.set(accountId, properties);
  },

  updateLocalLeaseStatus(
    accountId: string,
    leaseId: string,
    status: 'draft' | 'active' | 'terminated' | 'expired',
  ): void {
    if (!isLocalAuthMode()) {
      return;
    }
    const properties = localLeases.get(accountId);
    if (!properties) {
      return;
    }
    for (const leases of properties.values()) {
      if (leases.has(leaseId)) {
        leases.set(leaseId, status);
      }
    }
  },

  async list(
    accountId: string,
    options: PropertyListOptions,
    repository = repositoryFor(accountId),
  ): Promise<QueryPage<Property>> {
    const page = await repository.list(options);

    return {
      items: page.items.filter((record) => !record.deletedAt).map(toProperty),
      nextCursor: page.nextCursor,
    };
  },

  async get(accountId: string, propertyId: string, repository = repositoryFor(accountId)): Promise<PropertyDetail> {
    const record = await repository.getById(propertyId);
    if (!record || record.deletedAt) {
      throw new NotFoundError('Property not found');
    }

    return {
      ...toProperty(record),
      activeLeaseId: (await repository.findActiveLeaseId(propertyId)) ?? null,
    };
  },

  async create(
    accountId: string,
    input: CreatePropertyInput,
    idempotencyKey?: string,
    repository = repositoryFor(accountId),
  ): Promise<Property> {
    return toProperty(await repository.create(input, idempotencyKey));
  },

  async update(
    accountId: string,
    propertyId: string,
    expectedVersion: number,
    input: UpdatePropertyInput,
    repository = repositoryFor(accountId),
  ): Promise<Property> {
    return toProperty(await repository.update(propertyId, expectedVersion, input));
  },

  async addPhoto(
    accountId: string,
    propertyId: string,
    photoKey: string,
    repository = repositoryFor(accountId),
  ): Promise<Property> {
    const record = await repository.getById(propertyId);
    if (!record || record.deletedAt) {
      throw new NotFoundError('Property not found');
    }
    if (record.photoKeys.includes(photoKey)) {
      return toProperty(record);
    }
    if (record.photoKeys.length >= PROPERTY_PHOTO_LIMIT) {
      throw new AppError('A property cannot have more than 20 photos.', 409, 'PROPERTY_PHOTO_LIMIT');
    }

    try {
      return toProperty(await repository.addPhoto(propertyId, record.version, photoKey));
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== 'CONFLICT_VERSION_MISMATCH') {
        throw error;
      }

      const latest = await repository.getById(propertyId);
      if (latest && !latest.deletedAt && latest.photoKeys.includes(photoKey)) {
        return toProperty(latest);
      }

      throw error;
    }
  },

  async delete(
    accountId: string,
    propertyId: string,
    expectedVersion: number,
    repository = repositoryFor(accountId),
  ): Promise<void> {
    const property = await repository.getById(propertyId);
    if (!property || property.deletedAt) {
      throw new NotFoundError('Property not found');
    }

    if (property.version !== expectedVersion) {
      throw new AppError('Property version does not match.', 409, 'CONFLICT_VERSION_MISMATCH');
    }

    if (await repository.hasActiveLease(propertyId)) {
      throw new AppError('Property has an active lease.', 409, 'PROPERTY_HAS_ACTIVE_LEASE');
    }

    await repository.softDelete(propertyId, expectedVersion, new Date().toISOString());
  },
};
