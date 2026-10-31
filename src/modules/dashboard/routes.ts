import { Hono, type Context } from 'hono';

import { ForbiddenError, UnauthenticatedError } from '../../shared/errors';
import type { AuthEnv } from '../auth/types';
import { dashboardService } from './service';

type DashboardRouteService = Pick<typeof dashboardService, 'dashboard'>;
type SummaryRouteService = Pick<typeof dashboardService, 'summaryReport'>;

const createAccountGetter = () => (c: Context<AuthEnv>): string => {
  const accountId = c.get('accountId');
  if (!accountId) {
    throw new UnauthenticatedError('Missing account context');
  }
  if (c.get('role') !== 'owner') {
    throw new ForbiddenError('Owner access required');
  }

  return accountId;
};

export const createDashboardRoutes = (
  { service = dashboardService }: { service?: DashboardRouteService } = {},
) => {
  const routes = new Hono<AuthEnv>();
  const getAccountId = createAccountGetter();

  routes.get('/', async (c) => c.json({ data: await service.dashboard(getAccountId(c)) }, 200));

  return routes;
};

export const createSummaryRoutes = (
  { service = dashboardService }: { service?: SummaryRouteService } = {},
) => {
  const routes = new Hono<AuthEnv>();
  const getAccountId = createAccountGetter();

  routes.get('/summary', async (c) => {
    const from = c.req.query('from') ?? '';
    const to = c.req.query('to') ?? '';
    const data = await service.summaryReport(getAccountId(c), from, to);

    return c.json({ data }, 200);
  });

  return routes;
};

export const dashboardRoutes = createDashboardRoutes();
export const summaryRoutes = createSummaryRoutes();
