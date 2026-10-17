import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';

import { AppError } from './shared/errors';
import { authRoutes } from './modules/auth';
import { propertyRoutes, propertyService } from './modules/property';

export const app = new Hono();

app.use('*', logger());
app.use(
  '*',
  cors({
    origin: ['http://localhost:5173'],
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

app.route('/auth', authRoutes);
app.route('/properties', propertyRoutes);
app.get('/properties', async (c) => {
  const accountId = c.req.header('x-account-id');

  if (!accountId) {
    return c.json({ error: 'Missing account context' }, 401 as const);
  }

  const properties = await propertyService.list(accountId);

  return c.json({ data: properties }, 200 as const);
});
app.get('/properties/', async (c) => {
  const accountId = c.req.header('x-account-id');

  if (!accountId) {
    return c.json({ error: 'Missing account context' }, 401 as const);
  }

  const properties = await propertyService.list(accountId);

  return c.json({ data: properties }, 200 as const);
});

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
