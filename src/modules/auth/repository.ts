import { GetCommand, TransactWriteCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { getDocumentClient } from '../../shared/db';
import { pk, sk } from '../../shared/db/keys';
import { hashPassword } from './passwords';
import type { AccountRecord, AuthUser } from './types';

export type AuthUserRecord = AuthUser & {
  passwordHash: string;
};

export type AuthRepository = {
  findUserByEmail: (email: string) => Promise<AuthUserRecord | undefined>;
  createAccountAndUser: (input: {
    accountName: string;
    ownerName: string;
    email: string;
    passwordHash: string;
    locale: 'fr' | 'en';
  }) => Promise<{ user: AuthUser; account: AccountRecord }>;
};

const usersByEmail = new Map<string, AuthUserRecord>();
const usersById = new Map<string, AuthUserRecord>();
const emailDirectory = new Map<string, { accountId: string; userId: string }>();
const accountsById = new Map<string, AccountRecord>();

const normalizeEmail = (email: string): string => email.trim().toLowerCase();

const isResourceNotFound = (error: unknown): boolean => {
  return !!(
    error &&
    typeof error === 'object' &&
    'name' in error &&
    (error as { name?: string }).name === 'ResourceNotFoundException'
  );
};

const isDuplicateEmailFailure = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const maybeError = error as {
    name?: string;
    message?: string;
    CancellationReasons?: Array<{ Code?: string; Message?: string }>;
  };

  if (maybeError.name === 'TransactionCanceledException') {
    return (maybeError.CancellationReasons ?? []).some(
      (reason) =>
        reason.Code === 'ConditionalCheckFailed' ||
        reason.Code === 'TransactionConflict' ||
        reason.Message === 'Email already taken',
    );
  }

  return maybeError.message === 'Email already taken';
};

const toAuthUserRecord = (item: Record<string, unknown>): AuthUserRecord => {
  const accountId = String(item.accountId ?? '');
  const userId = String(item.userId ?? item.id ?? '');
  const email = String(item.email ?? '');

  return {
    id: String(item.id ?? userId),
    accountId,
    email,
    name: String(item.name ?? 'Owner'),
    role: item.role === 'super_admin' ? 'super_admin' : 'owner',
    locale: item.locale === 'en' ? 'en' : 'fr',
    passwordHash: String(item.passwordHash ?? ''),
  };
};

const bootstrapDemoUser = async (): Promise<void> => {
  const email = 'owner@example.com';

  if (emailDirectory.has(email)) {
    return;
  }

  const accountId = 'demo-account';
  const userId = 'user_demo_owner';
  const userRecord: AuthUserRecord = {
    id: userId,
    accountId,
    email,
    name: 'Demo Owner',
    role: 'owner',
    locale: 'fr',
    passwordHash: await hashPassword('supersecret123'),
  };

  emailDirectory.set(email, { accountId, userId });
  usersById.set(userId, userRecord);
  accountsById.set(accountId, {
    id: accountId,
    name: 'Demo Rentals',
    locale: 'fr',
  });
  usersByEmail.set(email, userRecord);
};

const getLocalAuthRepository = (): AuthRepository => ({
  async findUserByEmail(email: string): Promise<AuthUserRecord | undefined> {
    await bootstrapDemoUser();

    return usersByEmail.get(normalizeEmail(email));
  },

  async createAccountAndUser({ accountName, ownerName, email, passwordHash, locale }) {
    const normalizedEmail = normalizeEmail(email);
    if (usersByEmail.has(normalizedEmail)) {
      throw new Error('Email already taken');
    }

    const accountId = `account_${Math.random().toString(36).slice(2, 10)}`;
    const userId = `user_${Math.random().toString(36).slice(2, 10)}`;
    const user: AuthUser = {
      id: userId,
      accountId,
      email: normalizedEmail,
      name: ownerName,
      role: 'owner',
      locale,
    };

    const account: AccountRecord = {
      id: accountId,
      name: accountName,
      locale,
    };

    const userRecord: AuthUserRecord = {
      ...user,
      passwordHash,
    };

    emailDirectory.set(normalizedEmail, { accountId, userId });
    usersByEmail.set(normalizedEmail, userRecord);
    usersById.set(userId, userRecord);
    accountsById.set(accountId, account);

    return { user, account };
  },
});

export const createDynamoAuthRepository = (client: DynamoDBDocumentClient): AuthRepository => ({
  async findUserByEmail(email: string): Promise<AuthUserRecord | undefined> {
    const normalizedEmail = normalizeEmail(email);
    const tableName = process.env.TABLE_NAME;
    const shouldUseDynamoAuth = process.env.USE_DYNAMO_AUTH === 'true';

    if (!tableName || !shouldUseDynamoAuth) {
      return getLocalAuthRepository().findUserByEmail(email);
    }

    try {
      const directoryResult = await client.send(
        new GetCommand({
          TableName: tableName,
          Key: { PK: 'SYSTEM', SK: `EMAIL#${normalizedEmail}` },
          ConsistentRead: true,
        }),
      );

      const directoryItem = directoryResult.Item as Record<string, unknown> | undefined;
      if (!directoryItem) {
        return undefined;
      }

      const accountId = String(directoryItem.accountId ?? '');
      const userId = String(directoryItem.userId ?? '');
      if (!accountId || !userId) {
        return undefined;
      }

      const userResult = await client.send(
        new GetCommand({
          TableName: tableName,
          Key: { PK: pk.account(accountId), SK: sk.user(userId) },
          ConsistentRead: true,
        }),
      );

      const userItem = userResult.Item as Record<string, unknown> | undefined;
      if (!userItem) {
        return undefined;
      }

      return toAuthUserRecord(userItem);
    } catch (error) {
      if (isResourceNotFound(error)) {
        return getLocalAuthRepository().findUserByEmail(email);
      }

      throw error;
    }
  },

  async createAccountAndUser({ accountName, ownerName, email, passwordHash, locale }) {
    const normalizedEmail = normalizeEmail(email);
    const tableName = process.env.TABLE_NAME;
    const shouldUseDynamoAuth = process.env.USE_DYNAMO_AUTH === 'true';

    if (!tableName || !shouldUseDynamoAuth) {
      return getLocalAuthRepository().createAccountAndUser({
        accountName,
        ownerName,
        email: normalizedEmail,
        passwordHash,
        locale,
      });
    }

    const accountId = `account_${Math.random().toString(36).slice(2, 10)}`;
    const userId = `user_${Math.random().toString(36).slice(2, 10)}`;
    const now = new Date().toISOString();
    const account: AccountRecord = {
      id: accountId,
      name: accountName,
      locale,
    };
    const user: AuthUser = {
      id: userId,
      accountId,
      email: normalizedEmail,
      name: ownerName,
      role: 'owner',
      locale,
    };

    try {
      await client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: tableName,
                Item: {
                  PK: pk.account(accountId),
                  SK: sk.meta(),
                  entityType: 'Account',
                  accountId,
                  name: accountName,
                  ownerEmail: normalizedEmail,
                  ownerName,
                  locale,
                  status: 'active',
                  createdAt: now,
                  updatedAt: now,
                },
              },
            },
            {
              Put: {
                TableName: tableName,
                Item: {
                  PK: pk.account(accountId),
                  SK: sk.user(userId),
                  entityType: 'User',
                  accountId,
                  userId,
                  email: normalizedEmail,
                  name: ownerName,
                  role: 'owner',
                  locale,
                  passwordHash,
                  passwordUpdatedAt: now,
                  mfaEnabled: false,
                  failedLoginAttempts: 0,
                  lockedUntil: null,
                  googleSub: null,
                  GSI2PK: `${pk.account(accountId)}#EMAIL#${normalizedEmail}`,
                  GSI2SK: sk.user(userId),
                  createdAt: now,
                  updatedAt: now,
                },
                ConditionExpression: 'attribute_not_exists(PK) AND attribute_not_exists(SK)',
              },
            },
            {
              Put: {
                TableName: tableName,
                Item: {
                  PK: 'SYSTEM',
                  SK: `EMAIL#${normalizedEmail}`,
                  entityType: 'EmailDirectory',
                  accountId,
                  userId,
                  email: normalizedEmail,
                  createdAt: now,
                  updatedAt: now,
                },
                ConditionExpression: 'attribute_not_exists(PK) AND attribute_not_exists(SK)',
              },
            },
          ],
        }),
      );

      return { user, account };
    } catch (error) {
      if (isDuplicateEmailFailure(error)) {
        throw new Error('Email already taken');
      }

      if (isResourceNotFound(error)) {
        return getLocalAuthRepository().createAccountAndUser({
          accountName,
          ownerName,
          email: normalizedEmail,
          passwordHash,
          locale,
        });
      }

      throw error;
    }
  },
});

export const createAuthRepository = (): AuthRepository => {
  const tableName = process.env.TABLE_NAME;
  const shouldUseDynamoAuth = process.env.USE_DYNAMO_AUTH === 'true';

  if (!tableName || !shouldUseDynamoAuth) {
    return getLocalAuthRepository();
  }

  return createDynamoAuthRepository(getDocumentClient());
};
