import { describe, expect, it } from 'vitest';

import { app } from '../../src/app';

describe('backend skeleton', () => {
  it('returns health ok', async () => {
    const response = await app.request('http://localhost/health');

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true });
  });

  it('returns 401 when account context is missing', async () => {
    const response = await app.request('http://localhost/properties/', {
      method: 'GET',
    });

    expect(response.status).toBe(401);
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
