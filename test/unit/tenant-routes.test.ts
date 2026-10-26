import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

import type { AuthEnv } from '../../src/modules/auth/types';
import { createTenantRoutes } from '../../src/modules/tenant/routes';
import { tenantService } from '../../src/modules/tenant/service';
import type { Tenant, TenantDetail } from '../../src/modules/tenant/types';
import { AppError } from '../../src/shared/errors';

const accountId = 'tenant-route-account';
const tenant: Tenant = {
  id: 'tenant-1',
  accountId,
  firstName: 'Sara',
  lastName: 'Amrani',
  email: 'sara@example.test',
  phone: '+212600000000',
  dateOfBirth: null,
  address: null,
  idDocumentType: null,
  idDocumentLast4: null,
  version: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const createApp = (
  overrides: Partial<typeof tenantService> = {},
  role: 'owner' | 'super_admin' = 'owner',
) => {
  const service = { ...tenantService, ...overrides };
  const app = new Hono<AuthEnv>();
  app.use('*', async (c, next) => {
    c.set('accountId', accountId);
    c.set('userId', 'owner-1');
    c.set('role', role);
    c.set('email', 'owner@example.test');
    c.set('sessionId', 'session-1');
    await next();
  });
  app.route('/tenants', createTenantRoutes({ service }));
  app.onError((error, c) => {
    const appError = error instanceof AppError ? error : new AppError('Unexpected server error', 500, 'INTERNAL_ERROR');

    return c.json({ error: { code: appError.code, message: appError.message } }, appError.status as 400 | 401 | 403 | 404 | 409 | 422 | 428 | 500);
  });

  return { app, service };
};

describe('tenant routes', () => {
  it('lists tenants and passes bounded pagination options', async () => {
    const { app, service } = createApp({
      list: vi.fn(async () => ({ items: [tenant], nextCursor: { PK: 'ACCOUNT#next' } })),
    });

    const response = await app.request('/tenants?limit=500');

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: [tenant], nextCursor: expect.any(String) });
    expect(service.list).toHaveBeenCalledWith(accountId, { limit: 100 });
  });

  it('creates a tenant with the required idempotency key and returns its version', async () => {
    const { app, service } = createApp({ create: vi.fn(async () => tenant) });
    const response = await app.request('/tenants', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'tenant-create-1' },
      body: JSON.stringify({
        firstName: 'Sara',
        lastName: 'Amrani',
        email: 'sara@example.test',
        phone: '+212600000000',
      }),
    });

    expect(response.status).toBe(201);
    expect(response.headers.get('ETag')).toBe('1');
    expect(service.create).toHaveBeenCalledWith(
      accountId,
      { firstName: 'Sara', lastName: 'Amrani', email: 'sara@example.test', phone: '+212600000000', dateOfBirth: null, address: null },
      'tenant-create-1',
    );
  });

  it('requires If-Match for updates and deletes, and rejects unknown input fields', async () => {
    const { app, service } = createApp({ update: vi.fn(async () => tenant) });
    const missingVersion = await app.request('/tenants/tenant-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ firstName: 'Sara' }),
    });
    expect(missingVersion.status).toBe(428);

    const invalidBody = await app.request('/tenants/tenant-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'If-Match': '1' },
      body: JSON.stringify({ idDocument: { type: 'CIN', number: 'untrusted' } }),
    });
    expect(invalidBody.status).toBe(400);
    expect(service.update).not.toHaveBeenCalled();
  });

  it('routes document reads only through the decrypted-document service method', async () => {
    const document = { type: 'CIN' as const, number: 'AB123456' };
    const { app, service } = createApp({
      getDecryptedIdDocument: vi.fn(async () => document),
    });

    const response = await app.request('/tenants/tenant-1/id-document');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: document });
    expect(service.getDecryptedIdDocument).toHaveBeenCalledWith(accountId, 'tenant-1');
  });

  it('denies non-owner access to identity documents before decryption', async () => {
    const getDecryptedIdDocument = vi.fn(async () => ({ type: 'CIN' as const, number: 'AB123456' }));
    const { app } = createApp({ getDecryptedIdDocument }, 'super_admin');

    const response = await app.request('/tenants/tenant-1/id-document');

    expect(response.status).toBe(403);
    expect(getDecryptedIdDocument).not.toHaveBeenCalled();
  });

  it('saves identity document input without exposing the number in the response', async () => {
    const updatedTenant = { ...tenant, idDocumentType: 'CIN' as const, idDocumentLast4: '3456', version: 2 };
    const { app, service } = createApp({
      setIdDocument: vi.fn(async () => updatedTenant),
    });
    const response = await app.request('/tenants/tenant-1/id-document', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'If-Match': '1' },
      body: JSON.stringify({ type: 'CIN', number: 'AB123456' }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('ETag')).toBe('2');
    expect(await response.json()).not.toMatchObject({ data: { number: 'AB123456' } });
    expect(service.setIdDocument).toHaveBeenCalledWith(accountId, 'tenant-1', 1, {
      type: 'CIN',
      number: 'AB123456',
    });
  });

  it('includes linked lease summaries in the tenant detail response', async () => {
    const detail: TenantDetail = {
      ...tenant,
      activeLeases: [{ id: 'lease-1', propertyId: 'property-1', startDate: '2026-01-01', endDate: '2026-12-31', status: 'active' }],
    };
    const { app } = createApp({ get: vi.fn(async () => detail) });

    const response = await app.request('/tenants/tenant-1');

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: { activeLeases: [{ id: 'lease-1' }] } });
  });
});