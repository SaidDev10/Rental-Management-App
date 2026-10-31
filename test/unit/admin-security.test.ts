import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { app as apiApp } from '../../src/app';
import { authMiddleware } from '../../src/modules/auth/middleware';
import { createAuthRepository } from '../../src/modules/auth/repository';
import { signAccessToken, signImpersonationToken, verifyAccessToken } from '../../src/modules/auth/tokens';
import type { AuthEnv } from '../../src/modules/auth/types';
import { createAdminRoutes } from '../../src/modules/admin/routes';
import { createAdminService } from '../../src/modules/admin/service';
import type { AdminRepository } from '../../src/modules/admin/repository';

const adminActor = {
  userId: 'admin-user', role: 'super_admin' as const, email: 'admin@example.test',
  sessionId: 'admin-session', accountId: 'admin-account',
};

const fakeRepository = (overrides: Partial<AdminRepository> = {}): AdminRepository => ({
  listAccounts: vi.fn(async () => ({ items: [] })),
  getAccount: vi.fn(async (id: string) => ({ id, name: 'Rental', status: 'active' })),
  writeAudit: vi.fn(async () => undefined),
  listAudit: vi.fn(async () => ({ items: [] })),
  disableAccount: vi.fn(async (id: string) => ({ id, name: 'Rental', status: 'disabled' })),
  health: vi.fn(async () => ({ table: { name: 'test', status: 'ACTIVE' }, queues: [], lambdaErrors: [], generatedAt: '' })),
  tryWriteAudit: vi.fn(async () => undefined),
  ...overrides,
}) as AdminRepository;

const createRouteApp = (role: 'owner' | 'super_admin', impersonating = false) => {
  const app = new Hono<AuthEnv>();
  app.use('*', async (c, next) => {
    c.set('accountId', 'admin-account');
    c.set('userId', 'admin-user');
    c.set('role', role);
    c.set('email', 'admin@example.test');
    c.set('sessionId', 'admin-session');
    c.set('impersonating', impersonating);
    await next();
  });
  app.route('/admin', createAdminRoutes({
    service: {
      listAccounts: vi.fn(async () => ({ items: [] })),
      getAccount: vi.fn(async (id) => ({ id, name: 'Rental', status: 'active' })),
      impersonate: vi.fn(async (id) => ({ accessToken: 'signed', tokenType: 'Bearer' as const, expiresIn: 1800, accountId: id, readOnly: true })),
      listAudit: vi.fn(async () => ({ items: [] })),
      health: vi.fn(async () => ({ table: { name: 'test', status: 'ACTIVE' }, queues: [], lambdaErrors: [], generatedAt: '' })),
      disableAccount: vi.fn(async (id) => ({ id, name: 'Rental', status: 'disabled' })),
    },
  }));
  app.onError((error, c) => c.json({ error: error.message }, error instanceof Error && 'status' in error ? Number(error.status) as 401 | 403 | 404 : 500));

  return app;
};

afterEach(() => {
  process.env.USE_DYNAMO_AUTH = 'false';
});

describe('P8 admin security', () => {
  it('mounts admin endpoints behind verified bearer authentication', async () => {
    expect((await apiApp.request('/admin/accounts')).status).toBe(401);
  });

  it('requires a super-admin role and denies admin access during impersonation', async () => {
    expect((await createRouteApp('owner').request('/admin/accounts')).status).toBe(403);
    expect((await createRouteApp('super_admin', true).request('/admin/accounts')).status).toBe(403);
    expect((await createRouteApp('super_admin').request('/admin/accounts')).status).toBe(200);
  });

  it('includes trusted Lambda request context in admin audit actor metadata', async () => {
    const getAccount = vi.fn(async (id: string) => ({ id, name: 'Rental', status: 'active' }));
    const app = new Hono<AuthEnv>();
    app.use('*', async (c, next) => {
      c.set('accountId', 'admin-account');
      c.set('userId', 'admin-user');
      c.set('role', 'super_admin');
      c.set('email', 'admin@example.test');
      c.set('sessionId', 'admin-session');
      c.set('impersonating', false);
      await next();
    });
    app.route('/admin', createAdminRoutes({
      service: {
        listAccounts: vi.fn(async () => ({ items: [] })),
        getAccount,
        impersonate: vi.fn(async () => ({ accessToken: 'signed', tokenType: 'Bearer' as const, expiresIn: 1800, accountId: 'target', readOnly: true })),
        listAudit: vi.fn(async () => ({ items: [] })),
        health: vi.fn(async () => ({ table: { name: 'test', status: 'ACTIVE' }, queues: [], lambdaErrors: [], generatedAt: '' })),
        disableAccount: vi.fn(async (id) => ({ id, name: 'Rental', status: 'disabled' })),
      },
    }));

    const response = await app.request('/admin/accounts/target', {
      headers: { 'user-agent': 'admin-test-agent' },
    }, { requestContext: { http: { sourceIp: '203.0.113.8' }, requestId: 'gateway-request-1' } } as never);

    expect(response.status).toBe(200);
    expect(getAccount).toHaveBeenCalledWith('target', expect.objectContaining({
      ip: '203.0.113.8', requestId: 'gateway-request-1', userAgent: 'admin-test-agent',
    }));
  });

  it('issues a 30-minute read-only token bound to the admin session only after audit succeeds', async () => {
    const repository = fakeRepository();
    const service = createAdminService({ repository });
    const result = await service.impersonate('target-account', adminActor);
    const claims = await verifyAccessToken(result.accessToken);

    expect(claims).toMatchObject({
      sub: adminActor.userId,
      account_id: 'target-account',
      role: 'owner',
      sid: adminActor.sessionId,
      imp: true,
    });
    expect(claims.exp - claims.iat).toBe(1800);
    expect(repository.writeAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'ADMIN_IMPERSONATE', accountId: 'target-account', targetId: 'target-account', outcome: 'success',
    }));
  });

  it('audits but refuses disabled-account impersonation', async () => {
    const repository = fakeRepository({
      getAccount: vi.fn(async (id: string) => ({ id, name: 'Rental', status: 'disabled' })),
    });
    const service = createAdminService({ repository });
    await expect(service.impersonate('target-account', adminActor)).rejects.toMatchObject({ status: 403 });
    expect(repository.tryWriteAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'ADMIN_IMPERSONATE', outcome: 'failure' }));
  });
  it('does not return an impersonation token if the mandatory audit write fails', async () => {
    const repository = fakeRepository({ writeAudit: vi.fn(async () => { throw new Error('audit unavailable'); }) });
    const service = createAdminService({ repository });
    await expect(service.impersonate('target-account', adminActor)).rejects.toThrow('audit unavailable');
  });

  it('rejects outstanding owner access tokens after their session is revoked', async () => {
    process.env.STAGE = 'test';
    process.env.USE_DYNAMO_AUTH = 'false';
    const userId = `owner-${crypto.randomUUID()}`;
    const sessionId = `session-${crypto.randomUUID()}`;
    const repository = createAuthRepository();
    await repository.createSession({
      userId, accountId: 'owner-account', email: 'owner@example.test', role: 'owner',
      sessionId, familyId: `family-${sessionId}`, refreshTokenHash: `hash-${sessionId}`,
    });
    const token = await signAccessToken({ userId, accountId: 'owner-account', email: 'owner@example.test', role: 'owner', sessionId });
    const app = new Hono<AuthEnv>();
    app.use('*', authMiddleware);
    app.get('/', (c) => c.json({ authenticated: true }));
    app.onError((error, c) => c.json({ error: error.message }, error instanceof Error && 'status' in error ? Number(error.status) as 401 : 500));
    const headers = { Authorization: `Bearer ${token}` };
    expect((await app.request('/', { headers })).status).toBe(200);
    await repository.revokeSession(userId, sessionId);
    expect((await app.request('/', { headers })).status).toBe(401);
  });
  it('enforces impersonation read-only access in verified-token middleware', async () => {
    process.env.STAGE = 'test';
    process.env.USE_DYNAMO_AUTH = 'false';
    const sessionId = `session-${crypto.randomUUID()}`;
    await createAuthRepository().createSession({
      userId: 'admin-user-test', accountId: 'admin-account', email: 'admin@example.test',
      role: 'super_admin', sessionId, familyId: `family-${sessionId}`, refreshTokenHash: `hash-${sessionId}`,
    });
    const token = await signImpersonationToken({
      userId: 'admin-user-test', accountId: 'target-account', email: 'admin@example.test', sessionId,
    });
    const app = new Hono<AuthEnv>();
    app.use('/protected/*', authMiddleware);
    app.get('/protected/read', (c) => c.json({ accountId: c.get('accountId'), impersonating: c.get('impersonating') }));
    app.post('/protected/write', (c) => c.body(null, 204));
    app.onError((error, c) => c.json({ error: error.message }, error instanceof Error && 'status' in error ? Number(error.status) as 401 | 403 : 500));

    const headers = { Authorization: `Bearer ${token}` };
    const read = await app.request('/protected/read', { headers });
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual({ accountId: 'target-account', impersonating: true });
    expect((await app.request('/protected/write', { method: 'POST', headers })).status).toBe(403);
  });
});