import { describe, expect, it } from 'vitest';

import { leaseService } from '../../src/modules/lease/service';
import { validateLeaseInput } from '../../src/modules/lease/validators';
import type { CreateLeaseInput } from '../../src/modules/lease/types';
import { propertyService } from '../../src/modules/property/service';
import { tenantService } from '../../src/modules/tenant/service';

const accountId = 'lease-service-account';
const propertyInput = {
  label: 'Lease test property',
  address: { line1: '1 Lease Road', city: 'Rabat', country: 'MA' as const },
  propertyType: 'apartment' as const,
  areaSqm: null,
  rooms: null,
  purchaseDate: null,
  purchasePrice: null,
  notes: null,
  status: 'active' as const,
};

const createInput = (propertyId: string, tenantId: string): CreateLeaseInput => ({
  propertyId,
  tenantIds: [tenantId],
  startDate: '2026-01-15',
  endDate: '2026-12-31',
  rentAmount: 700000,
  chargesAmount: 50000,
  depositAmount: 700000,
  paymentDayOfMonth: 5,
  billingFrequency: 'monthly',
  indexation: { enabled: false },
  status: 'active',
});

const createFixtures = async () => {
  const property = await propertyService.create(accountId, propertyInput, `lease-property-${crypto.randomUUID()}`);
  const tenant = await tenantService.create(
    accountId,
    {
      firstName: 'Amina',
      lastName: 'Idrissi',
      email: `${crypto.randomUUID()}@example.test`,
      phone: '+212600000111',
      dateOfBirth: null,
      address: null,
    },
    `lease-tenant-${crypto.randomUUID()}`,
  );

  return { property, tenant };
};

describe('lease service', () => {
  it('creates an account-owned lease and an idempotent monthly schedule', async () => {
    const { property, tenant } = await createFixtures();
    const input = createInput(property.id, tenant.id);
    const idempotencyKey = `lease-create-${crypto.randomUUID()}`;

    const lease = await leaseService.create(accountId, input, idempotencyKey);
    const replay = await leaseService.create(accountId, input, idempotencyKey);
    const schedule = await leaseService.schedule(accountId, lease.id);

    expect(lease).toMatchObject({ accountId, propertyId: property.id, tenantIds: [tenant.id], status: 'active' });
    expect(replay.id).toBe(lease.id);
    expect(schedule).toHaveLength(12);
    expect(schedule[0]).toMatchObject({
      periodStart: '2026-01-15',
      periodEnd: '2026-02-14',
      dueDate: '2026-01-05',
      amountDue: 750000,
      tenantId: tenant.id,
      status: 'due',
    });
  });

  it('supports multiple active leases for the same property', async () => {
    const { property, tenant } = await createFixtures();
    const first = await leaseService.create(
      accountId,
      createInput(property.id, tenant.id),
      `lease-property-first-${crypto.randomUUID()}`,
    );
    const second = await leaseService.create(
      accountId,
      { ...createInput(property.id, tenant.id), startDate: '2027-01-01', endDate: '2027-12-31' },
      `lease-property-second-${crypto.randomUUID()}`,
    );

    expect(first.id).not.toBe(second.id);
    expect(second.propertyId).toBe(first.propertyId);
    await expect(propertyService.get(accountId, property.id)).resolves.toMatchObject({
      activeLeaseId: expect.stringMatching(/^01/),
    });
    await expect(propertyService.delete(accountId, property.id, property.version)).rejects.toMatchObject({
      code: 'PROPERTY_HAS_ACTIVE_LEASE',
    });
  });

  it('prevents cross-account property and tenant identifiers', async () => {
    const input = createInput('property-from-another-account', 'tenant-from-another-account');

    await expect(
      leaseService.create(accountId, input, `lease-cross-account-${crypto.randomUUID()}`),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('enforces the maximum one-year lease term and unique tenant list', async () => {
    const { property, tenant } = await createFixtures();
    const input = createInput(property.id, tenant.id);

    expect(() => validateLeaseInput({ ...input, endDate: '2027-01-16' })).toThrow(
      expect.objectContaining({ code: 'LEASE_DURATION_TOO_LONG' }),
    );
    expect(() => validateLeaseInput({ ...input, tenantIds: [tenant.id, tenant.id] })).toThrow(
      expect.objectContaining({ code: 'VALIDATION_ERROR' }),
    );
  });

  it('terminates leases and cancels future due payments, and renews with a successor', async () => {
    const { property, tenant } = await createFixtures();
    const original = await leaseService.create(
      accountId,
      createInput(property.id, tenant.id),
      `lease-lifecycle-${crypto.randomUUID()}`,
    );
    const terminated = await leaseService.terminate(
      accountId,
      original.id,
      original.version,
      '2026-06-15',
      'Tenant moved out',
    );
    const terminatedSchedule = await leaseService.schedule(accountId, original.id);
    expect(terminated.status).toBe('terminated');
    expect(terminatedSchedule.filter((payment) => payment.status === 'cancelled')).toHaveLength(6);
    await expect(
      leaseService.terminate(accountId, original.id, original.version, '2026-06-15', 'Tenant moved out'),
    ).resolves.toMatchObject({ status: 'terminated' });

    const renewalSource = await leaseService.create(
      accountId,
      createInput(property.id, tenant.id),
      `lease-renew-source-${crypto.randomUUID()}`,
    );
    const renewalKey = `lease-renew-${crypto.randomUUID()}`;
    const successor = await leaseService.renew(
      accountId,
      renewalSource.id,
      renewalSource.version,
      {},
      renewalKey,
    );
    expect(successor.status).toBe('active');
    expect(successor.startDate).toBe('2027-01-01');
    await expect(
      leaseService.renew(accountId, renewalSource.id, renewalSource.version, {}, renewalKey),
    ).resolves.toMatchObject({ id: successor.id });
    await expect(
      leaseService.renew(
        accountId,
        renewalSource.id,
        renewalSource.version,
        {},
        `lease-renew-reused-${crypto.randomUUID()}`,
      ),
    ).rejects.toMatchObject({ code: 'LEASE_STATE_CONFLICT' });
  });

  it('updates pending schedule amounts when lease terms change after the lease starts', async () => {
    const { property, tenant } = await createFixtures();
    const input = {
      ...createInput(property.id, tenant.id),
      startDate: '2020-12-01',
      endDate: '2021-11-30',
    };
    const lease = await leaseService.create(accountId, input, `lease-update-${crypto.randomUUID()}`);
    const updated = await leaseService.update(accountId, lease.id, lease.version, {
      rentAmount: 800000,
      chargesAmount: 75000,
    });
    const schedule = await leaseService.schedule(accountId, lease.id);

    expect(updated.version).toBe(2);
    expect(schedule.every((payment) => payment.amountDue === 875000)).toBe(true);
  });

  it('rejects invalid lease amounts and payment terms at the service boundary', async () => {
    const { property, tenant } = await createFixtures();
    const input = createInput(property.id, tenant.id);

    expect(() => validateLeaseInput({ ...input, rentAmount: -1 })).toThrow(
      expect.objectContaining({ code: 'VALIDATION_ERROR' }),
    );
    expect(() => validateLeaseInput({ ...input, paymentDayOfMonth: 0 })).toThrow(
      expect.objectContaining({ code: 'VALIDATION_ERROR' }),
    );
  });
});
