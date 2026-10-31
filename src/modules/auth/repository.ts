import { randomUUID } from 'node:crypto';

import { GetCommand, ScanCommand, TransactWriteCommand, UpdateCommand, type DynamoDBDocumentClient, type ScanCommandInput } from '@aws-sdk/lib-dynamodb';
import { ulid } from 'ulid';

import { getDocumentClient } from '../../shared/db';
import { pk, sk } from '../../shared/db/keys';
import { hashPassword } from './passwords';
import type { AccountRecord, AuthUser } from './types';

export type AuthUserRecord = AuthUser & {
  passwordHash: string;
  accountStatus?: string | undefined;
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
  consumedRefreshToken?: boolean;
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
  findSessionStateByUser: (userId: string, sessionId?: string) => Promise<SessionRecord | undefined>;
  rotateSession: (input: {
    userId: string;
    sessionId: string;
    nextRefreshTokenHash: string;
    updatedAt?: string;
  }) => Promise<SessionRecord>;
  revokeSession: (userId: string, sessionId: string) => Promise<void>;
  updatePassword: (input: { userId: string; accountId: string; passwordHash: string }) => Promise<void>;
  revokeSessionAfterRefreshTokenReuse: (input: {
    userId: string;
    sessionId: string;
    familyId: string;
    refreshTokenHash: string;
  }) => Promise<boolean>;
};

const usersByEmail = new Map<string, AuthUserRecord>();
const usersById = new Map<string, AuthUserRecord>();
const emailDirectory = new Map<string, { accountId: string; userId: string }>();
const accountsById = new Map<string, AccountRecord>();
const accountStatuses = new Map<string, string>();
const sessionsByUserId = new Map<string, SessionRecord>();
const sessionsByRefreshHash = new Map<string, SessionRecord>();
const usedRefreshTokensByUser = new Map<string, Set<string>>();

const normalizeEmail = (email: string): string => email.trim().toLowerCase();

const usesDynamoAuth = (): boolean => {
  if (process.env.STAGE === 'prod' || process.env.USE_DYNAMO_AUTH === 'true') {
    return true;
  }

  if (
    (process.env.STAGE === 'dev' || process.env.STAGE === 'test') &&
    process.env.USE_DYNAMO_AUTH === 'false'
  ) {
    return false;
  }

  throw new Error('Auth storage must use DynamoDB, or be explicitly disabled for dev/test only.');
};

const getAuthTableName = (): string => {
  const tableName = process.env.TABLE_NAME;
  if (!tableName) {
    throw new Error('TABLE_NAME must be configured for DynamoDB auth.');
  }

  return tableName;
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

const toAuthUserRecord = (item: Record<string, unknown>, accountStatus?: string): AuthUserRecord => {
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
    accountStatus,
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
  accountStatuses.set(accountId, 'active');
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

    const user = usersByEmail.get(normalizeEmail(email));

    return user ? { ...user, accountStatus: accountStatuses.get(user.accountId) } : undefined;
  },

  async createAccountAndUser({ accountName, ownerName, email, passwordHash, locale }) {
    const normalizedEmail = normalizeEmail(email);
    if (usersByEmail.has(normalizedEmail)) {
      throw new Error('Email already taken');
    }

    const accountId = `account_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
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
    accountStatuses.set(accountId, 'active');
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

    if (usedRefreshTokensByUser.get(session.userId)?.has(refreshTokenHash)) {
      return {
        ...session,
        refreshTokenHash,
        active: false,
        consumedRefreshToken: true,
      };
    }

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

  async findSessionStateByUser(userId: string, sessionId?: string): Promise<SessionRecord | undefined> {
    const session = sessionsByUserId.get(userId);
    if (!session || (sessionId && session.sessionId !== sessionId)) return undefined;

    return session;
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

    sessionsByUserId.set(userId, revokedSession);
    sessionsByRefreshHash.set(session.refreshTokenHash, revokedSession);
  },

  async updatePassword({ userId, accountId, passwordHash }): Promise<void> {
    const user = usersById.get(userId);

    if (!user || user.accountId !== accountId) {
      return;
    }

    const nextUser: AuthUserRecord = {
      ...user,
      passwordHash,
    };

    usersById.set(userId, nextUser);
    usersByEmail.set(normalizeEmail(user.email), nextUser);
  },

  async revokeSessionAfterRefreshTokenReuse({ userId, sessionId, familyId, refreshTokenHash }) {
    if (!usedRefreshTokensByUser.get(userId)?.has(refreshTokenHash)) {
      return false;
    }

    const session = sessionsByUserId.get(userId);
    if (!session || session.sessionId !== sessionId || session.familyId !== familyId || !session.active) {
      return true;
    }

    const now = new Date().toISOString();
    const revokedSession: SessionRecord = {
      ...session,
      active: false,
      revokedAt: now,
      updatedAt: now,
    };
    sessionsByUserId.set(userId, revokedSession);
    sessionsByRefreshHash.set(session.refreshTokenHash, revokedSession);

    return true;
  },
});

export const createDynamoAuthRepository = (client: DynamoDBDocumentClient): AuthRepository => ({
  async findUserByEmail(email: string): Promise<AuthUserRecord | undefined> {
    const normalizedEmail = normalizeEmail(email);
    const shouldUseDynamoAuth = usesDynamoAuth();

    if (!shouldUseDynamoAuth) {
      return getLocalAuthRepository().findUserByEmail(email);
    }

    const tableName = getAuthTableName();
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

    const accountResult = await client.send(
      new GetCommand({
        TableName: tableName,
        Key: { PK: pk.account(accountId), SK: sk.meta() },
        ConsistentRead: true,
      }),
    );
    const accountItem = accountResult.Item as Record<string, unknown> | undefined;

    return toAuthUserRecord(userItem, typeof accountItem?.status === 'string' ? accountItem.status : undefined);
  },

  async createAccountAndUser({ accountName, ownerName, email, passwordHash, locale }) {
    const normalizedEmail = normalizeEmail(email);
    const shouldUseDynamoAuth = usesDynamoAuth();

    if (!shouldUseDynamoAuth) {
      return getLocalAuthRepository().createAccountAndUser({
        accountName,
        ownerName,
        email: normalizedEmail,
        passwordHash,
        locale,
      });
    }

    const tableName = getAuthTableName();
    const accountId = `account_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
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

      throw error;
    }
  },

  async createSession(input) {
    const shouldUseDynamoAuth = usesDynamoAuth();

    if (!shouldUseDynamoAuth) {
      return getLocalAuthRepository().createSession(input);
    }

    const tableName = getAuthTableName();
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
      new TransactWriteCommand({
        TransactItems: [
          {
            ConditionCheck: {
              TableName: tableName,
              Key: { PK: pk.account(input.accountId), SK: sk.meta() },
              ConditionExpression: '#status = :active AND #entityType = :account',
              ExpressionAttributeNames: { '#status': 'status', '#entityType': 'entityType' },
              ExpressionAttributeValues: { ':active': 'active', ':account': 'Account' },
            },
          },
          {
            Put: {
              TableName: tableName,
              Item: item,
            },
          },
        ],
      }),
    );

    return toSessionRecord(item);
  },

  async findSessionByRefreshTokenHash(refreshTokenHash: string) {
    const shouldUseDynamoAuth = usesDynamoAuth();

    if (!shouldUseDynamoAuth) {
      return getLocalAuthRepository().findSessionByRefreshTokenHash(refreshTokenHash);
    }

    const tableName = getAuthTableName();
    let exclusiveStartKey: ScanCommandInput['ExclusiveStartKey'];

    do {
      const result = await client.send(
        new ScanCommand({
          TableName: tableName,
          ConsistentRead: true,
          ExclusiveStartKey: exclusiveStartKey,
          FilterExpression: '(#entityType = :session OR #entityType = :consumed) AND #refreshTokenHash = :refreshTokenHash',
          ExpressionAttributeNames: {
            '#entityType': 'entityType',
            '#refreshTokenHash': 'refreshTokenHash',
          },
          ExpressionAttributeValues: {
            ':session': 'Session',
            ':consumed': 'ConsumedRefreshToken',
            ':refreshTokenHash': refreshTokenHash,
          },
        }),
      );

      const sessionItem = result.Items?.find((item) => item.entityType === 'Session');
      if (sessionItem) {
        return toSessionRecord(sessionItem);
      }

      const consumedItem = result.Items?.find((item) => item.entityType === 'ConsumedRefreshToken');
      if (consumedItem) {
        return {
          ...toSessionRecord(consumedItem),
          active: false,
          consumedRefreshToken: true,
        };
      }

      exclusiveStartKey = result.LastEvaluatedKey;
    } while (exclusiveStartKey);

    return undefined;
  },

  async findSessionByUser(userId: string, sessionId?: string) {
    const shouldUseDynamoAuth = usesDynamoAuth();

    if (!shouldUseDynamoAuth) {
      return getLocalAuthRepository().findSessionByUser(userId, sessionId);
    }

    const tableName = getAuthTableName();
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

  async findSessionStateByUser(userId: string, sessionId?: string) {
    const shouldUseDynamoAuth = usesDynamoAuth();
    if (!shouldUseDynamoAuth) return getLocalAuthRepository().findSessionStateByUser(userId, sessionId);

    const tableName = getAuthTableName();
    const result = await client.send(new GetCommand({
      TableName: tableName,
      Key: { PK: pk.session(userId), SK: sk.active() },
      ConsistentRead: true,
    }));
    const item = result.Item as Record<string, unknown> | undefined;
    if (!item || (sessionId && String(item.sessionId ?? '') !== sessionId)) return undefined;

    return toSessionRecord(item);
  },

  async rotateSession(input) {
    const shouldUseDynamoAuth = usesDynamoAuth();

    if (!shouldUseDynamoAuth) {
      return getLocalAuthRepository().rotateSession(input);
    }

    const tableName = getAuthTableName();
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
                email: currentSession.email,
                role: currentSession.role,
                familyId: currentSession.familyId,
                refreshTokenHash: currentSession.refreshTokenHash,
                expiresAt: currentSession.expiresAt,
                ttl: Math.floor(new Date(currentSession.expiresAt).getTime() / 1000),
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
    const shouldUseDynamoAuth = usesDynamoAuth();

    if (!shouldUseDynamoAuth) {
      return getLocalAuthRepository().revokeSession(userId, sessionId);
    }

    const tableName = getAuthTableName();
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

  async updatePassword({ userId, accountId, passwordHash }) {
    const shouldUseDynamoAuth = usesDynamoAuth();

    if (!shouldUseDynamoAuth) {
      return getLocalAuthRepository().updatePassword({ userId, accountId, passwordHash });
    }

    const tableName = getAuthTableName();
    const now = new Date().toISOString();

    await client.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { PK: pk.account(accountId), SK: sk.user(userId) },
        UpdateExpression: 'SET passwordHash = :passwordHash, passwordUpdatedAt = :now, updatedAt = :now',
        ExpressionAttributeValues: {
          ':passwordHash': passwordHash,
          ':now': now,
        },
      }),
    );
  },

  async revokeSessionAfterRefreshTokenReuse({ userId, sessionId, familyId, refreshTokenHash }) {
    const tableName = getAuthTableName();
    const markerResult = await client.send(
      new GetCommand({
        TableName: tableName,
        Key: { PK: pk.session(userId), SK: sk.usedRefreshToken(refreshTokenHash) },
        ConsistentRead: true,
      }),
    );
    const marker = markerResult.Item as Record<string, unknown> | undefined;
    if (!marker || marker.entityType !== 'ConsumedRefreshToken' || marker.familyId !== familyId) {
      return false;
    }

    const currentResult = await client.send(
      new GetCommand({
        TableName: tableName,
        Key: { PK: pk.session(userId), SK: sk.active() },
        ConsistentRead: true,
      }),
    );
    const current = currentResult.Item as Record<string, unknown> | undefined;
    if (
      !current ||
      current.active !== true ||
      current.sessionId !== sessionId ||
      current.familyId !== familyId
    ) {
      return true;
    }

    const now = new Date().toISOString();
    try {
      await client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              ConditionCheck: {
                TableName: tableName,
                Key: { PK: pk.session(userId), SK: sk.usedRefreshToken(refreshTokenHash) },
                ConditionExpression: 'attribute_exists(PK) AND familyId = :familyId',
                ExpressionAttributeValues: { ':familyId': familyId },
              },
            },
            {
              Update: {
                TableName: tableName,
                Key: { PK: pk.session(userId), SK: sk.active() },
                UpdateExpression: 'SET active = :false, revokedAt = :revokedAt, updatedAt = :updatedAt',
                ConditionExpression: 'sessionId = :sessionId AND familyId = :familyId AND active = :true',
                ExpressionAttributeValues: {
                  ':false': false,
                  ':true': true,
                  ':revokedAt': now,
                  ':updatedAt': now,
                  ':sessionId': sessionId,
                  ':familyId': familyId,
                },
              },
            },
            {
              Put: {
                TableName: tableName,
                Item: {
                  PK: pk.audit(String(marker.accountId)),
                  SK: sk.auditEntry(now, ulid()),
                  entityType: 'SecurityEvent',
                  actorUserId: userId,
                  actorRole: marker.role,
                  action: 'AUTH_REFRESH_TOKEN_REUSE',
                  targetType: 'Session',
                  targetId: sessionId,
                  outcome: 'failure',
                  metadata: { familyId },
                  createdAt: now,
                },
              },
            },
          ],
        }),
      );
    } catch (error) {
      if (!error || typeof error !== 'object' || !('name' in error) || error.name !== 'TransactionCanceledException') {
        throw error;
      }

      const latestResult = await client.send(
        new GetCommand({
          TableName: tableName,
          Key: { PK: pk.session(userId), SK: sk.active() },
          ConsistentRead: true,
        }),
      );
      const latest = latestResult.Item as Record<string, unknown> | undefined;
      if (latest?.active === true && latest.sessionId === sessionId && latest.familyId === familyId) {
        throw error;
      }
    }

    return true;
  },
});

export const createAuthRepository = (): AuthRepository => {
  const shouldUseDynamoAuth = usesDynamoAuth();

  if (!shouldUseDynamoAuth) {
    return getLocalAuthRepository();
  }

  getAuthTableName();

  return createDynamoAuthRepository(getDocumentClient());
};
