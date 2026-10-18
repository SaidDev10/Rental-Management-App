import { describe, expect, it } from 'vitest';

import { hashPassword } from '../../src/modules/auth/passwords';
import { authService } from '../../src/modules/auth/service';

describe('auth service repository flow', () => {
  it('logs in when the repository returns a verified user record', async () => {
    const repository = {
      findUserByEmail: async () => ({
        id: 'user_123',
        accountId: 'demo-account',
        email: 'owner@example.com',
        name: 'Demo Owner',
        role: 'owner',
        locale: 'fr',
        passwordHash: await hashPassword('supersecret123'),
      }),
      createAccountAndUser: async () => {
        throw new Error('not used');
      },
    };

    const result = await authService.login(
      { email: 'owner@example.com', password: 'supersecret123' },
      repository as never,
    );

    expect(result.accountId).toBe('demo-account');
    expect(result.user.email).toBe('owner@example.com');
    expect(result.accessToken).toContain('.');
  });

  it('translates duplicate-email repository errors into a 409 registration error', async () => {
    const repository = {
      findUserByEmail: async () => undefined,
      createAccountAndUser: async () => {
        throw new Error('Email already taken');
      },
    };

    await expect(
      authService.register(
        {
          accountName: 'Example rentals',
          ownerName: 'Jane Owner',
          email: 'taken@example.com',
          password: 'supersecret123',
          phone: '+123456789',
          locale: 'fr',
        },
        repository as never,
      ),
    ).rejects.toMatchObject({ status: 409, code: 'EMAIL_TAKEN' });
  });
});
