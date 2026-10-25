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
      data: [{ id: 'prop_1', accountId: 'demo-account', title: 'Apartment Medina' }],
    });
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
