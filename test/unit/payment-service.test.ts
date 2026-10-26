import { describe, expect, it } from 'vitest';

import { leaseService } from '../../src/modules/lease/service';
import { paymentService } from '../../src/modules/payment/service';
import { propertyService } from '../../src/modules/property/service';
import { tenantService } from '../../src/modules/tenant/service';
import type { CreateLeaseInput } from '../../src/modules/lease/types';

const createLease = async (startDate = '2026-01-01', endDate = '2026-12-31') => {
  const accountId = `payment-service-${crypto.randomUUID()}`;
  const property = await propertyService.create(
    accountId,
    {
      label: 'Payment test property',
      address: { line1: '1 Payment Road', city: 'Rabat', country: 'MA' },
      propertyType: 'apartment',
      areaSqm: null,
      rooms: null,
      purchaseDate: null,
      purchasePrice: null,
      notes: null,
      status: 'active',
    },
    `payment-property-${crypto.randomUUID()}`,
  );
  const tenant = await tenantService.create(
    accountId,
    {
      firstName: 'Samira',
      lastName: 'Test',
      email: `${crypto.randomUUID()}@example.test`,
      phone: '+212600000333',
      dateOfBirth: null,
      address: null,
    },
    `payment-tenant-${crypto.randomUUID()}`,
  );
  const input: CreateLeaseInput = {
    propertyId: property.id,
    tenantIds: [tenant.id],
    startDate,
    endDate,
    rentAmount: 700000,
    chargesAmount: 50000,
    depositAmount: 700000,
    paymentDayOfMonth: 5,
    billingFrequency: 'monthly',
    indexation: { enabled: false },
    status: 'active',
  };
  const lease = await leaseService.create(accountId, input, `payment-lease-${crypto.randomUUID()}`);

  return { accountId, lease, tenant };
};

describe('payment service', () => {
  it('records partial and full amounts, and rejects overpayment', async () => {
    const { accountId, lease } = await createLease();
    const [first, second] = await leaseService.schedule(accountId, lease.id);
    expect(first).toBeDefined();
    expect(second).toBeDefined();

    const partial = await paymentService.recordPaid(
      accountId,
      first!.id,
      first!.version,
      {
        amountPaid: 250000,
        paidAt: '2026-02-05T12:00:00.000Z',
        paymentMethod: 'bank_transfer',
      },
    );
    expect(partial).toMatchObject({ status: 'partial', amountPaid: 250000, version: 2 });
    await expect(
      paymentService.overdue(accountId, '2026-10-01'),
    ).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ id: first!.id })]));

    const paid = await paymentService.recordPaid(accountId, first!.id, partial.version, {
      amountPaid: first!.amountDue,
      paidAt: '2026-02-06T12:00:00.000Z',
      paymentMethod: 'cash',
    });
    expect(paid).toMatchObject({ status: 'paid', amountPaid: first!.amountDue, version: 3 });
    await expect(paymentService.cancel(accountId, first!.id, paid.version)).rejects.toMatchObject({
      code: 'PAYMENT_ALREADY_PAID',
    });
    await expect(
      paymentService.recordPaid(accountId, second!.id, second!.version, {
        amountPaid: second!.amountDue + 1,
        paidAt: '2026-03-05T12:00:00.000Z',
        paymentMethod: 'cash',
      }),
    ).rejects.toMatchObject({ code: 'PAYMENT_AMOUNT_EXCEEDS_DUE' });
  });

  it('moves overdue due and partial payments to late once', async () => {
    const { accountId, lease } = await createLease();
    const schedule = await leaseService.schedule(accountId, lease.id);
    const partial = await paymentService.recordPaid(accountId, schedule[0]!.id, 1, {
      amountPaid: 250000,
      paidAt: '2026-01-05T12:00:00.000Z',
      paymentMethod: 'cash',
    });

    await expect(paymentService.markOverdue(accountId, '2026-10-01')).resolves.toBe(9);
    await expect(paymentService.markOverdue(accountId, '2026-10-01')).resolves.toBe(0);
    await expect(paymentService.get(accountId, partial.id)).resolves.toMatchObject({
      status: 'late',
      amountPaid: 250000,
      version: 3,
    });
    await expect(paymentService.overdue(accountId, '2026-10-01')).resolves.toHaveLength(9);
  });

  it('creates manual payments idempotently and updates only unpaid due payments', async () => {
    const { accountId, lease, tenant } = await createLease('2026-11-01', '2027-10-31');
    const input = {
      leaseId: lease.id,
      periodStart: '2026-11-01',
      periodEnd: '2026-11-30',
      dueDate: '2026-11-05',
      amountDue: 25000,
      notes: 'Additional agreed charge',
    };
    const idempotencyKey = `payment-manual-${crypto.randomUUID()}`;
    const created = await paymentService.create(accountId, input, idempotencyKey);
    const replay = await paymentService.create(accountId, input, idempotencyKey);

    expect(created).toMatchObject({ leaseId: lease.id, tenantId: tenant.id, status: 'due', amountDue: 25000 });
    expect(replay.id).toBe(created.id);
    await expect(
      paymentService.create(accountId, { ...input, amountDue: 30000 }, idempotencyKey),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });

    const updated = await paymentService.update(accountId, created.id, created.version, {
      amountDue: 35000,
      dueDate: '2026-11-06',
    });
    expect(updated).toMatchObject({ amountDue: 35000, dueDate: '2026-11-06', version: 2 });
    await paymentService.recordPaid(accountId, updated.id, updated.version, {
      amountPaid: 35000,
      paidAt: '2026-11-06T12:00:00.000Z',
      paymentMethod: 'cash',
    });
    await expect(paymentService.create(accountId, input, idempotencyKey)).resolves.toMatchObject({
      id: created.id,
      status: 'paid',
      version: 3,
    });
  });

  it('keeps account payment lists isolated', async () => {
    const { accountId, lease } = await createLease();
    const payment = (await leaseService.schedule(accountId, lease.id))[0]!;

    await expect(paymentService.list(accountId, { limit: 100 })).resolves.toMatchObject({
      items: expect.arrayContaining([expect.objectContaining({ id: payment.id })]),
    });
    await expect(paymentService.list(`${accountId}-other`, { limit: 100 })).resolves.toMatchObject({
      items: [],
    });
  });
});
