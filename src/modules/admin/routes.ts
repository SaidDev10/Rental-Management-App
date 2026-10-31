import { Hono, type Context } from 'hono';
import { z } from 'zod';

import { ForbiddenError, UnauthenticatedError } from '../../shared/errors';
import type { AuthEnv } from '../auth/types';
import { adminService, type AdminActor } from './service';

const accountIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const querySchema = z.object({
  accountId: accountIdSchema,
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
  action: z.string().min(1).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  nextToken: z.string().min(1).max(4096).optional(),
});

type AdminRouteService = Pick<typeof adminService,
  'listAccounts' | 'getAccount' | 'impersonate' | 'listAudit' | 'health' | 'disableAccount'>;

const actorFrom = (c: Context<AuthEnv>): AdminActor => {
  const userId = c.get('userId');
  const role = c.get('role');
  const email = c.get('email');
  const sessionId = c.get('sessionId');
  const accountId = c.get('accountId');
  if (!userId || !role || !email || !sessionId || !accountId) {
    throw new UnauthenticatedError('Missing admin session context');
  }
  // @hono/aws-lambda provides requestContext directly in Hono's bindings.
  const lambdaContext = c.env as unknown as { requestContext?: { http?: { sourceIp?: string }; identity?: { sourceIp?: string }; requestId?: string } } | undefined;
  const ip = lambdaContext?.requestContext?.http?.sourceIp ?? lambdaContext?.requestContext?.identity?.sourceIp;
  const requestId = lambdaContext?.requestContext?.requestId ?? c.req.header('x-request-id');
  const userAgent = c.req.header('user-agent');

  return {
    userId, role, email, sessionId, accountId,
    ...(ip ? { ip } : {}),
    ...(requestId ? { requestId } : {}),
    ...(userAgent ? { userAgent } : {}),
  };
};

const requireSuperAdmin = async (c: Context<AuthEnv>, next: () => Promise<void>): Promise<void> => {
  if (c.get('impersonating')) throw new ForbiddenError('Admin routes are unavailable during impersonation');
  if (c.get('role') !== 'super_admin') throw new ForbiddenError('Super-admin access required');
  await next();
};

export const createAdminRoutes = (
  { service = adminService }: { service?: AdminRouteService } = {},
) => {
  const routes = new Hono<AuthEnv>();
  routes.use('*', requireSuperAdmin);

  routes.get('/accounts', async (c) => {
    const limitParam = c.req.query('limit');
    const limit = limitParam === undefined ? 50 : Number(limitParam);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'limit must be an integer from 1 to 100' } }, 400);
    }
    const nextToken = c.req.query('nextToken');

    return c.json({ data: await service.listAccounts(limit, nextToken, actorFrom(c)) }, 200);
  });

  routes.get('/accounts/:id', async (c) => {
    const parsedId = accountIdSchema.safeParse(c.req.param('id'));
    if (!parsedId.success) return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid account id' } }, 400);

    return c.json({ data: await service.getAccount(parsedId.data, actorFrom(c)) }, 200);
  });

  routes.post('/impersonate/:accountId', async (c) => {
    const parsedId = accountIdSchema.safeParse(c.req.param('accountId'));
    if (!parsedId.success) return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid account id' } }, 400);

    return c.json(await service.impersonate(parsedId.data, actorFrom(c)), 200);
  });

  routes.get('/audit', async (c) => {
    const parsed = querySchema.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid audit query' } }, 400);
    if (parsed.data.from && parsed.data.to && parsed.data.from > parsed.data.to) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'from must not be later than to' } }, 400);
    }
    const input = { accountId: parsed.data.accountId, limit: parsed.data.limit, ...(parsed.data.from ? { from: parsed.data.from } : {}), ...(parsed.data.to ? { to: parsed.data.to } : {}), ...(parsed.data.action ? { action: parsed.data.action } : {}), ...(parsed.data.nextToken ? { nextToken: parsed.data.nextToken } : {}) };

    return c.json({ data: await service.listAudit(input, actorFrom(c)) }, 200);
  });

  routes.get('/health', async (c) => c.json({ data: await service.health() }, 200));

  routes.post('/accounts/:id/disable', async (c) => {
    const parsedId = accountIdSchema.safeParse(c.req.param('id'));
    if (!parsedId.success) return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid account id' } }, 400);

    return c.json({ data: await service.disableAccount(parsedId.data, actorFrom(c)) }, 200);
  });

  return routes;
};

export const adminRoutes = createAdminRoutes();