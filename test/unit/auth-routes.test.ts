import { afterEach, describe, expect, it, vi } from 'vitest';

const resetPassword = vi.hoisted(() => vi.fn());

vi.mock('../../src/modules/auth/service', () => ({
  authService: {
    resetPassword,
  },
}));

import { authRoutes } from '../../src/modules/auth/routes';

afterEach(() => {
  resetPassword.mockReset();
});

describe('password reset route contract', () => {
  it('accepts newPassword and responds with 204 after reset', async () => {
    resetPassword.mockResolvedValue({ passwordReset: true });

    const response = await authRoutes.request('/password/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'owner@example.test',
        code: '123456',
        newPassword: 'newsecret1234',
      }),
    });

    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
    expect(resetPassword).toHaveBeenCalledWith({
      email: 'owner@example.test',
      code: '123456',
      newPassword: 'newsecret1234',
    });
  });

  it('rejects the legacy password property instead of silently accepting a different contract', async () => {
    const response = await authRoutes.request('/password/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'owner@example.test',
        code: '123456',
        password: 'newsecret1234',
      }),
    });

    expect(response.status).toBe(400);
    expect(resetPassword).not.toHaveBeenCalled();
  });
});
