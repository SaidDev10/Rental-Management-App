import { AppError, NotFoundError } from '../../shared/errors';
import { getSecret } from '../../shared/config/secrets';
import { createFieldCrypto } from '../../shared/crypto/field-crypto';
import { createHash } from 'node:crypto';
import { ulid } from 'ulid';
import type { QueryPage } from '../../shared/db/pagination';
import { createTenantRepository, type TenantListOptions, type TenantRecord, type TenantRepository } from './repository';
import type {
  CreateTenantInput,
  Tenant,
  TenantDetail,
  TenantIdDocumentInput,
  TenantLeaseSummary,
  UpdateTenantInput,
} from './types';

const localTenants = new Map<string, Map<string, TenantRecord>>();
const localIdempotency = new Map<string, Map<string, { requestHash: string; tenantId: string }>>();
const localLeases = new Map<string, Map<string, TenantLeaseSummary>>();

const localMode = (): boolean =>
  process.env.STAGE !== 'prod' && process.env.USE_DYNAMO_AUTH === 'false';

const localRepositoryFor = (accountId: string): TenantRepository => {
  let tenants = localTenants.get(accountId);
  if (!tenants) {
    tenants = new Map();
    localTenants.set(accountId, tenants);
  }

  const links = localLeases.get(accountId) ?? new Map<string, TenantLeaseSummary>();
  localLeases.set(accountId, links);

  return {
    async list({ limit, cursor }: TenantListOptions): Promise<QueryPage<TenantRecord>> {
      const available = [...tenants!.values()]
        .filter((tenant) => !tenant.deletedAt)
        .sort((left, right) => `${left.sortName}#${left.id}`.localeCompare(`${right.sortName}#${right.id}`));
      const cursorIndex = cursor
        ? available.findIndex((tenant) => tenant.PK === cursor.PK && tenant.SK === cursor.SK)
        : -1;
      if (cursor && cursorIndex < 0) {
        throw new AppError('Invalid tenant pagination cursor.', 400, 'VALIDATION_ERROR');
      }
      const startIndex = cursorIndex + 1;
      const items = available.slice(startIndex, startIndex + limit);
      const lastItem = items.at(-1);

      return {
        items,
        nextCursor:
          lastItem && startIndex + items.length < available.length
            ? { PK: lastItem.PK, SK: lastItem.SK, GSI1PK: lastItem.GSI1PK, GSI1SK: lastItem.GSI1SK }
            : undefined,
      };
    },
    async getById(tenantId) {
      const tenant = tenants!.get(tenantId);

      return tenant && !tenant.deletedAt ? tenant : undefined;
    },
    async create(input, idempotencyKey) {
      const requestHash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
      const records = localIdempotency.get(accountId) ?? new Map();
      const existing = records.get(idempotencyKey);
      if (existing) {
        if (existing.requestHash !== requestHash) {
          throw new AppError('Idempotency key was already used for another request.', 409, 'IDEMPOTENCY_KEY_REUSED');
        }
        const previous = tenants!.get(existing.tenantId);
        if (previous && !previous.deletedAt) {
          return previous;
        }
        throw new AppError('Idempotent tenant creation no longer exists.', 409, 'IDEMPOTENCY_RESULT_UNAVAILABLE');
      }

      const now = new Date().toISOString();
      const id = ulid();
      const sortName = `${input.lastName.trim().toLocaleLowerCase()}#${input.firstName.trim().toLocaleLowerCase()}`;
      const tenant: TenantRecord = {
        ...input,
        id,
        accountId,
        PK: `ACCOUNT#${accountId}`,
        SK: `TENANT#${id}`,
        entityType: 'Tenant',
        sortName,
        GSI1PK: `ACCOUNT#${accountId}#ACCOUNT#${accountId}`,
        GSI1SK: `TENANT#${sortName}#${id}`,
        idDocumentType: null,
        idDocumentLast4: null,
        version: 1,
        schemaVersion: 1,
        createdAt: now,
        updatedAt: now,
      };
      tenants!.set(id, tenant);
      records.set(idempotencyKey, { requestHash, tenantId: id });
      localIdempotency.set(accountId, records);

      return tenant;
    },
    async update(tenantId, expectedVersion, input) {
      const current = tenants!.get(tenantId);
      if (!current || current.deletedAt || current.version !== expectedVersion) {
        throw new AppError('Tenant version does not match or tenant is unavailable.', 409, 'CONFLICT_VERSION_MISMATCH');
      }
      const updated = Object.assign(
        {},
        current,
        Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)),
        { version: current.version + 1, updatedAt: new Date().toISOString() },
      ) as TenantRecord;
      if (input.firstName !== undefined || input.lastName !== undefined) {
        updated.sortName = `${updated.lastName.trim().toLocaleLowerCase()}#${updated.firstName.trim().toLocaleLowerCase()}`;
        updated.GSI1SK = `TENANT#${updated.sortName}#${tenantId}`;
      }
      tenants!.set(tenantId, updated);

      return updated;
    },
    async setIdDocument(tenantId, expectedVersion, document) {
      const current = tenants!.get(tenantId);
      if (!current || current.deletedAt || current.version !== expectedVersion) {
        throw new AppError('Tenant version does not match or tenant is unavailable.', 409, 'CONFLICT_VERSION_MISMATCH');
      }
      const updated: TenantRecord = {
        ...current,
        idDocument: document,
        idDocumentType: document.type,
        idDocumentLast4: document.last4,
        version: current.version + 1,
        updatedAt: new Date().toISOString(),
      };
      tenants!.set(tenantId, updated);

      return updated;
    },
    async getLeases(tenantId) {
      return [...links.entries()]
        .filter(([key, lease]) => key.startsWith(`${tenantId}#`) && lease.status === 'active')
        .map(([, lease]) => lease);
    },
    async hasActiveLease(tenantId) {
      return (await this.getLeases(tenantId)).length > 0;
    },
    async softDelete(tenantId, expectedVersion, deletedAt) {
      const current = tenants!.get(tenantId);
      if (!current || current.deletedAt || current.version !== expectedVersion) {
        throw new AppError('Tenant version does not match or tenant is unavailable.', 409, 'CONFLICT_VERSION_MISMATCH');
      }
      const deleted = { ...current, deletedAt, updatedAt: deletedAt, version: current.version + 1 };
      delete deleted.GSI1PK;
      delete deleted.GSI1SK;
      tenants!.set(tenantId, deleted);
    },
  };
};

const repositoryFor = (accountId: string): TenantRepository =>
  localMode() ? localRepositoryFor(accountId) : createTenantRepository({ accountId });

const toTenant = (record: TenantRecord): Tenant => ({
  id: record.id,
  accountId: record.accountId,
  firstName: record.firstName,
  lastName: record.lastName,
  email: record.email,
  phone: record.phone,
  dateOfBirth: record.dateOfBirth,
  address: record.address,
  idDocumentType: record.idDocumentType,
  idDocumentLast4: record.idDocumentLast4,
  version: record.version,
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
});

const getFieldCrypto = async () => {
  const parameterPrefix = process.env.SSM_PARAM_PREFIX;
  if (!parameterPrefix) {
    throw new Error('SSM_PARAM_PREFIX must be configured to encrypt tenant identity documents.');
  }
  const key = await getSecret(`${parameterPrefix}/field-encryption-key`);

  return createFieldCrypto(key);
};

export const tenantService = {
  recordLocalLeaseLinks(
    accountId: string,
    lease: TenantLeaseSummary & { tenantIds: string[] },
  ): void {
    if (!localMode()) {
      return;
    }
    const links = localLeases.get(accountId) ?? new Map<string, TenantLeaseSummary>();
    for (const tenantId of lease.tenantIds) {
      links.set(`${tenantId}#${lease.id}`, {
        id: lease.id,
        propertyId: lease.propertyId,
        startDate: lease.startDate,
        endDate: lease.endDate,
        status: lease.status,
      });
    }
    localLeases.set(accountId, links);
  },

  updateLocalLeaseStatus(accountId: string, leaseId: string, status: TenantLeaseSummary['status']): void {
    if (!localMode()) {
      return;
    }
    const links = localLeases.get(accountId);
    if (!links) {
      return;
    }
    for (const [key, lease] of links) {
      if (lease.id === leaseId) {
        links.set(key, { ...lease, status });
      }
    }
  },

  async list(accountId: string, options: TenantListOptions, repository = repositoryFor(accountId)): Promise<QueryPage<Tenant>> {
    const page = await repository.list(options);

    return { items: page.items.filter((tenant) => !tenant.deletedAt).map(toTenant), nextCursor: page.nextCursor };
  },

  async get(accountId: string, tenantId: string, repository = repositoryFor(accountId)): Promise<TenantDetail> {
    const record = await repository.getById(tenantId);
    if (!record || record.deletedAt) {
      throw new NotFoundError('Tenant not found');
    }
    const leases = await repository.getLeases(tenantId);

    return { ...toTenant(record), activeLeases: leases };
  },

  async getManyById(accountId: string, tenantIds: string[]): Promise<Tenant[]> {
    const tenants = await Promise.all(tenantIds.map((tenantId) => this.get(accountId, tenantId)));

    return tenants.map((tenant) => ({
      id: tenant.id,
      accountId: tenant.accountId,
      firstName: tenant.firstName,
      lastName: tenant.lastName,
      email: tenant.email,
      phone: tenant.phone,
      dateOfBirth: tenant.dateOfBirth,
      address: tenant.address,
      idDocumentType: tenant.idDocumentType,
      idDocumentLast4: tenant.idDocumentLast4,
      version: tenant.version,
      createdAt: tenant.createdAt,
      updatedAt: tenant.updatedAt,
    }));
  },

  async create(
    accountId: string,
    input: CreateTenantInput,
    idempotencyKey: string,
    repository = repositoryFor(accountId),
  ): Promise<Tenant> {
    return toTenant(await repository.create(input, idempotencyKey));
  },

  async update(
    accountId: string,
    tenantId: string,
    expectedVersion: number,
    input: UpdateTenantInput,
    repository = repositoryFor(accountId),
  ): Promise<Tenant> {
    return toTenant(await repository.update(tenantId, expectedVersion, input));
  },

  async setIdDocument(
    accountId: string,
    tenantId: string,
    expectedVersion: number,
    input: TenantIdDocumentInput,
    repository = repositoryFor(accountId),
    crypto?: Awaited<ReturnType<typeof getFieldCrypto>>,
  ): Promise<Tenant> {
    const fieldCrypto = crypto ?? (await getFieldCrypto());
    const trimmedNumber = input.number.trim();
    const stored = {
      type: input.type,
      numberEnc: fieldCrypto.encrypt(trimmedNumber),
      last4: trimmedNumber.slice(-4),
      ...(input.issuedAt ? { issuedAt: input.issuedAt } : {}),
      ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
      ...(input.fileKey ? { fileKey: input.fileKey } : {}),
    };

    return toTenant(await repository.setIdDocument(tenantId, expectedVersion, stored));
  },

  async getDecryptedIdDocument(
    accountId: string,
    tenantId: string,
    repository = repositoryFor(accountId),
    crypto?: Awaited<ReturnType<typeof getFieldCrypto>>,
  ): Promise<TenantIdDocumentInput> {
    const fieldCrypto = crypto ?? (await getFieldCrypto());
    const record = await repository.getById(tenantId);
    if (!record || record.deletedAt) {
      throw new NotFoundError('Tenant not found');
    }
    if (!record.idDocument) {
      throw new NotFoundError('Tenant identity document not found');
    }

    return {
      type: record.idDocument.type,
      number: fieldCrypto.decrypt(record.idDocument.numberEnc),
      ...(record.idDocument.issuedAt ? { issuedAt: record.idDocument.issuedAt } : {}),
      ...(record.idDocument.expiresAt ? { expiresAt: record.idDocument.expiresAt } : {}),
      ...(record.idDocument.fileKey ? { fileKey: record.idDocument.fileKey } : {}),
    };
  },

  async delete(
    accountId: string,
    tenantId: string,
    expectedVersion: number,
    repository = repositoryFor(accountId),
  ): Promise<void> {
    const tenant = await repository.getById(tenantId);
    if (!tenant || tenant.deletedAt) {
      throw new NotFoundError('Tenant not found');
    }
    if (tenant.version !== expectedVersion) {
      throw new AppError('Tenant version does not match.', 409, 'CONFLICT_VERSION_MISMATCH');
    }
    if (await repository.hasActiveLease(tenantId)) {
      throw new AppError('Tenant has an active lease.', 409, 'TENANT_HAS_ACTIVE_LEASE');
    }

    await repository.softDelete(tenantId, expectedVersion, new Date().toISOString());
  },
};