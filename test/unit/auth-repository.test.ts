import { DynamoDBDocumentClient, GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { afterEach, describe, expect, it } from 'vitest';

import { createDynamoAuthRepository } from '../../src/modules/auth/repository';
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
