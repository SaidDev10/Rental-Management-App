import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';

import { AppError } from './shared/errors';
import { readApiConfig } from './shared/config';
import { authMiddleware, authRoutes } from './modules/auth';
import { adminRoutes } from './modules/admin';
import type { AuthEnv } from './modules/auth/types';
import { dashboardRoutes, summaryRoutes } from './modules/dashboard';
import { documentRoutes } from './modules/document';
import { leaseRoutes } from './modules/lease';
import { maintenanceAttachmentRoutes } from './modules/maintenance/attachment-routes';
import { paymentRoutes } from './modules/payment';
import { propertyRoutes } from './modules/property';
import { tenantRoutes } from './modules/tenant';

const config = readApiConfig();

export const app = new Hono<AuthEnv>({ strict: false });

app.use('*', logger());
app.use('*', async (c, next) => {
  await next();
  c.header('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  c.header('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  c.header('Cache-Control', 'no-store');
});

app.use(
  '*',
  cors({
    origin: config.ALLOWED_ORIGINS,
    credentials: true,
    maxAge: 600,
  }),
);

app.get('/health', (c) => {
  return c.json({
    ok: true,
    service: 'rental-api',
    timestamp: new Date().toISOString(),
  });
});

app.use('/admin', authMiddleware);
app.use('/admin/*', authMiddleware);
app.use('/properties', authMiddleware);
app.use('/properties/*', authMiddleware);
app.use('/tenants', authMiddleware);
app.use('/tenants/*', authMiddleware);
app.use('/leases', authMiddleware);
app.use('/leases/*', authMiddleware);
app.use('/payments', authMiddleware);
app.use('/payments/*', authMiddleware);
app.use('/documents', authMiddleware);
app.use('/documents/*', authMiddleware);
app.use('/maintenance/tickets', authMiddleware);
app.use('/maintenance/tickets/*', authMiddleware);
app.use('/dashboard', authMiddleware);
app.use('/reports/*', authMiddleware);
app.route('/auth', authRoutes);
app.route('/admin', adminRoutes);
app.route('/dashboard', dashboardRoutes);
app.route('/reports', summaryRoutes);
app.route('/properties', propertyRoutes);
app.route('/tenants', tenantRoutes);
app.route('/leases', leaseRoutes);
app.route('/payments', paymentRoutes);
app.route('/documents', documentRoutes);
app.route('/maintenance/tickets', maintenanceAttachmentRoutes);

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
