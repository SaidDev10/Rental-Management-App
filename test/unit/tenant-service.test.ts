import { describe, expect, it, vi } from 'vitest';

import { AppError } from '../../src/shared/errors';
import { createFieldCrypto } from '../../src/shared/crypto/field-crypto';
import type { TenantRecord, TenantRepository } from '../../src/modules/tenant/repository';
import { tenantService } from '../../src/modules/tenant/service';

const accountId = 'tenant-service-account';
const activeLease = {
  id: 'lease-1',
  propertyId: 'property-1',
  startDate: '2026-01-01',
  endDate: '2026-12-31',
  status: 'active' as const,
};

const createRecord = (overrides: Partial<TenantRecord> = {}): TenantRecord => ({
  PK: `ACCOUNT#${accountId}`,
  SK: 'TENANT#tenant-1',
  accountId,
  entityType: 'Tenant',
  schemaVersion: 1,
  id: 'tenant-1',
  firstName: 'Sara',
  lastName: 'Amrani',
  email: 'sara@example.test',
  phone: '+212600000000',
  dateOfBirth: null,
  address: null,
  idDocumentType: null,
  idDocumentLast4: null,
  sortName: 'amrani#sara',
  GSI1PK: `ACCOUNT#${accountId}#ACCOUNT#${accountId}`,
  GSI1SK: 'TENANT#amrani#sara#tenant-1',
  version: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

const createRepository = (record = createRecord(), leases = [] as typeof activeLease[]): TenantRepository => {
  let current: TenantRecord | undefined = record;

  return {
    list: async () => ({ items: current && !current.deletedAt ? [current] : [], nextCursor: undefined }),
    getById: async () => (current && !current.deletedAt ? current : undefined),
    create: async (input) => {
      current = createRecord({ ...input, id: 'tenant-created', SK: 'TENANT#tenant-created' });

      return current;
    },
    update: async (_id, expectedVersion, input) => {
      if (!current || current.version !== expectedVersion) {
        throw new Error('unexpected version');
      }
      current = {
        ...current,
        ...Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)),
        version: current.version + 1,
      };

      return current;
    },
    setIdDocument: async (_id, expectedVersion, document) => {
      if (!current || current.version !== expectedVersion) {
        throw new Error('unexpected version');
      }
      current = {
        ...current,
        idDocument: document,
        idDocumentType: document.type,
        idDocumentLast4: document.last4,
        version: current.version + 1,
      };

      return current;
    },
    getLeases: async () => leases,
    hasActiveLease: async () => leases.some((lease) => lease.status === 'active'),
    softDelete: async (_id, _version, deletedAt) => {
      if (current) {
        current = { ...current, deletedAt, version: current.version + 1 };
      }
    },
  };
};

describe('tenant service', () => {
  it('returns active lease summaries without exposing encrypted document fields', async () => {
    const record = createRecord({
      idDocumentType: 'CIN',
      idDocumentLast4: '1234',
      idDocument: { type: 'CIN', numberEnc: 'v1:opaque', last4: '1234' },
    });
    const result = await tenantService.get(accountId, record.id, createRepository(record, [activeLease]));

    expect(result.activeLeases).toEqual([activeLease]);
    expect(result.idDocumentType).toBe('CIN');
    expect(result.idDocumentLast4).toBe('1234');
    expect(result).not.toHaveProperty('idDocument');
    expect(JSON.stringify(result)).not.toContain('v1:opaque');
  });

  it('encrypts identity numbers before persistence and decrypts only through the explicit service method', async () => {
    const record = createRecord();
    const repository = createRepository(record);
    const setIdDocument = vi.spyOn(repository, 'setIdDocument');
    const fieldCrypto = createFieldCrypto(Buffer.alloc(32, 9).toString('base64'));

    const saved = await tenantService.setIdDocument(
      accountId,
      record.id,
      1,
      { type: 'CIN', number: 'AB123456', issuedAt: '2020-01-01' },
      repository,
      fieldCrypto,
    );
    expect(saved.idDocumentLast4).toBe('3456');
    expect(saved).not.toHaveProperty('idDocument');
    const storedDocument = setIdDocument.mock.calls[0]?.[2];
    expect(storedDocument?.numberEnc).toBeDefined();
    expect(storedDocument?.numberEnc).not.toContain('AB123456');

    await expect(
      tenantService.getDecryptedIdDocument(accountId, record.id, repository, fieldCrypto),
    ).resolves.toEqual({ type: 'CIN', issuedAt: '2020-01-01', number: 'AB123456' });
  });

  it('prevents deletion while any active lease is linked', async () => {
    const repository = createRepository(createRecord(), [activeLease]);
    const softDelete = vi.spyOn(repository, 'softDelete');

    await expect(tenantService.delete(accountId, 'tenant-1', 1, repository)).rejects.toMatchObject({
      status: 409,
      code: 'TENANT_HAS_ACTIVE_LEASE',
    });
    expect(softDelete).not.toHaveBeenCalled();
  });

  it('uses optimistic version checks before soft deletion', async () => {
    const repository = createRepository(createRecord({ version: 2 }));

    await expect(tenantService.delete(accountId, 'tenant-1', 1, repository)).rejects.toMatchObject({
      code: 'CONFLICT_VERSION_MISMATCH',
    });
    await expect(tenantService.delete(accountId, 'tenant-1', 2, repository)).resolves.toBeUndefined();
  });

  it('propagates repository failures rather than disguising them as success', async () => {
    const repository = {
      ...createRepository(),
      getLeases: async () => {
        throw new AppError('lease lookup failed', 500, 'INTERNAL_ERROR');
      },
    };

    await expect(tenantService.get(accountId, 'tenant-1', repository)).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
    });
  });
});