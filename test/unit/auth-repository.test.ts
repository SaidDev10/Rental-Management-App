import { DynamoDBDocumentClient, GetCommand, ScanCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createAuthRepository, createDynamoAuthRepository } from '../../src/modules/auth/repository';
import { hashPassword } from '../../src/modules/auth/passwords';
import { createHash, randomUUID } from 'node:crypto';
import { authService } from '../../src/modules/auth/service';
import { OtpChallengeError, type OtpChallenge, type OtpChallengeStore } from '../../src/modules/auth/otp-challenges';

const setDynamoAuthEnv = (): void => {
  process.env.TABLE_NAME = 'rental-app-test';
  process.env.USE_DYNAMO_AUTH = 'true';
};

const createMemoryOtpStore = (): {
  store: OtpChallengeStore;
  codes: Map<string, string>;
  created: OtpChallenge[];
  completeCalls: ReturnType<typeof vi.fn>;
} => {
  const challenges = new Map<string, OtpChallenge>();
  const codes = new Map<string, string>();
  const created: OtpChallenge[] = [];
  const completing = new Set<string>();
  const challengeKey = (challenge: OtpChallenge): string =>
    `${challenge.purpose}:${challenge.purpose === 'LOGIN_MFA' ? challenge.challengeToken : challenge.userId}`;
  const completeCalls = vi.fn(async (
    challenge: OtpChallenge,
    _passwordHash: string,
    updateLocalPassword: () => Promise<void>,
  ) => {
    const key = challengeKey(challenge);
    const current = challenges.get(key);
    if (!current || current.challengeId !== challenge.challengeId || completing.has(key)) {
      throw new OtpChallengeError('consumed');
    }

    completing.add(key);
    try {
      await updateLocalPassword();
      challenges.delete(key);
    } finally {
      completing.delete(key);
    }
  });
  const store: OtpChallengeStore = {
    async create(input) {
      const challenge: OtpChallenge = {
        userId: input.userId,
        accountId: input.accountId,
        email: input.email,
        purpose: input.purpose,
        challengeToken: input.challengeToken,
        challengeId: randomUUID(),
        codeHash: createHash('sha256').update(input.code).digest('hex'),
        expiresAt: input.expiresAt,
        attempts: 0,
      };
      challenges.set(`${challenge.purpose}:${challenge.purpose === 'LOGIN_MFA' ? challenge.challengeToken : challenge.userId}`, challenge);
      codes.set(challenge.challengeToken, input.code);
      created.push(challenge);

      return challenge;
    },
    async getMfa(challengeToken) {
      return challenges.get(`LOGIN_MFA:${challengeToken}`);
    },
    async getPasswordReset(userId) {
      return challenges.get(`PASSWORD_RESET:${userId}`);
    },
    async incrementAttempts(challenge, maxAttempts, now) {
      const key = `${challenge.purpose}:${challenge.purpose === 'LOGIN_MFA' ? challenge.challengeToken : challenge.userId}`;
      const current = challenges.get(key);
      if (!current || current.challengeId !== challenge.challengeId) throw new Error('ConditionalCheckFailedException');
      if (current.expiresAt <= now) throw new Error('ConditionalCheckFailedException');
      if (current.attempts >= maxAttempts) throw new OtpChallengeError('exhausted');
      const updated = { ...current, attempts: current.attempts + 1 };
      challenges.set(key, updated);

      return updated;
    },
    async delete(challenge) {
      challenges.delete(challengeKey(challenge));
    },
    completePasswordReset: completeCalls,
  };

  return { store, codes, created, completeCalls };
};

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.TABLE_NAME;
  delete process.env.USE_DYNAMO_AUTH;
  delete process.env.STAGE;
});

describe('auth service repository flow', () => {
  it('persists login failure counters and lockout state in DynamoDB', async () => {
    setDynamoAuthEnv();
    const updates: UpdateCommand[] = [];
    const repository = createDynamoAuthRepository({
      send: async (command: unknown) => {
        if (command instanceof UpdateCommand) {
          updates.push(command);
          if (updates.length === 1) {
            return { Attributes: { failedLoginAttempts: 5 } };
          }
        }

        return {};
      },
    } as unknown as DynamoDBDocumentClient);

    await expect(repository.recordLoginFailure({
      userId: 'user_lockout',
      accountId: 'account_lockout',
    })).resolves.toBe(5);

    expect(updates).toHaveLength(2);
    expect(updates[0]?.input).toMatchObject({
      Key: { PK: 'ACCOUNT#account_lockout', SK: 'USER#user_lockout' },
      UpdateExpression: expect.stringContaining('if_not_exists(failedLoginAttempts, :zero) + :one'),
      ConditionExpression: expect.stringContaining('accountId = :accountId'),
      ReturnValues: 'ALL_NEW',
    });
    expect(updates[1]?.input).toMatchObject({
      Key: { PK: 'ACCOUNT#account_lockout', SK: 'USER#user_lockout' },
      UpdateExpression: expect.stringContaining('SET lockedUntil = :lockedUntil'),
      ConditionExpression: expect.stringContaining('failedLoginAttempts >= :threshold'),
    });

    await repository.resetLoginFailures({
      userId: 'user_lockout',
      accountId: 'account_lockout',
    });

    expect(updates).toHaveLength(3);
    expect(updates[2]?.input).toMatchObject({
      Key: { PK: 'ACCOUNT#account_lockout', SK: 'USER#user_lockout' },
      UpdateExpression: expect.stringContaining('failedLoginAttempts = :zero, lockedUntil = :null'),
    });
  });

  it('logs in when the repository returns a verified user record', async () => {
    const repository = {
      findUserByEmail: async () => ({
        id: 'user_123',
        accountId: 'demo-account',
        email: 'owner@example.com',
        name: 'Demo Owner',
        role: 'owner',
        locale: 'fr',
        accountStatus: 'active',
        passwordHash: await hashPassword('supersecret123'),
      }),
      createSession: async () => ({
        userId: 'user_123',
        accountId: 'demo-account',
        email: 'owner@example.com',
        role: 'owner',
        sessionId: 'session_user_123',
        familyId: 'family_user_123',
      }),
      resetLoginFailures: async () => undefined,
      createAccountAndUser: async () => {
        throw new Error('not used');
      },
    };

    const result = await authService.login(
      { email: 'owner@example.com', password: 'supersecret123' },
      repository as never,
    );

    if ('mfaRequired' in result) {
      throw new Error('Expected immediate login result, not MFA challenge');
    }

    expect(result.accountId).toBe('demo-account');
    expect(result.user.email).toBe('owner@example.com');
    expect(result.accessToken).toContain('.');
  });

  it('rejects login for a disabled account before creating a session', async () => {
    const createSession = vi.fn();
    const repository = {
      findUserByEmail: async () => ({
        id: 'user_disabled',
        accountId: 'disabled-account',
        email: 'owner@example.com',
        name: 'Disabled Owner',
        role: 'owner',
        locale: 'fr',
        accountStatus: 'disabled',
        passwordHash: await hashPassword('supersecret123'),
      }),
      createSession,
    };

    await expect(
      authService.login(
        { email: 'owner@example.com', password: 'supersecret123' },
        repository as never,
      ),
    ).rejects.toMatchObject({ status: 403, code: 'ACCOUNT_DISABLED' });
    expect(createSession).not.toHaveBeenCalled();
  });

  it('issues a password reset challenge for a valid email and validates the reset code', async () => {
    process.env.STAGE = 'test';
    process.env.USE_DYNAMO_AUTH = 'false';
    const otpStore = createMemoryOtpStore();
    const user = {
      id: 'user_reset',
      accountId: 'account_reset',
      email: 'owner@example.com',
      name: 'Reset Owner',
      role: 'owner' as const,
      locale: 'fr' as const,
      accountStatus: 'active',
      passwordHash: await hashPassword('supersecret123'),
    };
    const updatePassword = vi.fn();
    const repository = {
      findUserByEmail: vi.fn().mockResolvedValue(user),
      updatePassword,
    };

    let resetCode = '';
    const enqueueNotification = vi.fn(async (sourceJobId: string, notification: { code: string }) => {
      expect(sourceJobId).toBeTruthy();
      resetCode = notification.code;
    });
    const challenge = await authService.requestPasswordReset(
      { email: 'owner@example.com' },
      repository as never,
      otpStore.store,
      enqueueNotification as never,
    );
    expect(challenge).toEqual({ sent: true });
    expect(otpStore.created[0]?.expiresAt).toBeGreaterThan(Date.now());
    expect(otpStore.created[0]?.expiresAt).toBeLessThanOrEqual(Date.now() + 5 * 60 * 1000);
    expect(enqueueNotification).toHaveBeenCalledOnce();
    expect(enqueueNotification.mock.calls[0]?.[1]).toMatchObject({
      accountId: 'account_reset',
      kind: 'PASSWORD_RESET',
      userId: 'user_reset',
      channel: 'email',
    });
    const code = resetCode;

    const resetResult = await authService.resetPassword(
      { email: 'owner@example.com', code, newPassword: 'newsupersecret123' },
      repository as never,
      otpStore.store,
    );

    expect(resetResult).toMatchObject({ passwordReset: true });
    expect(updatePassword).toHaveBeenCalledWith({
      userId: 'user_reset',
      accountId: 'account_reset',
      passwordHash: expect.any(String),
    });
    expect(otpStore.completeCalls).toHaveBeenCalledOnce();
  });

  it('returns the same password-forgot response for an unknown email without enqueueing delivery', async () => {
    process.env.STAGE = 'test';
    process.env.USE_DYNAMO_AUTH = 'false';
    const enqueueNotification = vi.fn();
    const result = await authService.requestPasswordReset(
      { email: 'missing@example.com' },
      { findUserByEmail: vi.fn().mockResolvedValue(undefined) } as never,
      createMemoryOtpStore().store,
      enqueueNotification as never,
    );

    expect(result).toEqual({ sent: true });
    expect(enqueueNotification).not.toHaveBeenCalled();
  });

  it('propagates challenge persistence and delivery failures without logging reset data', async () => {
    process.env.STAGE = 'test';
    process.env.USE_DYNAMO_AUTH = 'false';
    const user = {
      id: 'user_reset_error',
      accountId: 'account_reset_error',
      email: 'reset-error@example.com',
      name: 'Reset Owner',
      role: 'owner' as const,
      locale: 'fr' as const,
      accountStatus: 'active',
      passwordHash: await hashPassword('supersecret123'),
    };
    const repository = { findUserByEmail: vi.fn().mockResolvedValue(user) };
    const storeFailure = new Error('Dynamo unavailable');
    const store = createMemoryOtpStore().store;
    await expect(authService.requestPasswordReset(
      { email: user.email },
      repository as never,
      { ...store, create: async () => { throw storeFailure; } },
      vi.fn() as never,
    )).rejects.toBe(storeFailure);

    const enqueueFailure = new Error('SQS unavailable');
    await expect(authService.requestPasswordReset(
      { email: user.email },
      repository as never,
      createMemoryOtpStore().store,
      async () => { throw enqueueFailure; },
    )).rejects.toBe(enqueueFailure);
  });

  it('delivers login and resend MFA codes through notification jobs without returning codes', async () => {
    process.env.STAGE = 'test';
    process.env.USE_DYNAMO_AUTH = 'false';
    const otpStore = createMemoryOtpStore();
    const repository = {
      findUserByEmail: async () => ({
        id: 'user_mfa_delivery',
        accountId: 'account_mfa_delivery',
        email: 'mfa-delivery@example.com',
        name: 'MFA Owner',
        role: 'owner' as const,
        locale: 'fr' as const,
        accountStatus: 'active',
        mfaEnabled: true,
        passwordHash: await hashPassword('supersecret123'),
      }),
      resetLoginFailures: vi.fn(),
    };
    const enqueued: Array<{ accountId: string; kind: string; userId: string; code: string; channel: string }> = [];
    const enqueue = async (_sourceJobId: string, payload: typeof enqueued[number]) => {
      enqueued.push(payload);
    };
    const login = await authService.login(
      { email: 'mfa-delivery@example.com', password: 'supersecret123' },
      repository as never,
      otpStore.store,
      enqueue as never,
    );

    expect(login).toMatchObject({ mfaRequired: true });
    expect(login).not.toHaveProperty('code');
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]).toMatchObject({
      accountId: 'account_mfa_delivery',
      kind: 'MFA_OTP',
      userId: 'user_mfa_delivery',
      channel: 'email',
    });
    expect(enqueued[0]?.code).toMatch(/^\d{6}$/);

    if (!('mfaRequired' in login)) throw new Error('Expected an MFA challenge');
    await expect(authService.resendMfaChallenge(login.challengeToken, otpStore.store, enqueue as never))
      .resolves.toEqual({ sent: true });
    expect(enqueued).toHaveLength(2);
    expect(enqueued[1]).toMatchObject({
      accountId: 'account_mfa_delivery',
      kind: 'MFA_OTP',
      userId: 'user_mfa_delivery',
      channel: 'email',
    });
    expect(enqueued[1]?.code).toMatch(/^\d{6}$/);
    expect(enqueued[1]?.code).not.toBe(enqueued[0]?.code);
  });

  it('keeps a valid reset challenge when password persistence fails', async () => {
    process.env.STAGE = 'test';
    process.env.USE_DYNAMO_AUTH = 'false';
    const otpStore = createMemoryOtpStore();
    const user = {
      id: 'user_reset_update_failure',
      accountId: 'account_reset_update_failure',
      email: 'update-failure@example.com',
      name: 'Reset Owner',
      role: 'owner' as const,
      locale: 'fr' as const,
      accountStatus: 'active',
      passwordHash: await hashPassword('supersecret123'),
    };
    const updateFailure = new Error('Password persistence failed');
    const repository = {
      findUserByEmail: vi.fn().mockResolvedValue(user),
      updatePassword: vi.fn(async () => { throw updateFailure; }),
    };
    let code = '';
    await authService.requestPasswordReset(
      { email: user.email },
      repository as never,
      otpStore.store,
      (async (sourceJobId: string, notification: { code: string }) => {
        expect(sourceJobId).toBeTruthy();
        code = notification.code;
      }) as never,
    );

    await expect(authService.resetPassword(
      { email: user.email, code, newPassword: 'newsecret123' },
      repository as never,
      otpStore.store,
    )).rejects.toBe(updateFailure);

    expect(otpStore.completeCalls).toHaveBeenCalledOnce();
    expect(await otpStore.store.getPasswordReset(user.id)).toBeDefined();
  });

  it('allows only one of two concurrent password resets to update the password', async () => {
    process.env.STAGE = 'test';
    process.env.USE_DYNAMO_AUTH = 'false';
    const otpStore = createMemoryOtpStore();
    const user = {
      id: 'user_reset_concurrent',
      accountId: 'account_reset_concurrent',
      email: 'concurrent@example.com',
      name: 'Reset Owner',
      role: 'owner' as const,
      locale: 'fr' as const,
      accountStatus: 'active',
      passwordHash: await hashPassword('supersecret123'),
    };
    let updateCount = 0;
    const repository = {
      findUserByEmail: vi.fn().mockResolvedValue(user),
      updatePassword: vi.fn(async () => {
        updateCount += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }),
    };
    let code = '';
    await authService.requestPasswordReset(
      { email: user.email },
      repository as never,
      otpStore.store,
      (async (_sourceJobId: string, notification: { code: string }) => {
        code = notification.code;
      }) as never,
    );

    const results = await Promise.allSettled([
      authService.resetPassword(
        { email: user.email, code, newPassword: 'newsecret1234' },
        repository as never,
        otpStore.store,
      ),
      authService.resetPassword(
        { email: user.email, code, newPassword: 'othersecret123' },
        repository as never,
        otpStore.store,
      ),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected).toMatchObject({
      status: 'rejected',
      reason: { status: 401, code: 'INVALID_OTP' },
    });
    expect(updateCount).toBe(1);
  });

  it('returns INVALID_OTP for unknown accounts and accounts without a reset challenge', async () => {
    process.env.STAGE = 'test';
    process.env.USE_DYNAMO_AUTH = 'false';
    const otpStore = createMemoryOtpStore();
    const repository = { findUserByEmail: vi.fn().mockResolvedValue(undefined) };

    await expect(authService.resetPassword(
      { email: 'unknown@example.com', code: '123456', newPassword: 'newsecret1234' },
      repository as never,
      otpStore.store,
    )).rejects.toMatchObject({ status: 401, code: 'INVALID_OTP' });

    const user = {
      id: 'user_no_reset',
      accountId: 'account_no_reset',
      email: 'no-reset@example.com',
      name: 'Owner',
      role: 'owner' as const,
      locale: 'fr' as const,
      accountStatus: 'active',
      passwordHash: await hashPassword('supersecret123'),
    };
    repository.findUserByEmail.mockResolvedValue(user);
    await expect(authService.resetPassword(
      { email: user.email, code: '123456', newPassword: 'newsecret1234' },
      repository as never,
      otpStore.store,
    )).rejects.toMatchObject({ status: 401, code: 'INVALID_OTP' });
  });

  it('limits password reset verification to five atomic challenge attempts', async () => {
    process.env.STAGE = 'test';
    process.env.USE_DYNAMO_AUTH = 'false';
    const otpStore = createMemoryOtpStore();
    const user = {
      id: 'user_reset_attempt_limit',
      accountId: 'account_reset_attempt_limit',
      email: 'attempt-limit@example.com',
      name: 'Reset Owner',
      role: 'owner' as const,
      locale: 'fr' as const,
      accountStatus: 'active',
      passwordHash: await hashPassword('supersecret123'),
    };
    const repository = {
      findUserByEmail: vi.fn().mockResolvedValue(user),
      updatePassword: vi.fn(),
    };
    const enqueueNotification = vi.fn(async (sourceJobId: string, notification: { code: string }) => {
      expect(sourceJobId).toBeTruthy();
      expect(notification.code).toMatch(/^\d{6}$/);
    });
    await authService.requestPasswordReset(
      { email: user.email },
      repository as never,
      otpStore.store,
      enqueueNotification as never,
    );

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await expect(authService.resetPassword(
        { email: user.email, code: '000000', newPassword: 'newsupersecret123' },
        repository as never,
        otpStore.store,
      )).rejects.toMatchObject({ status: 401, code: 'INVALID_OTP' });
    }

    await expect(authService.resetPassword(
      { email: user.email, code: '000000', newPassword: 'newsupersecret123' },
      repository as never,
      otpStore.store,
    )).rejects.toMatchObject({ status: 429, code: 'OTP_ATTEMPTS_EXCEEDED' });
  });

  it('limits MFA challenge resends per user across replacement challenge tokens', async () => {
    process.env.STAGE = 'test';
    process.env.USE_DYNAMO_AUTH = 'false';
    const otpStore = createMemoryOtpStore();
    const repository = {
      findUserByEmail: async () => ({
        id: 'user_mfa_resend_limited',
        accountId: 'mfa-resend-account',
        email: 'mfa-resend@example.com',
        name: 'MFA Owner',
        role: 'owner' as const,
        locale: 'fr' as const,
        accountStatus: 'active',
        mfaEnabled: true,
        passwordHash: await hashPassword('supersecret123'),
      }),
      resetLoginFailures: vi.fn(),
    };
    const login = await authService.login(
      { email: 'mfa-resend@example.com', password: 'supersecret123' },
      repository as never,
      otpStore.store,
      async () => undefined,
    );
    if (!('mfaRequired' in login)) throw new Error('Expected an MFA challenge');

    let challengeToken = login.challengeToken;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const resent = await authService.resendMfaChallenge(challengeToken, otpStore.store, async () => undefined);
      expect(resent.sent).toBe(true);
      // Issue another challenge for the same user to verify the shared account-level limit.
      const next = await authService.login(
        { email: 'mfa-resend@example.com', password: 'supersecret123' },
        repository as never,
        otpStore.store,
        async () => undefined,
      );
      if (!('mfaRequired' in next)) throw new Error('Expected an MFA challenge');
      challengeToken = next.challengeToken;
    }

    await expect(authService.resendMfaChallenge(challengeToken, otpStore.store, async () => undefined)).rejects.toMatchObject({
      status: 429,
      code: 'RATE_LIMITED',
    });
  });

  it('rejects MFA completion if the account was disabled after the challenge was issued', async () => {
    process.env.USE_DYNAMO_AUTH = 'false';
    const otpStore = createMemoryOtpStore();
    const findUserByEmail = vi.fn()
      .mockResolvedValueOnce({
        id: 'user_mfa',
        accountId: 'mfa-account',
        email: 'owner@example.com',
        name: 'MFA Owner',
        role: 'owner',
        locale: 'fr',
        accountStatus: 'active',
        mfaEnabled: true,
        passwordHash: await hashPassword('supersecret123'),
      })
      .mockResolvedValueOnce({
        id: 'user_mfa',
        accountId: 'mfa-account',
        email: 'owner@example.com',
        name: 'MFA Owner',
        role: 'owner',
        locale: 'fr',
        accountStatus: 'disabled',
        mfaEnabled: true,
        passwordHash: 'unused',
      });
    const createSession = vi.fn();
    const repository = { findUserByEmail, createSession, resetLoginFailures: vi.fn() };

    const challenge = await authService.login(
      { email: 'owner@example.com', password: 'supersecret123' },
      repository as never,
      otpStore.store,
      async () => undefined,
    );
    if (!('mfaRequired' in challenge)) {
      throw new Error('Expected an MFA challenge');
    }

    await expect(
      authService.verifyMfa(
        { challengeToken: challenge.challengeToken, code: otpStore.codes.get(challenge.challengeToken)! },
        repository as never,
        otpStore.store,
      ),
    ).rejects.toMatchObject({ status: 403, code: 'ACCOUNT_DISABLED' });
    expect(createSession).not.toHaveBeenCalled();
  });

  it('reads a user through the system email directory when the table is configured', async () => {
    setDynamoAuthEnv();

    const repository = createDynamoAuthRepository({
      send: async (command: unknown) => {
        if (command instanceof GetCommand) {
          const input = command.input;

          if (input.Key?.PK === 'SYSTEM' && input.Key?.SK === 'EMAIL#owner@example.com') {
            return {
              Item: {
                PK: 'SYSTEM',
                SK: 'EMAIL#owner@example.com',
                accountId: 'account_123',
                userId: 'user_123',
              },
            };
          }

          if (input.Key?.PK === 'ACCOUNT#account_123' && input.Key?.SK === 'USER#user_123') {
            return {
              Item: {
                PK: 'ACCOUNT#account_123',
                SK: 'USER#user_123',
                accountId: 'account_123',
                userId: 'user_123',
                email: 'owner@example.com',
                name: 'Demo Owner',
                role: 'owner',
                locale: 'fr',
                passwordHash: 'hashed-password',
              },
            };
          }

          if (input.Key?.PK === 'ACCOUNT#account_123' && input.Key?.SK === 'META') {
            return { Item: { entityType: 'Account', status: 'active' } };
          }
        }

        return {};
      },
    } as unknown as DynamoDBDocumentClient);

    await expect(repository.findUserByEmail('Owner@Example.com')).resolves.toMatchObject({
      accountId: 'account_123',
      id: 'user_123',
      email: 'owner@example.com',
      role: 'owner',
      accountStatus: 'active',
    });
  });

  it('creates the account, user, and email directory as one transaction', async () => {
    setDynamoAuthEnv();

    const transactionCalls: Array<Record<string, unknown>> = [];

    const repository = createDynamoAuthRepository({
      send: async (command: unknown) => {
        if (command instanceof TransactWriteCommand) {
          transactionCalls.push(command.input as Record<string, unknown>);

          return {};
        }

        return {};
      },
    } as unknown as DynamoDBDocumentClient);

    await expect(
      repository.createAccountAndUser({
        accountName: 'Example rentals',
        ownerName: 'Jane Owner',
        email: 'jane@example.com',
        passwordHash: 'hashed-password',
        locale: 'fr',
      }),
    ).resolves.toMatchObject({
      account: { name: 'Example rentals' },
      user: { email: 'jane@example.com', role: 'owner' },
    });

    const transaction = (transactionCalls[0] ?? {}) as Record<string, unknown>;
    const items = ((transaction.TransactItems as Array<{ Put?: { Item?: Record<string, unknown> } }>) ?? []) as Array<{ Put?: { Item?: Record<string, unknown> } }>;
    expect(items).toHaveLength(3);
    expect(items[2]?.Put?.Item).toMatchObject({
      PK: 'SYSTEM',
      SK: 'EMAIL#jane@example.com',
      accountId: expect.any(String),
      userId: expect.any(String),
    });
  });

  it('creates a DynamoDB session only while its account is active', async () => {
    setDynamoAuthEnv();
    const transactions: Array<Record<string, unknown>> = [];
    const repository = createDynamoAuthRepository({
      send: async (command: unknown) => {
        if (command instanceof TransactWriteCommand) {
          transactions.push(command.input as Record<string, unknown>);
        }

        return {};
      },
    } as unknown as DynamoDBDocumentClient);

    await repository.createSession({
      userId: 'user_123',
      accountId: 'account_123',
      email: 'owner@example.com',
      role: 'owner',
      sessionId: 'session_123',
      familyId: 'family_123',
      refreshTokenHash: 'refresh_hash_123',
    });

    const items = transactions[0]?.TransactItems as Array<{
      ConditionCheck?: {
        Key?: Record<string, unknown>;
        ConditionExpression?: string;
      };
    }>;
    expect(items[0]?.ConditionCheck).toMatchObject({
      Key: { PK: 'ACCOUNT#account_123', SK: 'META' },
      ConditionExpression: '#status = :active AND #entityType = :account',
    });
  });

  it('loads the active session by user when the Dynamo session table is configured', async () => {
    setDynamoAuthEnv();

    const repository = createDynamoAuthRepository({
      send: async (command: unknown) => {
        if (command instanceof GetCommand) {
          const input = command.input;
          if (input.Key?.PK === 'SESSION#user_123' && input.Key?.SK === 'ACTIVE') {
            return {
              Item: {
                PK: 'SESSION#user_123',
                SK: 'ACTIVE',
                entityType: 'Session',
                userId: 'user_123',
                accountId: 'account_123',
                email: 'owner@example.com',
                role: 'owner',
                sessionId: 'session_123',
                familyId: 'family_123',
                refreshTokenHash: 'refresh_hash_123',
                active: true,
                issuedAt: '2024-01-01T00:00:00.000Z',
                expiresAt: '2024-02-01T00:00:00.000Z',
                revokedAt: null,
                createdAt: '2024-01-01T00:00:00.000Z',
                updatedAt: '2024-01-01T00:00:00.000Z',
              },
            };
          }
        }

        return {};
      },
    } as unknown as DynamoDBDocumentClient);

    await expect(repository.findSessionByUser('user_123')).resolves.toMatchObject({
      sessionId: 'session_123',
      accountId: 'account_123',
      refreshTokenHash: 'refresh_hash_123',
      active: true,
    });
  });

  it('recognizes consumed refresh-token markers for reuse handling', async () => {
    setDynamoAuthEnv();
    const repository = createDynamoAuthRepository({
      send: async (command: unknown) => {
        if (command instanceof ScanCommand) {
          return {
            Items: [
              {
                PK: 'SESSION#user_123',
                SK: 'USED#refresh_hash_123',
                entityType: 'ConsumedRefreshToken',
                userId: 'user_123',
                accountId: 'account_123',
                email: 'owner@example.com',
                role: 'owner',
                sessionId: 'session_123',
                familyId: 'family_123',
                refreshTokenHash: 'refresh_hash_123',
                active: false,
                expiresAt: '2024-02-01T00:00:00.000Z',
              },
            ],
          };
        }

        return {};
      },
    } as unknown as DynamoDBDocumentClient);

    await expect(repository.findSessionByRefreshTokenHash('refresh_hash_123')).resolves.toMatchObject({
      sessionId: 'session_123',
      familyId: 'family_123',
      consumedRefreshToken: true,
      active: false,
    });
  });

  it('atomically revokes the active family and records a security event on confirmed token reuse', async () => {
    setDynamoAuthEnv();
    let transaction: Record<string, unknown> | undefined;
    const repository = createDynamoAuthRepository({
      send: async (command: unknown) => {
        if (command instanceof GetCommand) {
          if (command.input.Key?.SK === 'USED#refresh_hash_123') {
            return {
              Item: {
                entityType: 'ConsumedRefreshToken',
                userId: 'user_123',
                accountId: 'account_123',
                role: 'owner',
                sessionId: 'session_123',
                familyId: 'family_123',
                refreshTokenHash: 'refresh_hash_123',
              },
            };
          }

          return {
            Item: {
              entityType: 'Session',
              userId: 'user_123',
              accountId: 'account_123',
              sessionId: 'session_123',
              familyId: 'family_123',
              active: true,
            },
          };
        }

        if (command instanceof TransactWriteCommand) {
          transaction = command.input as Record<string, unknown>;
        }

        return {};
      },
    } as unknown as DynamoDBDocumentClient);

    await expect(
      repository.revokeSessionAfterRefreshTokenReuse({
        userId: 'user_123',
        sessionId: 'session_123',
        familyId: 'family_123',
        refreshTokenHash: 'refresh_hash_123',
      }),
    ).resolves.toBe(true);

    const items = transaction?.TransactItems as Array<Record<string, unknown>>;
    expect(items).toHaveLength(3);
    expect(items?.[0]?.ConditionCheck).toMatchObject({
      Key: { PK: 'SESSION#user_123', SK: 'USED#refresh_hash_123' },
    });
    expect(items?.[1]?.Update).toMatchObject({
      Key: { PK: 'SESSION#user_123', SK: 'ACTIVE' },
    });
    expect(items?.[2]?.Put).toMatchObject({
      Item: {
        PK: 'AUDIT#account_123',
        entityType: 'SecurityEvent',
        action: 'AUTH_REFRESH_TOKEN_REUSE',
        targetId: 'session_123',
      },
    });
  });

  it('revokes the active local session family when a consumed token is replayed', async () => {
    process.env.STAGE = 'dev';
    process.env.USE_DYNAMO_AUTH = 'false';
    const repository = createAuthRepository();
    const session = await repository.createSession({
      userId: 'user_replay_test',
      accountId: 'account_replay_test',
      email: 'replay@example.test',
      role: 'owner',
      sessionId: 'session_replay_test',
      familyId: 'family_replay_test',
      refreshTokenHash: 'refresh_hash_old',
    });
    await repository.rotateSession({
      userId: session.userId,
      sessionId: session.sessionId,
      nextRefreshTokenHash: 'refresh_hash_current',
    });

    const consumedSession = await repository.findSessionByRefreshTokenHash('refresh_hash_old');
    expect(consumedSession?.consumedRefreshToken).toBe(true);

    await repository.revokeSessionAfterRefreshTokenReuse({
      userId: session.userId,
      sessionId: session.sessionId,
      familyId: session.familyId,
      refreshTokenHash: 'refresh_hash_old',
    });

    await expect(repository.findSessionByUser(session.userId)).resolves.toBeUndefined();
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

  it('requires DynamoDB auth storage in production even when the local fallback flag is false', () => {
    const previousStage = process.env.STAGE;
    const previousTableName = process.env.TABLE_NAME;
    const previousUseDynamo = process.env.USE_DYNAMO_AUTH;
    process.env.STAGE = 'prod';
    delete process.env.TABLE_NAME;
    process.env.USE_DYNAMO_AUTH = 'false';

    try {
      expect(() => createAuthRepository()).toThrow('TABLE_NAME must be configured for DynamoDB auth.');
    } finally {
      if (previousStage === undefined) {
        delete process.env.STAGE;
      } else {
        process.env.STAGE = previousStage;
      }

      if (previousTableName === undefined) {
        delete process.env.TABLE_NAME;
      } else {
        process.env.TABLE_NAME = previousTableName;
      }

      if (previousUseDynamo === undefined) {
        delete process.env.USE_DYNAMO_AUTH;
      } else {
        process.env.USE_DYNAMO_AUTH = previousUseDynamo;
      }
    }
  });

  it('does not fall back to process-local auth when the configured DynamoDB table is missing', async () => {
    setDynamoAuthEnv();
    const missingTableError = Object.assign(new Error('Table not found'), {
      name: 'ResourceNotFoundException',
    });
    const repository = createDynamoAuthRepository({
      send: async () => {
        throw missingTableError;
      },
    } as unknown as DynamoDBDocumentClient);

    await expect(repository.findUserByEmail('owner@example.com')).rejects.toBe(missingTableError);
  });
});
