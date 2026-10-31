import { randomUUID } from 'node:crypto';

import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import { AppError } from '../../src/shared/errors';
import { getClientIp, rateLimitMiddleware } from '../../src/shared/security/rate-limit';

describe('rate limit middleware', () => {
  it('uses the API Gateway source IP instead of caller-controlled forwarding headers', async () => {
    const app = new Hono();
    app.get('/ip', (context) => context.text(getClientIp(context)));
    const response = await app.fetch(
      new Request('http://localhost/ip', { headers: { 'X-Forwarded-For': '198.51.100.10' } }),
      { requestContext: { http: { sourceIp: '203.0.113.20' } } },
    );

    expect(await response.text()).toBe('203.0.113.20');
  });

  it('allows the configured number of requests and rejects the next request per identity', async () => {
    const app = new Hono();
    const identity = randomUUID();
    app.post(
      '/login',
      rateLimitMiddleware({
        scope: 'test-login',
        limit: 2,
        windowSeconds: 60,
        identity: (context) => context.req.header('x-forwarded-for') ?? 'unknown',
      }),
      (context) => context.text('ok'),
    );
    app.onError((error, context) => {
      const appError = error instanceof AppError ? error : new AppError('Unexpected error', 500, 'INTERNAL_ERROR');

      return context.json({ error: { code: appError.code } }, appError.status as 429 | 500);
    });

    const request = () => app.request('/login', {
      method: 'POST',
      headers: { 'X-Forwarded-For': identity },
    });
    expect((await request()).status).toBe(200);
    expect((await request()).status).toBe(200);
    const limited = await request();
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ error: { code: 'RATE_LIMITED' } });
  });
});
