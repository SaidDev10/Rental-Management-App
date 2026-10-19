import { GetCommand, PutCommand, ScanCommand, TransactWriteCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { getDocumentClient } from '../../shared/db';
import { pk, sk } from '../../shared/db/keys';
import { hashPassword } from './passwords';
import type { AccountRecord, AuthUser } from './types';

export type AuthUserRecord = AuthUser & {
  passwordHash: string;
  failedLoginAttempts?: number;
  lockedUntil?: string | null;
};

export type SessionRecord = {
  userId: string;
  accountId: string;
  email: string;
  role: 'owner' | 'super_admin';
  sessionId: string;
  familyId: string;
  refreshTokenHash: string;
  active: boolean;
  issuedAt: string;
  expiresAt: string;
  revokedAt: string | null;
  createdAt: string;
  updatedAt: string;
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
  createSession: (input: {
    userId: string;
    accountId: string;
    email: string;
    role: 'owner' | 'super_admin';
    sessionId: string;
    familyId: string;
    refreshTokenHash: string;
  }) => Promise<SessionRecord>;
  findSessionByRefreshTokenHash: (refreshTokenHash: string) => Promise<SessionRecord | undefined>;
  findSessionByUser: (userId: string, sessionId?: string) => Promise<SessionRecord | undefined>;
  rotateSession: (input: {
    userId: string;
    sessionId: string;
    nextRefreshTokenHash: string;
    updatedAt?: string;
  }) => Promise<SessionRecord>;
  revokeSession: (userId: string, sessionId: string) => Promise<void>;
};

const usersByEmail = new Map<string, AuthUserRecord>();
const usersById = new Map<string, AuthUserRecord>();
const emailDirectory = new Map<string, { accountId: string; userId: string }>();
const accountsById = new Map<string, AccountRecord>();
const sessionsByUserId = new Map<string, SessionRecord>();
const sessionsByRefreshHash = new Map<string, SessionRecord>();
const usedRefreshTokensByUser = new Map<string, Set<string>>();

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
    failedLoginAttempts: Number(item.failedLoginAttempts ?? 0),
    lockedUntil: item.lockedUntil === null || item.lockedUntil === undefined ? null : String(item.lockedUntil),
  };
};

const toSessionRecord = (item: Record<string, unknown>): SessionRecord => ({
  userId: String(item.userId ?? ''),
  accountId: String(item.accountId ?? ''),
  email: String(item.email ?? ''),
  role: item.role === 'super_admin' ? 'super_admin' : 'owner',
  sessionId: String(item.sessionId ?? ''),
  familyId: String(item.familyId ?? ''),
  refreshTokenHash: String(item.refreshTokenHash ?? ''),
  active: item.active === undefined ? true : Boolean(item.active),
  issuedAt: String(item.issuedAt ?? item.createdAt ?? new Date().toISOString()),
  expiresAt: String(item.expiresAt ?? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()),
  revokedAt: item.revokedAt === null || item.revokedAt === undefined ? null : String(item.revokedAt),
  createdAt: String(item.createdAt ?? item.issuedAt ?? new Date().toISOString()),
  updatedAt: String(item.updatedAt ?? item.createdAt ?? item.issuedAt ?? new Date().toISOString()),
});

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
    failedLoginAttempts: 0,
    lockedUntil: null,
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

  async createSession({ userId, accountId, email, role, sessionId, familyId, refreshTokenHash }) {
    const now = new Date();
    const issuedAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const session: SessionRecord = {
      userId,
      accountId,
      email,
      role,
      sessionId,
      familyId,
      refreshTokenHash,
      active: true,
      issuedAt,
      expiresAt,
      revokedAt: null,
      createdAt: issuedAt,
      updatedAt: issuedAt,
    };

    sessionsByUserId.set(userId, session);
    sessionsByRefreshHash.set(refreshTokenHash, session);
    usedRefreshTokensByUser.set(userId, new Set(usedRefreshTokensByUser.get(userId) ?? []));

    return session;
  },

  async findSessionByRefreshTokenHash(refreshTokenHash: string): Promise<SessionRecord | undefined> {
    const session = sessionsByRefreshHash.get(refreshTokenHash);

    if (!session) {
      return undefined;
    }

    const current = sessionsByUserId.get(session.userId);

    return current && current.refreshTokenHash === refreshTokenHash ? current : session;
  },

  async findSessionByUser(userId: string, sessionId?: string): Promise<SessionRecord | undefined> {
    const session = sessionsByUserId.get(userId);

    if (!session) {
      return undefined;
    }

    if (sessionId && session.sessionId !== sessionId) {
      return undefined;
    }

    return session.active ? session : undefined;
  },

  async rotateSession({ userId, sessionId, nextRefreshTokenHash, updatedAt }) {
    const session = sessionsByUserId.get(userId);

    if (!session || session.sessionId !== sessionId) {
      throw new Error('Session not found');
    }

    const nowIso = updatedAt ?? new Date().toISOString();
    const rotatedSession: SessionRecord = {
      ...session,
      active: false,
      revokedAt: nowIso,
      updatedAt: nowIso,
    };

    const usedHashes = usedRefreshTokensByUser.get(userId) ?? new Set<string>();
    usedHashes.add(session.refreshTokenHash);
    usedRefreshTokensByUser.set(userId, usedHashes);

    sessionsByRefreshHash.set(session.refreshTokenHash, rotatedSession);

    const nextSession: SessionRecord = {
      ...session,
      refreshTokenHash: nextRefreshTokenHash,
      active: true,
      issuedAt: session.issuedAt ?? nowIso,
      expiresAt: session.expiresAt ?? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      revokedAt: null,
      updatedAt: nowIso,
    };

    sessionsByRefreshHash.set(nextRefreshTokenHash, nextSession);
    sessionsByUserId.set(userId, nextSession);

    return nextSession;
  },

  async revokeSession(userId: string, sessionId: string): Promise<void> {
    const session = sessionsByUserId.get(userId);

    if (!session || session.sessionId !== sessionId) {
      return;
    }

    const revokedSession: SessionRecord = {
      ...session,
      active: false,
      revokedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const usedHashes = usedRefreshTokensByUser.get(userId) ?? new Set<string>();
    usedHashes.add(session.refreshTokenHash);
    usedRefreshTokensByUser.set(userId, usedHashes);

    sessionsByUserId.set(userId, revokedSession);
    sessionsByRefreshHash.set(session.refreshTokenHash, revokedSession);
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

  async createSession(input) {
    const tableName = process.env.TABLE_NAME;
    const shouldUseDynamoAuth = process.env.USE_DYNAMO_AUTH === 'true';

    if (!tableName || !shouldUseDynamoAuth) {
      return getLocalAuthRepository().createSession(input);
    }

    const now = new Date();
    const issuedAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const item = {
      PK: pk.session(input.userId),
      SK: sk.active(),
      entityType: 'Session',
      userId: input.userId,
      accountId: input.accountId,
      email: input.email,
      role: input.role,
      sessionId: input.sessionId,
      familyId: input.familyId,
      refreshTokenHash: input.refreshTokenHash,
      active: true,
      issuedAt,
      expiresAt,
      revokedAt: null,
      createdAt: issuedAt,
      updatedAt: issuedAt,
    };

    await client.send(
      new PutCommand({
        TableName: tableName,
        Item: item,
      }),
    );

    return toSessionRecord(item);
  },

  async findSessionByRefreshTokenHash(refreshTokenHash: string) {
    const tableName = process.env.TABLE_NAME;
    const shouldUseDynamoAuth = process.env.USE_DYNAMO_AUTH === 'true';

    if (!tableName || !shouldUseDynamoAuth) {
      return getLocalAuthRepository().findSessionByRefreshTokenHash(refreshTokenHash);
    }

    const result = await client.send(
      new ScanCommand({
        TableName: tableName,
        FilterExpression: '#entityType = :session AND #refreshTokenHash = :refreshTokenHash',
        ExpressionAttributeNames: {
          '#entityType': 'entityType',
          '#refreshTokenHash': 'refreshTokenHash',
        },
        ExpressionAttributeValues: {
          ':session': 'Session',
          ':refreshTokenHash': refreshTokenHash,
        },
      }),
    );

    const sessionItem = result.Items?.find((item) => item.active !== false) ?? result.Items?.[0];
    if (!sessionItem) {
      return undefined;
    }

    return toSessionRecord(sessionItem);
  },

  async findSessionByUser(userId: string, sessionId?: string) {
    const tableName = process.env.TABLE_NAME;
    const shouldUseDynamoAuth = process.env.USE_DYNAMO_AUTH === 'true';

    if (!tableName || !shouldUseDynamoAuth) {
      return getLocalAuthRepository().findSessionByUser(userId, sessionId);
    }

    const result = await client.send(
      new GetCommand({
        TableName: tableName,
        Key: { PK: pk.session(userId), SK: sk.active() },
        ConsistentRead: true,
      }),
    );

    const item = result.Item as Record<string, unknown> | undefined;
    if (!item) {
      return undefined;
    }

    if (sessionId && String(item.sessionId ?? '') !== sessionId) {
      return undefined;
    }

    const session = toSessionRecord(item);

    return session.active ? session : undefined;
  },

  async rotateSession(input) {
    const tableName = process.env.TABLE_NAME;
    const shouldUseDynamoAuth = process.env.USE_DYNAMO_AUTH === 'true';

    if (!tableName || !shouldUseDynamoAuth) {
      return getLocalAuthRepository().rotateSession(input);
    }

    const sessionItem = await client.send(
      new GetCommand({
        TableName: tableName,
        Key: { PK: pk.session(input.userId), SK: sk.active() },
        ConsistentRead: true,
      }),
    );

    const currentItem = sessionItem.Item as Record<string, unknown> | undefined;
    if (!currentItem || String(currentItem.sessionId ?? '') !== input.sessionId) {
      throw new Error('Session not found');
    }

    const currentSession = toSessionRecord(currentItem);
    const now = input.updatedAt ?? new Date().toISOString();
    const nextSession = {
      ...currentSession,
      refreshTokenHash: input.nextRefreshTokenHash,
      active: true,
      revokedAt: null,
      updatedAt: now,
    };

    await client.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: tableName,
              Key: { PK: pk.session(input.userId), SK: sk.active() },
              UpdateExpression: 'SET refreshTokenHash = :refreshTokenHash, active = :active, updatedAt = :updatedAt, revokedAt = :revokedAt, expiresAt = :expiresAt',
              ConditionExpression: 'sessionId = :sessionId AND active = :true',
              ExpressionAttributeValues: {
                ':refreshTokenHash': input.nextRefreshTokenHash,
                ':active': true,
                ':updatedAt': now,
                ':revokedAt': null,
                ':expiresAt': currentSession.expiresAt,
                ':sessionId': input.sessionId,
                ':true': true,
              },
            },
          },
          {
            Put: {
              TableName: tableName,
              Item: {
                PK: pk.session(input.userId),
                SK: sk.usedRefreshToken(currentSession.refreshTokenHash),
                entityType: 'ConsumedRefreshToken',
                sessionId: currentSession.sessionId,
                userId: currentSession.userId,
                accountId: currentSession.accountId,
                familyId: currentSession.familyId,
                refreshTokenHash: currentSession.refreshTokenHash,
                expiresAt: currentSession.expiresAt,
                createdAt: now,
                updatedAt: now,
              },
              ConditionExpression: 'attribute_not_exists(PK) AND attribute_not_exists(SK)',
            },
          },
        ],
      }),
    );

    return nextSession;
  },

  async revokeSession(userId: string, sessionId: string) {
    const tableName = process.env.TABLE_NAME;
    const shouldUseDynamoAuth = process.env.USE_DYNAMO_AUTH === 'true';

    if (!tableName || !shouldUseDynamoAuth) {
      return getLocalAuthRepository().revokeSession(userId, sessionId);
    }

    const currentItem = await client.send(
      new GetCommand({
        TableName: tableName,
        Key: { PK: pk.session(userId), SK: sk.active() },
        ConsistentRead: true,
      }),
    );

    const existing = currentItem.Item as Record<string, unknown> | undefined;
    if (!existing || String(existing.sessionId ?? '') !== sessionId) {
      return;
    }

    const now = new Date().toISOString();
    await client.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { PK: pk.session(userId), SK: sk.active() },
        UpdateExpression: 'SET active = :active, revokedAt = :revokedAt, updatedAt = :updatedAt',
        ConditionExpression: 'sessionId = :sessionId',
        ExpressionAttributeValues: {
          ':active': false,
          ':revokedAt': now,
          ':updatedAt': now,
          ':sessionId': sessionId,
        },
      }),
    );
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
