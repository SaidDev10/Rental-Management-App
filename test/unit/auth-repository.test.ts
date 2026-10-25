import { DynamoDBDocumentClient, GetCommand, ScanCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { afterEach, describe, expect, it } from 'vitest';

import { createAuthRepository, createDynamoAuthRepository } from '../../src/modules/auth/repository';
import { hashPassword } from '../../src/modules/auth/passwords';
import { authService } from '../../src/modules/auth/service';

const setDynamoAuthEnv = (): void => {
  process.env.TABLE_NAME = 'rental-app-test';
  process.env.USE_DYNAMO_AUTH = 'true';
};

afterEach(() => {
  delete process.env.TABLE_NAME;
  delete process.env.USE_DYNAMO_AUTH;
});

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
      createSession: async () => ({
        userId: 'user_123',
        accountId: 'demo-account',
        email: 'owner@example.com',
        role: 'owner',
        sessionId: 'session_user_123',
        familyId: 'family_user_123',
      }),
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
        }

        return {};
      },
    } as unknown as DynamoDBDocumentClient);

    await expect(repository.findUserByEmail('Owner@Example.com')).resolves.toMatchObject({
      accountId: 'account_123',
      id: 'user_123',
      email: 'owner@example.com',
      role: 'owner',
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
