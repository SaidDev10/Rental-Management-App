import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

import { AppError } from '../../src/shared/errors';
import type { AuthEnv } from '../../src/modules/auth/types';
import { createDashboardRoutes, createSummaryRoutes } from '../../src/modules/dashboard/routes';
import { dashboardService } from '../../src/modules/dashboard/service';

const exampleSummary = {
  month: '2026-10',
  totalIncome: 0,
  totalExpenses: 0,
  netYield: 0,
  occupiedProperties: 0,
  totalProperties: 0,
  latePayments: 0,
  paidPayments: 0,
  openTickets: 0,
};

const createApp = (
  overrides: Partial<typeof dashboardService> = {},
  role: 'owner' | 'super_admin' = 'owner',
) => {
  const service = { ...dashboardService, ...overrides };
  const app = new Hono<AuthEnv>();
  app.use('*', async (c, next) => {
    c.set('accountId', 'claim-account');
    c.set('userId', 'user-1');
    c.set('role', role);
    c.set('email', 'owner@example.test');
    c.set('sessionId', 'session-1');
    await next();
  });
  app.route('/dashboard', createDashboardRoutes({ service }));
  app.route('/reports', createSummaryRoutes({ service }));
  app.onError((error, c) => {
    const appError = error instanceof AppError
      ? error
      : new AppError('Unexpected server error', 500, 'INTERNAL_ERROR');

    return c.json({ error: { code: appError.code, message: appError.message } }, appError.status as 400 | 403 | 500);
  });

  return app;
};

describe('dashboard and summary routes', () => {
  it('uses the verified account context for both endpoints', async () => {
    const dashboard = vi.fn(async (accountId: string) => ({
      accountId,
      currentMonth: exampleSummary,
      previousMonth: exampleSummary,
      upcomingPayments: [],
      openMaintenanceTicketCount: 0,
    }));
    const summaryReport = vi.fn(async (accountId: string, from: string, to: string) => {
      expect(accountId).toBe('claim-account');
      expect(from).toBe('2026-01');
      expect(to).toBe('2026-02');

      return [exampleSummary];
    });
    const app = createApp({ dashboard, summaryReport });

    const dashboardResponse = await app.request('/dashboard');
    expect(dashboardResponse.status).toBe(200);
    expect(await dashboardResponse.json()).toMatchObject({ data: { accountId: 'claim-account' } });
    expect(dashboard).toHaveBeenCalledWith('claim-account');

    const reportResponse = await app.request('/reports/summary?from=2026-01&to=2026-02');
    expect(reportResponse.status).toBe(200);
    expect(summaryReport).toHaveBeenCalledWith('claim-account', '2026-01', '2026-02');
  });

  it('denies non-owner roles', async () => {
    const dashboard = vi.fn();
    const app = createApp({ dashboard }, 'super_admin');

    expect((await app.request('/dashboard')).status).toBe(403);
    expect(dashboard).not.toHaveBeenCalled();
  });

  it('rejects summary requests without a complete date range', async () => {
    const app = createApp();

    expect((await app.request('/reports/summary?from=2026-01')).status).toBe(400);
  });
});
