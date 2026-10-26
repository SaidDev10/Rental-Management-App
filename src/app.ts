import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';

import { AppError } from './shared/errors';
import { readApiConfig } from './shared/config';
import { authMiddleware, authRoutes } from './modules/auth';
import type { AuthEnv } from './modules/auth/types';
import { leaseRoutes } from './modules/lease';
import { propertyRoutes } from './modules/property';
import { tenantRoutes } from './modules/tenant';

const config = readApiConfig();

export const app = new Hono<AuthEnv>({ strict: false });

app.use('*', logger());
app.use(
  '*',
  cors({
    origin: config.ALLOWED_ORIGINS,
    credentials: true,
  }),
);

app.get('/health', (c) => {
  return c.json({
    ok: true,
    service: 'rental-api',
    timestamp: new Date().toISOString(),
  });
});

app.use('/properties', authMiddleware);
app.use('/properties/*', authMiddleware);
app.use('/tenants', authMiddleware);
app.use('/tenants/*', authMiddleware);
app.use('/leases', authMiddleware);
app.use('/leases/*', authMiddleware);
app.route('/auth', authRoutes);
app.route('/properties', propertyRoutes);
app.route('/tenants', tenantRoutes);
app.route('/leases', leaseRoutes);

app.notFound((c) => {
  return c.json(
    { error: { code: 'NOT_FOUND', message: 'Route not found' } },
    404 as const,
  );
});

app.onError((err, c) => {
  const error = err instanceof AppError ? err : new AppError('Unexpected server error', 500, 'INTERNAL_ERROR');
  const status = Number(error.status) as 200 | 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500;

  return c.json(
    {
      error: {
        code: error.code,
        message: error.message,
      },
    },
    status,
  );
});
