import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { app } from '../../src/app';
import { createAuthRepository } from '../../src/modules/auth/repository';
import { signAccessToken } from '../../src/modules/auth/tokens';

describe('backend skeleton', () => {
  it('returns health ok', async () => {
    const response = await app.request('http://localhost/health');

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true });
  });

  it('sets the required security headers on API responses', async () => {
    const response = await app.request('http://localhost/health');

    expect(response.headers.get('Strict-Transport-Security')).toBe('max-age=63072000; includeSubDomains; preload');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('X-Frame-Options')).toBe('DENY');
    expect(response.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    expect(response.headers.get('Permissions-Policy')).toBe('geolocation=(), microphone=(), camera=()');
  });

  it('applies security headers and the configured max age to CORS preflight responses', async () => {
    const response = await app.request('http://localhost/health', {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://localhost:5173',
        'Access-Control-Request-Method': 'POST',
      },
    });

    expect(response.headers.get('Access-Control-Max-Age')).toBe('600');
    expect(response.headers.get('X-Frame-Options')).toBe('DENY');
  });

  it('rejects cookie-authenticated refresh requests from untrusted or missing origins', async () => {
    const response = await app.request('http://localhost/auth/refresh', {
      method: 'POST',
      headers: { Cookie: '__Host-rt=opaque-token', Origin: 'https://attacker.example' },
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: 'CSRF_ORIGIN_REJECTED' } });
  });

  it('returns 401 when account context is missing', async () => {
    const response = await app.request('http://localhost/properties/', {
      method: 'GET',
    });

    expect(response.status).toBe(401);
  });

  it('requires authentication for tenant routes', async () => {
    const response = await app.request('http://localhost/tenants/');

    expect(response.status).toBe(401);
  });

  it('requires authentication for payment routes', async () => {
    const response = await app.request('http://localhost/payments/');

    expect(response.status).toBe(401);
  });

  it('requires authentication for document routes', async () => {
    const response = await app.request('http://localhost/documents/');

    expect(response.status).toBe(401);
  });

  it('requires authentication for maintenance attachment routes', async () => {
    const response = await app.request('http://localhost/maintenance/tickets/ticket-1/attachments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contentType: 'image/jpeg', sizeBytes: 1024 }),
    });

    expect(response.status).toBe(401);
  });

  it('requires authentication for dashboard and summary report routes', async () => {
    const dashboard = await app.request('http://localhost/dashboard');
    const report = await app.request('http://localhost/reports/summary?from=2026-01&to=2026-02');

    expect(dashboard.status).toBe(401);
    expect(report.status).toBe(401);
  });

  it('returns 200 for a valid login payload', async () => {
    const response = await app.request('http://localhost/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'owner@example.com',
        password: 'supersecret123',
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ token: expect.any(String), accessToken: expect.any(String) });
  });

  it('allows authenticated property requests using the bearer token', async () => {
    const loginResponse = await app.request('http://localhost/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'owner@example.com',
        password: 'supersecret123',
      }),
    });

    const { accessToken } = (await loginResponse.json()) as { accessToken: string };
    const response = await app.request('http://localhost/properties/', {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: [{ id: 'prop_1', accountId: 'demo-account', label: 'Apartment Medina' }],
    });
  });

  it('creates, reads, updates, and soft-deletes account-owned properties', async () => {
    const loginResponse = await app.request('http://localhost/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'owner@example.com', password: 'supersecret123' }),
    });
    const { accessToken } = (await loginResponse.json()) as { accessToken: string };
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': 'property-crud-create-1',
    };
    const createBody = JSON.stringify({
      label: 'CRUD Test House',
      address: { line1: '42 Test Street', city: 'Rabat', country: 'MA' },
      propertyType: 'house',
    });
    const createResponse = await app.request('http://localhost/properties/', {
      method: 'POST',
      headers,
      body: createBody,
    });
    expect(createResponse.status).toBe(201);
    const created = (await createResponse.json() as {
      data: { id: string; version: number; accountId: string; label: string };
    }).data;
    expect(created).toMatchObject({
      accountId: 'demo-account',
      label: 'CRUD Test House',
      version: 1,
    });

    const idempotentCreateResponse = await app.request('http://localhost/properties/', {
      method: 'POST',
      headers,
      body: createBody,
    });
    expect(idempotentCreateResponse.status).toBe(201);
    expect(await idempotentCreateResponse.json()).toMatchObject({
      data: { id: created.id },
    });

    const reusedKeyResponse = await app.request('http://localhost/properties/', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        label: 'Different House',
        address: { line1: '42 Test Street', city: 'Rabat', country: 'MA' },
        propertyType: 'house',
      }),
    });
    expect(reusedKeyResponse.status).toBe(409);
    expect(await reusedKeyResponse.json()).toMatchObject({
      error: { code: 'IDEMPOTENCY_KEY_REUSED' },
    });

    const getResponse = await app.request(`http://localhost/properties/${created.id}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(getResponse.status).toBe(200);
    expect(getResponse.headers.get('ETag')).toBe('1');

    const updateResponse = await app.request(`http://localhost/properties/${created.id}`, {
      method: 'PATCH',
      headers: { ...headers, 'If-Match': '1' },
      body: JSON.stringify({ label: 'Updated Test House' }),
    });
    expect(updateResponse.status).toBe(200);
    expect(updateResponse.headers.get('ETag')).toBe('2');
    expect(await updateResponse.json()).toMatchObject({
      data: { label: 'Updated Test House', version: 2 },
    });

    const staleUpdateResponse = await app.request(`http://localhost/properties/${created.id}`, {
      method: 'PATCH',
      headers: { ...headers, 'If-Match': '1' },
      body: JSON.stringify({ label: 'Stale Update' }),
    });
    expect(staleUpdateResponse.status).toBe(409);
    expect(await staleUpdateResponse.json()).toMatchObject({
      error: { code: 'CONFLICT_VERSION_MISMATCH' },
    });

    const deleteResponse = await app.request(`http://localhost/properties/${created.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${accessToken}`, 'If-Match': '2' },
    });
    expect(deleteResponse.status).toBe(204);

    const deletedGetResponse = await app.request(`http://localhost/properties/${created.id}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(deletedGetResponse.status).toBe(404);
  });

  it('creates, reads, updates, and soft-deletes account-owned tenants', async () => {
    const loginResponse = await app.request('http://localhost/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'owner@example.com', password: 'supersecret123' }),
    });
    const { accessToken } = (await loginResponse.json()) as { accessToken: string };
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': 'tenant-crud-create-1',
      'x-account-id': 'caller-controlled-account',
    };
    const createBody = JSON.stringify({
      firstName: 'Mina',
      lastName: 'Bennani',
      email: 'mina@example.test',
      phone: '+212600000001',
    });
    const createResponse = await app.request('http://localhost/tenants/', {
      method: 'POST',
      headers,
      body: createBody,
    });
    expect(createResponse.status).toBe(201);
    const created = (await createResponse.json() as {
      data: { id: string; version: number; accountId: string; firstName: string };
    }).data;
    expect(created).toMatchObject({
      accountId: 'demo-account',
      firstName: 'Mina',
      version: 1,
    });

    const replayResponse = await app.request('http://localhost/tenants/', {
      method: 'POST',
      headers,
      body: createBody,
    });
    expect(replayResponse.status).toBe(201);
    expect(await replayResponse.json()).toMatchObject({ data: { id: created.id } });

    const detailResponse = await app.request(`http://localhost/tenants/${created.id}`, {
      headers: { Authorization: `Bearer ${accessToken}`, 'x-account-id': 'caller-controlled-account' },
    });
    expect(detailResponse.status).toBe(200);
    expect(detailResponse.headers.get('ETag')).toBe('1');
    expect(await detailResponse.json()).toMatchObject({
      data: { id: created.id, accountId: 'demo-account', activeLeases: [] },
    });

    const updateResponse = await app.request(`http://localhost/tenants/${created.id}`, {
      method: 'PATCH',
      headers: { ...headers, 'If-Match': '1' },
      body: JSON.stringify({ firstName: 'Mina Zahra' }),
    });
    expect(updateResponse.status).toBe(200);
    expect(updateResponse.headers.get('ETag')).toBe('2');

    const deleteResponse = await app.request(`http://localhost/tenants/${created.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${accessToken}`, 'If-Match': '2' },
    });
    expect(deleteResponse.status).toBe(204);

    const deletedGetResponse = await app.request(`http://localhost/tenants/${created.id}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(deletedGetResponse.status).toBe(404);
  });

  it('authenticates the property-to-tenant-to-lease flow and generates a payment schedule', async () => {
    const requestId = randomUUID();
    const email = `lease-flow-${requestId}@example.test`;
    const registrationResponse = await app.request('http://localhost/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accountName: `Lease Flow ${requestId}`,
        ownerName: 'Lease Flow Owner',
        email,
        password: 'supersecret123',
        phone: '+212600000222',
        locale: 'en',
      }),
    });
    expect(registrationResponse.status).toBe(201);
    const registration = await registrationResponse.json() as {
      account: { id: string };
    };

    const loginResponse = await app.request('http://localhost/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'supersecret123' }),
    });
    const { accessToken } = (await loginResponse.json()) as { accessToken: string };
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'x-account-id': 'attacker-controlled-account',
    };

    const propertyResponse = await app.request('http://localhost/properties', {
      method: 'POST',
      headers: { ...headers, 'Idempotency-Key': `lease-flow-property-${requestId}` },
      body: JSON.stringify({
        label: 'Lease flow property',
        address: { line1: '1 Lease Flow Road', city: 'Rabat', country: 'MA' },
        propertyType: 'apartment',
      }),
    });
    expect(propertyResponse.status).toBe(201);
    const property = (await propertyResponse.json() as { data: { id: string; accountId: string } }).data;

    const tenantResponse = await app.request('http://localhost/tenants', {
      method: 'POST',
      headers: { ...headers, 'Idempotency-Key': `lease-flow-tenant-${requestId}` },
      body: JSON.stringify({
        firstName: 'Lease',
        lastName: 'Flow',
        email: `${requestId}@example.test`,
        phone: '+212600000222',
      }),
    });
    expect(tenantResponse.status).toBe(201);
    const tenant = (await tenantResponse.json() as { data: { id: string; accountId: string } }).data;
    expect(property.accountId).toBe(registration.account.id);
    expect(tenant.accountId).toBe(registration.account.id);

    const leaseResponse = await app.request('http://localhost/leases', {
      method: 'POST',
      headers: { ...headers, 'Idempotency-Key': `lease-flow-lease-${requestId}` },
      body: JSON.stringify({
        propertyId: property.id,
        tenantIds: [tenant.id],
        startDate: '2026-11-01',
        endDate: '2027-10-31',
        rentAmount: 700000,
        chargesAmount: 50000,
        depositAmount: 700000,
        paymentDayOfMonth: 5,
        billingFrequency: 'monthly',
      }),
    });
    expect(leaseResponse.status).toBe(201);
    const lease = (await leaseResponse.json() as {
      data: { id: string; accountId: string; version: number };
    }).data;
    expect(lease.accountId).toBe(registration.account.id);
    expect(leaseResponse.headers.get('ETag')).toBe('1');

    const deletePropertyResponse = await app.request(`http://localhost/properties/${property.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${accessToken}`, 'If-Match': '1' },
    });
    expect(deletePropertyResponse.status).toBe(409);
    expect(await deletePropertyResponse.json()).toMatchObject({
      error: { code: 'PROPERTY_HAS_ACTIVE_LEASE' },
    });

    const scheduleResponse = await app.request(`http://localhost/leases/${lease.id}/schedule`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(scheduleResponse.status).toBe(200);
    const scheduleBody = await scheduleResponse.json() as { data: Array<Record<string, unknown>> };
    expect(scheduleBody).toMatchObject({
      data: expect.arrayContaining([
        expect.objectContaining({ leaseId: lease.id, tenantId: tenant.id, amountDue: 750000, status: 'due' }),
      ]),
    });
    expect(scheduleBody.data).toHaveLength(12);

    const paymentListResponse = await app.request(`http://localhost/payments?leaseId=${lease.id}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(paymentListResponse.status).toBe(200);
    const paymentList = await paymentListResponse.json() as {
      data: Array<{ id: string; amountDue: number; version: number }>;
    };
    expect(paymentList.data).toHaveLength(12);
    const firstPayment = paymentList.data[0]!;
    const partialPaymentResponse = await app.request(
      `http://localhost/payments/${firstPayment.id}/mark-paid`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'If-Match': String(firstPayment.version),
        },
        body: JSON.stringify({
          paidAt: '2026-11-05T12:00:00.000Z',
          paymentMethod: 'bank_transfer',
          amountPaid: 250000,
        }),
      },
    );
    expect(partialPaymentResponse.status).toBe(200);
    expect(await partialPaymentResponse.json()).toMatchObject({
      data: { status: 'partial', amountPaid: 250000, version: firstPayment.version + 1 },
    });

    const tenantDetailResponse = await app.request(`http://localhost/tenants/${tenant.id}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(tenantDetailResponse.status).toBe(200);
    expect(await tenantDetailResponse.json()).toMatchObject({
      data: { activeLeases: [{ id: lease.id, propertyId: property.id }] },
    });

    const secondEmail = `lease-flow-other-${requestId}@example.test`;
    const secondRegistrationResponse = await app.request('http://localhost/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accountName: `Other Lease Flow ${requestId}`,
        ownerName: 'Other Lease Flow Owner',
        email: secondEmail,
        password: 'supersecret123',
        phone: '+212600000223',
      }),
    });
    expect(secondRegistrationResponse.status).toBe(201);
    const secondLoginResponse = await app.request('http://localhost/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: secondEmail, password: 'supersecret123' }),
    });
    const { accessToken: otherAccessToken } = await secondLoginResponse.json() as { accessToken: string };
    const otherHeaders = {
      Authorization: `Bearer ${otherAccessToken}`,
      'Content-Type': 'application/json',
      'If-Match': String(firstPayment.version),
    };

    const isolatedListResponse = await app.request(`http://localhost/payments?leaseId=${lease.id}`, {
      headers: { Authorization: `Bearer ${otherAccessToken}` },
    });
    expect(isolatedListResponse.status).toBe(200);
    expect(await isolatedListResponse.json()).toMatchObject({ data: [] });
    const isolatedOverdueResponse = await app.request('http://localhost/payments/overdue', {
      headers: { Authorization: `Bearer ${otherAccessToken}` },
    });
    expect(isolatedOverdueResponse.status).toBe(200);
    expect(await isolatedOverdueResponse.json()).toMatchObject({ data: [] });

    for (const [url, init] of [
      [`http://localhost/payments/${firstPayment.id}`, { headers: otherHeaders }],
      [`http://localhost/payments/${firstPayment.id}`, {
        method: 'PATCH',
        headers: otherHeaders,
        body: JSON.stringify({ amountDue: 800000 }),
      }],
      [`http://localhost/payments/${firstPayment.id}/mark-paid`, {
        method: 'POST',
        headers: otherHeaders,
        body: JSON.stringify({
          paidAt: '2026-11-05T12:00:00.000Z',
          paymentMethod: 'cash',
          amountPaid: 750000,
        }),
      }],
      [`http://localhost/payments/${firstPayment.id}/cancel`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${otherAccessToken}`, 'If-Match': String(firstPayment.version) },
      }],
    ] as const) {
      const response = await app.request(url, init);
      expect(response.status).toBe(404);
    }

    const isolatedCreateResponse = await app.request('http://localhost/payments', {
      method: 'POST',
      headers: { ...otherHeaders, 'Idempotency-Key': `isolated-payment-${requestId}` },
      body: JSON.stringify({
        leaseId: lease.id,
        periodStart: '2026-11-01',
        periodEnd: '2026-11-30',
        dueDate: '2026-11-05',
        amountDue: 750000,
      }),
    });
    expect(isolatedCreateResponse.status).toBe(404);
  });

  it('validates property input and requires If-Match for updates', async () => {
    const loginResponse = await app.request('http://localhost/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'owner@example.com', password: 'supersecret123' }),
    });
    const { accessToken } = (await loginResponse.json()) as { accessToken: string };
    const response = await app.request('http://localhost/properties/', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': 'property-isolation-create-1',
      },
      body: JSON.stringify({
        label: 'X',
        address: { line1: '', city: 'Rabat', country: 'US' },
        propertyType: 'house',
      }),
    });
    expect(response.status).toBe(400);

    const missingIdempotencyKeyResponse = await app.request('http://localhost/properties/', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        label: 'Valid House',
        address: { line1: '1 Valid Road', city: 'Rabat', country: 'MA' },
        propertyType: 'house',
      }),
    });
    expect(missingIdempotencyKeyResponse.status).toBe(400);
    expect(await missingIdempotencyKeyResponse.json()).toMatchObject({
      error: { code: 'VALIDATION_ERROR' },
    });

    const updateResponse = await app.request('http://localhost/properties/prop_1', {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'Missing version' }),
    });
    expect(updateResponse.status).toBe(428);
    expect(await updateResponse.json()).toMatchObject({
      error: { code: 'PRECONDITION_REQUIRED' },
    });
  });

  it('paginates properties and rejects malformed cursors', async () => {
    const loginResponse = await app.request('http://localhost/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'owner@example.com', password: 'supersecret123' }),
    });
    const { accessToken } = (await loginResponse.json()) as { accessToken: string };
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    };

    for (const [key, label] of [
      ['property-page-create-1', 'Page House One'],
      ['property-page-create-2', 'Page House Two'],
    ] as const) {
      const createResponse = await app.request('http://localhost/properties', {
        method: 'POST',
        headers: { ...headers, 'Idempotency-Key': key },
        body: JSON.stringify({
          label,
          address: { line1: '1 Page Street', city: 'Rabat', country: 'MA' },
          propertyType: 'house',
        }),
      });
      expect(createResponse.status).toBe(201);
    }

    const firstPageResponse = await app.request('http://localhost/properties?limit=1', { headers });
    expect(firstPageResponse.status).toBe(200);
    const firstPage = (await firstPageResponse.json()) as {
      data: Array<{ id: string }>;
      nextCursor: string | null;
    };
    expect(firstPage.data).toHaveLength(1);
    expect(firstPage.nextCursor).toEqual(expect.any(String));

    const nextPageResponse = await app.request(
      `http://localhost/properties?limit=1&cursor=${encodeURIComponent(firstPage.nextCursor ?? '')}`,
      { headers },
    );
    const nextPage = (await nextPageResponse.json()) as { data: Array<{ id: string }> };
    expect(nextPageResponse.status).toBe(200);
    expect(nextPage.data[0]?.id).not.toBe(firstPage.data[0]?.id);

    const malformedCursorResponse = await app.request(
      'http://localhost/properties?cursor=not-a-cursor',
      { headers },
    );
    expect(malformedCursorResponse.status).toBe(400);
    expect(await malformedCursorResponse.json()).toMatchObject({
      error: { code: 'VALIDATION_ERROR' },
    });
  });

  it('does not expose another account’s property by identifier', async () => {
    const ownerLogin = await app.request('http://localhost/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'owner@example.com', password: 'supersecret123' }),
    });
    const { accessToken } = (await ownerLogin.json()) as { accessToken: string };
    const createResponse = await app.request('http://localhost/properties', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': 'property-isolation-create-1',
      },
      body: JSON.stringify({
        label: 'Private Property',
        address: { line1: '1 Private Road', city: 'Fes', country: 'MA' },
        propertyType: 'house',
      }),
    });
    const { data: property } = (await createResponse.json()) as { data: { id: string } };
    const otherAccountToken = await signAccessToken({
      userId: 'user_other',
      accountId: 'other-account',
      email: 'other@example.test',
      role: 'owner',
      sessionId: 'session_other',
    });

    const response = await app.request(`http://localhost/properties/${property.id}`, {
      headers: { Authorization: `Bearer ${otherAccountToken}` },
    });
    expect(response.status).toBe(404);
  });

  it('returns the caller identity from the verified bearer token on /auth/me', async () => {
    const loginResponse = await app.request('http://localhost/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'owner@example.com',
        password: 'supersecret123',
      }),
    });

    const { accessToken } = (await loginResponse.json()) as { accessToken: string };
    const response = await app.request('http://localhost/auth/me', {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      accountId: 'demo-account',
      email: 'owner@example.com',
      authenticated: true,
    });
  });

  it('rotates refresh tokens and rejects replay after logout', async () => {
    const loginResponse = await app.request('http://localhost/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'owner@example.com',
        password: 'supersecret123',
      }),
    });

    const { accessToken, refreshToken } = (await loginResponse.json()) as {
      accessToken: string;
      refreshToken: string;
    };

    const refreshResponse = await app.request('http://localhost/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });

    expect(refreshResponse.status).toBe(200);
    const refreshed = (await refreshResponse.json()) as { accessToken: string; refreshToken: string };
    expect(refreshed.accessToken).toBeTypeOf('string');
    expect(refreshed.refreshToken).toBeTypeOf('string');

    const invalidRefreshResponse = await app.request('http://localhost/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: 'unrecognized-refresh-token' }),
    });
    expect(invalidRefreshResponse.status).toBe(401);
    expect(await invalidRefreshResponse.json()).toMatchObject({ error: { code: 'INVALID_REFRESH' } });

    const refreshedAgainResponse = await app.request('http://localhost/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: refreshed.refreshToken }),
    });
    expect(refreshedAgainResponse.status).toBe(200);
    const refreshedAgain = (await refreshedAgainResponse.json()) as { refreshToken: string };

    const reuseResponse = await app.request('http://localhost/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });
    expect(reuseResponse.status).toBe(401);
    expect(await reuseResponse.json()).toMatchObject({ error: { code: 'SESSION_REVOKED' } });

    const revokedSessionResponse = await app.request('http://localhost/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: refreshedAgain.refreshToken }),
    });
    expect(revokedSessionResponse.status).toBe(401);
    expect(await revokedSessionResponse.json()).toMatchObject({ error: { code: 'SESSION_REVOKED' } });

    const logoutResponse = await app.request('http://localhost/auth/logout', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    expect(logoutResponse.status).toBe(204);

    const replayResponse = await app.request('http://localhost/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });

    expect(replayResponse.status).toBe(401);
    expect(await replayResponse.json()).toMatchObject({ error: { code: 'SESSION_REVOKED' } });
  });

  it('locks an account after five failed password attempts', async () => {
    const email = `lockout-${Date.now()}@example.com`;
    const registerResponse = await app.request('http://localhost/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accountName: 'Lockout Test',
        ownerName: 'Lockout User',
        email,
        password: 'supersecret123',
        phone: '+212600000000',
      }),
    });

    expect(registerResponse.status).toBe(201);

    for (let index = 0; index < 5; index += 1) {
      const attempt = await app.request('http://localhost/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          password: 'wrong-password',
        }),
      });

      if (index < 4) {
        expect(attempt.status).toBe(401);
      } else {
        expect(attempt.status).toBe(423);
        expect(await attempt.json()).toMatchObject({ error: { code: 'ACCOUNT_LOCKED' } });
      }
    }
  });

  it('rejects super-admin requests whose session id no longer matches the active session', async () => {
    const repository = createAuthRepository();
    const userId = 'user_demo_owner';
    const accountId = 'demo-account';
    const activeSessionId = 'session_super_admin_active';

    await repository.createSession({
      userId,
      accountId,
      email: 'owner@example.com',
      role: 'super_admin',
      sessionId: activeSessionId,
      familyId: 'family_demo_owner',
      refreshTokenHash: 'hash_for_active_super_admin_session',
    });

    const token = await signAccessToken({
      userId,
      accountId,
      email: 'owner@example.com',
      role: 'super_admin',
      sessionId: 'session_super_admin_stale',
    });

    const response = await app.request('http://localhost/auth/me', {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: 'UNAUTHENTICATED' } });
  });

  it('rejects invalid credentials', async () => {
    const response = await app.request('http://localhost/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'owner@example.com',
        password: 'wrong-password',
      }),
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: 'UNAUTHENTICATED' } });
  });
});
