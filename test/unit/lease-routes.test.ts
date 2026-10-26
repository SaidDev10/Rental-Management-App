import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

import { AppError } from '../../src/shared/errors';
import type { AuthEnv } from '../../src/modules/auth/types';
import { createLeaseRoutes } from '../../src/modules/lease/routes';
import { leaseService } from '../../src/modules/lease/service';
import type { Lease, LeaseDetail } from '../../src/modules/lease/types';

const accountId = 'lease-route-account';
const lease: Lease = {
  id: 'lease-1',
  accountId,
  propertyId: 'property-1',
  tenantIds: ['tenant-1'],
  startDate: '2026-01-01',
  endDate: '2026-12-31',
  rentAmount: 700000,
  chargesAmount: 50000,
  depositAmount: 700000,
  paymentDayOfMonth: 5,
  billingFrequency: 'monthly',
  indexation: { enabled: false },
  status: 'active',
  terminatedAt: null,
  terminationReason: null,
  version: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const createApp = (
  overrides: Partial<typeof leaseService> = {},
  role: 'owner' | 'super_admin' = 'owner',
) => {
  const service = { ...leaseService, ...overrides };
  const app = new Hono<AuthEnv>();
  app.use('*', async (c, next) => {
    c.set('accountId', accountId);
    c.set('userId', 'owner-1');
    c.set('role', role);
    c.set('email', 'owner@example.test');
    c.set('sessionId', 'session-1');
    await next();
  });
  app.route('/leases', createLeaseRoutes({ service }));
  app.onError((error, c) => {
    const appError = error instanceof AppError ? error : new AppError('Unexpected server error', 500, 'INTERNAL_ERROR');

    return c.json({ error: { code: appError.code, message: appError.message } }, appError.status as 400 | 401 | 403 | 404 | 409 | 428 | 500);
  });

  return { app, service };
};

describe('lease routes', () => {
  it('creates a lease with an idempotency key and version response header', async () => {
    const { app, service } = createApp({ create: vi.fn(async () => lease) });
    const response = await app.request('/leases', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'lease-create-1' },
      body: JSON.stringify({
        propertyId: 'property-1',
        tenantIds: ['tenant-1'],
        startDate: '2026-01-01',
        endDate: '2026-12-31',
        rentAmount: 700000,
        chargesAmount: 50000,
        depositAmount: 700000,
        paymentDayOfMonth: 5,
        billingFrequency: 'monthly',
      }),
    });

    expect(response.status).toBe(201);
    expect(response.headers.get('ETag')).toBe('1');
    expect(service.create).toHaveBeenCalledWith(
      accountId,
      expect.objectContaining({ propertyId: 'property-1', indexation: { enabled: false }, status: 'active' }),
      'lease-create-1',
    );
  });

  it('requires If-Match for patch and termination and bounds pagination', async () => {
    const { app, service } = createApp({
      list: vi.fn(async () => ({ items: [lease] })),
      update: vi.fn(async () => lease),
    });
    const listResponse = await app.request('/leases?limit=200');
    expect(listResponse.status).toBe(200);
    expect(service.list).toHaveBeenCalledWith(accountId, { limit: 100 });

    const patchResponse = await app.request('/leases/lease-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rentAmount: 800000 }),
    });
    expect(patchResponse.status).toBe(428);
    expect(service.update).not.toHaveBeenCalled();
  });

  it('requires owner role on the lease API', async () => {
    const get = vi.fn(async () => ({ ...lease, property: {} } as LeaseDetail));
    const { app, service } = createApp({ get }, 'super_admin');

    const response = await app.request('/leases/lease-1');

    expect(response.status).toBe(403);
    expect(service.get).not.toHaveBeenCalled();
  });
});
