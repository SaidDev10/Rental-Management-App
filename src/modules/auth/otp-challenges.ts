import { createHash, randomUUID } from 'node:crypto';

import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  TransactWriteCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';

import { getDocumentClient } from '../../shared/db';
import { pk, sk } from '../../shared/db/keys';

export type OtpPurpose = 'LOGIN_MFA' | 'PASSWORD_RESET';

export type OtpChallenge = {
  userId: string;
  accountId: string;
  email: string;
  purpose: OtpPurpose;
  challengeToken: string;
  challengeId: string;
  codeHash: string;
  expiresAt: number;
  attempts: number;
  consumedAt?: number;
};

export type OtpChallengeStore = {
  create: (input: Omit<OtpChallenge, 'challengeId' | 'codeHash' | 'attempts'> & { code: string }) => Promise<OtpChallenge>;
  getMfa: (challengeToken: string) => Promise<OtpChallenge | undefined>;
  getPasswordReset: (userId: string) => Promise<OtpChallenge | undefined>;
  incrementAttempts: (challenge: OtpChallenge, maxAttempts: number, now: number) => Promise<OtpChallenge>;
  delete: (challenge: OtpChallenge, now: number) => Promise<void>;
  completePasswordReset: (
    challenge: OtpChallenge,
    passwordHash: string,
    updateLocalPassword: () => Promise<void>,
  ) => Promise<void>;
};

export class OtpChallengeError extends Error {
  constructor(readonly reason: 'missing' | 'expired' | 'exhausted' | 'replaced' | 'consumed') {
    super(`OTP challenge is ${reason}.`);
    this.name = 'OtpChallengeError';
  }
}

const hashCode = (code: string): string => createHash('sha256').update(code).digest('hex');
const conditionalFailure = (error: unknown): boolean =>
  error instanceof Error && error.name === 'ConditionalCheckFailedException';
const transactionFailure = (error: unknown): boolean =>
  error instanceof Error && error.name === 'TransactionCanceledException';

const decodeMfaToken = (token: string): { userId: string } | undefined => {
  if (token.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(token)) return undefined;

  try {
    const parsed: unknown = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'userId' in parsed &&
      typeof parsed.userId === 'string' &&
      parsed.userId.length > 0 &&
      !parsed.userId.includes('#') &&
      'nonce' in parsed &&
      typeof parsed.nonce === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(parsed.nonce)
    ) {
      return { userId: parsed.userId };
    }
  } catch {
    return undefined;
  }

  return undefined;
};

export const createMfaChallengeToken = (userId: string): string =>
  Buffer.from(JSON.stringify({ userId, nonce: randomUUID() })).toString('base64url');

export const createOtpChallengeStore = (
  client: DynamoDBDocumentClient = getDocumentClient(),
  tableName: string = process.env.TABLE_NAME ?? '',
): OtpChallengeStore => {
  if (!tableName) {
    throw new Error('TABLE_NAME must be configured for OTP challenge storage.');
  }

  const keyFor = (challenge: Pick<OtpChallenge, 'userId' | 'purpose' | 'challengeToken'>) => ({
    PK: pk.otp(challenge.userId),
    SK: sk.otpPurpose(challenge.purpose),
  });

  const get = async (
    userId: string,
    purpose: OtpPurpose,
    challengeToken: string,
  ): Promise<OtpChallenge | undefined> => {
    const result = await client.send(new GetCommand({
      TableName: tableName,
      Key: keyFor({ userId, purpose, challengeToken }),
      ConsistentRead: true,
    }));

    return result.Item as OtpChallenge | undefined;
  };

  return {
    async create(input) {
      const record: OtpChallenge = {
        userId: input.userId,
        accountId: input.accountId,
        email: input.email,
        purpose: input.purpose,
        challengeToken: input.challengeToken,
        challengeId: randomUUID(),
        codeHash: hashCode(input.code),
        expiresAt: input.expiresAt,
        attempts: 0,
      };

      await client.send(new PutCommand({
        TableName: tableName,
        Item: {
          ...keyFor(record),
          ...record,
          entityType: 'OtpChallenge',
          ttl: Math.ceil(record.expiresAt / 1000),
        },
      }));

      return record;
    },

    async getMfa(challengeToken) {
      const decoded = decodeMfaToken(challengeToken);
      if (!decoded) return undefined;
      const challenge = await get(decoded.userId, 'LOGIN_MFA', challengeToken);

      return challenge?.challengeToken === challengeToken && challenge.purpose === 'LOGIN_MFA'
        ? challenge
        : undefined;
    },

    async getPasswordReset(userId) {
      const challenge = await get(userId, 'PASSWORD_RESET', '');

      return challenge?.purpose === 'PASSWORD_RESET' ? challenge : undefined;
    },

    async incrementAttempts(challenge, maxAttempts, now) {
      try {
        const result = await client.send(new UpdateCommand({
          TableName: tableName,
          Key: keyFor(challenge),
          UpdateExpression: 'ADD attempts :one',
          ConditionExpression: 'attribute_exists(PK) AND challengeId = :challengeId AND expiresAt > :now AND attempts < :maxAttempts AND attribute_not_exists(consumedAt)',
          ExpressionAttributeValues: {
            ':one': 1,
            ':challengeId': challenge.challengeId,
            ':now': now,
            ':maxAttempts': maxAttempts,
          },
          ReturnValues: 'ALL_NEW',
        }));

        return result.Attributes as OtpChallenge;
      } catch (error) {
        if (!conditionalFailure(error)) throw error;

        const current = await get(challenge.userId, challenge.purpose, challenge.challengeToken);
        if (!current) throw new OtpChallengeError('missing');
        if (current.challengeId !== challenge.challengeId) throw new OtpChallengeError('replaced');
        if (current.expiresAt <= now) throw new OtpChallengeError('expired');
        if (current.consumedAt !== undefined) throw new OtpChallengeError('consumed');
        if (current.attempts >= maxAttempts) throw new OtpChallengeError('exhausted');
        throw new OtpChallengeError('missing');
      }
    },

    async delete(challenge, now) {
      try {
        await client.send(new DeleteCommand({
          TableName: tableName,
          Key: keyFor(challenge),
          ConditionExpression: 'challengeId = :challengeId AND codeHash = :codeHash AND expiresAt > :now AND attribute_not_exists(consumedAt)',
          ExpressionAttributeValues: {
            ':challengeId': challenge.challengeId,
            ':codeHash': challenge.codeHash,
            ':now': now,
          },
        }));
      } catch (error) {
        if (conditionalFailure(error)) throw new OtpChallengeError('consumed');
        throw error;
      }
    },

    async completePasswordReset(challenge, passwordHash) {
      const now = Date.now();
      try {
        await client.send(new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: tableName,
                Key: { PK: pk.account(challenge.accountId), SK: sk.user(challenge.userId) },
                UpdateExpression: 'SET passwordHash = :passwordHash, passwordUpdatedAt = :now, updatedAt = :now',
                ConditionExpression: 'attribute_exists(PK) AND accountId = :accountId',
                ExpressionAttributeValues: {
                  ':passwordHash': passwordHash,
                  ':now': new Date(now).toISOString(),
                  ':accountId': challenge.accountId,
                },
              },
            },
            {
              Delete: {
                TableName: tableName,
                Key: keyFor(challenge),
                ConditionExpression: 'challengeId = :challengeId AND codeHash = :codeHash AND expiresAt > :now AND attribute_not_exists(consumedAt) AND attempts <= :maxAttempts',
                ExpressionAttributeValues: {
                  ':challengeId': challenge.challengeId,
                  ':codeHash': challenge.codeHash,
                  ':now': now,
                  ':maxAttempts': 5,
                },
              },
            },
          ],
        }));
      } catch (error) {
        if (!transactionFailure(error) && !conditionalFailure(error)) throw error;

        const current = await get(challenge.userId, challenge.purpose, challenge.challengeToken);
        if (!current) throw new OtpChallengeError('consumed');
        if (current.challengeId !== challenge.challengeId) throw new OtpChallengeError('replaced');
        if (current.expiresAt <= now) throw new OtpChallengeError('expired');
        if (current.consumedAt !== undefined) throw new OtpChallengeError('consumed');
        if (current.attempts > 5) throw new OtpChallengeError('exhausted');

        // The challenge remains valid; the transaction likely failed for another
        // condition (for example, the account record no longer matches).
        throw error;
      }
    },
  };
};
