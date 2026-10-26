import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

import { AppError } from '../../src/shared/errors';
import type { AuthEnv } from '../../src/modules/auth/types';
import { createPaymentRoutes } from '../../src/modules/payment/routes';
import { paymentService } from '../../src/modules/payment/service';
import type { Payment } from '../../src/modules/payment/types';

const accountId = 'payment-route-account';
const payment: Payment = {
  id: 'payment-1',
  leaseId: 'lease-1',
  propertyId: 'property-1',
  tenantId: 'tenant-1',
  periodStart: '2026-01-01',
  periodEnd: '2026-01-31',
  dueDate: '2026-01-05',
  amountDue: 100000,
  amountPaid: 0,
  paymentMethod: null,
  paidAt: null,
  status: 'due',
  quittanceNumber: null,
  quittanceDocId: null,
  version: 1,
};

const createApp = (
  overrides: Partial<typeof paymentService> = {},
  role: 'owner' | 'super_admin' = 'owner',
) => {
  const service = { ...paymentService, ...overrides };
  const app = new Hono<AuthEnv>();
  app.use('*', async (c, next) => {
    c.set('accountId', accountId);
    c.set('userId', 'owner-1');
    c.set('role', role);
    c.set('email', 'owner@example.test');
    c.set('sessionId', 'session-1');
    await next();
  });
  app.route('/payments', createPaymentRoutes({ service }));
  app.onError((error, c) => {
    const appError = error instanceof AppError ? error : new AppError('Unexpected server error', 500, 'INTERNAL_ERROR');

    return c.json({ error: { code: appError.code, message: appError.message } }, appError.status as 400 | 401 | 403 | 404 | 409 | 428 | 500);
  });

  return { app, service };
};

describe('payment routes', () => {
  it('creates a manual payment and returns its version header', async () => {
    const { app, service } = createApp({ create: vi.fn(async () => payment) });
    const response = await app.request('/payments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'manual-payment-key-001' },
      body: JSON.stringify({
        leaseId: 'lease-1',
        periodStart: '2026-01-01',
        periodEnd: '2026-01-31',
        dueDate: '2026-01-05',
        amountDue: 100000,
      }),
    });

    expect(response.status).toBe(201);
    expect(response.headers.get('ETag')).toBe('1');
    expect(service.create).toHaveBeenCalledWith(
      accountId,
      expect.objectContaining({ leaseId: 'lease-1', amountDue: 100000 }),
      'manual-payment-key-001',
    );
  });

  it('requires If-Match for payment transitions and validates the payment amount', async () => {
    const recordPaid = vi.fn(async () => ({ ...payment, status: 'paid' as const }));
    const { app, service } = createApp({ recordPaid });
    const missingVersion = await app.request('/payments/payment-1/mark-paid', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        paidAt: '2026-01-05T12:00:00.000Z',
        paymentMethod: 'cash',
        amountPaid: 100000,
      }),
    });
    expect(missingVersion.status).toBe(428);
    expect(service.recordPaid).not.toHaveBeenCalled();

    const overpayment = await app.request('/payments/payment-1/mark-paid', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'If-Match': '1' },
      body: JSON.stringify({
        paidAt: '2026-01-05T12:00:00.000Z',
        paymentMethod: 'cash',
        amountPaid: 100000.5,
      }),
    });
    expect(overpayment.status).toBe(400);
  });

  it('enforces owner access and requires auth context before payment reads', async () => {
    const get = vi.fn(async () => payment);
    const { app, service } = createApp({ get }, 'super_admin');
    const forbidden = await app.request('/payments/payment-1');

    expect(forbidden.status).toBe(403);
    expect(service.get).not.toHaveBeenCalled();

    const unauthenticatedApp = new Hono();
    unauthenticatedApp.route('/payments', createPaymentRoutes({ service }));
    unauthenticatedApp.onError((error, c) => {
      const appError = error instanceof AppError ? error : new AppError('Unexpected server error', 500, 'INTERNAL_ERROR');

      return c.json({ error: { code: appError.code } }, appError.status as 400 | 401 | 403 | 404 | 500);
    });
    const unauthenticated = await unauthenticatedApp.request('/payments');
    expect(unauthenticated.status).toBe(401);
  });
});
