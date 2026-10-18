import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';

import { AppError } from './shared/errors';
import { readApiConfig } from './shared/config';
import { authMiddleware, authRoutes } from './modules/auth';
import { propertyRoutes } from './modules/property';

const config = readApiConfig();

export const app = new Hono();

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

app.use('/properties/*', authMiddleware);
app.route('/auth', authRoutes);
app.route('/properties', propertyRoutes);

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
