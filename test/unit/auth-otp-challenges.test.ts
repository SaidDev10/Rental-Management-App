import {
  DynamoDBDocumentClient,
  DeleteCommand,
  GetCommand,
  PutCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createMfaChallengeToken,
  createOtpChallengeStore,
  OtpChallengeError,
} from '../../src/modules/auth/otp-challenges';

const clientMock = mockClient(DynamoDBDocumentClient);
const tableName = 'auth-otp-test';

beforeEach(() => clientMock.reset());
afterEach(() => clientMock.reset());

const store = () => createOtpChallengeStore(
  clientMock as unknown as DynamoDBDocumentClient,
  tableName,
);

describe('OTP challenge DynamoDB storage', () => {
  it('stores password reset state under the user OTP partition and purpose key with TTL', async () => {
    let putInput: PutCommand['input'] | undefined;
    clientMock.on(PutCommand).callsFake(async (input) => {
      putInput = input;

      return {};
    });

    await store().create({
      userId: 'user-otp',
      accountId: 'account-otp',
      email: 'owner@example.test',
      purpose: 'PASSWORD_RESET',
      challengeToken: 'reset-internal-token',
      code: '123456',
      expiresAt: 1_800_000_123_456,
    });

    expect(putInput?.Item).toMatchObject({
      PK: 'OTP#user-otp',
      SK: 'PASSWORD_RESET',
      entityType: 'OtpChallenge',
      purpose: 'PASSWORD_RESET',
      attempts: 0,
      ttl: 1_800_000_124,
    });
    expect(putInput?.Item).not.toHaveProperty('code');
    expect(putInput?.Item?.codeHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('increments attempts with an atomic conditional limit and returns the persisted count', async () => {
    const challengeToken = createMfaChallengeToken('user-mfa');
    const challenge = {
      userId: 'user-mfa',
      accountId: 'account-mfa',
      email: 'mfa@example.test',
      purpose: 'LOGIN_MFA' as const,
      challengeToken,
      challengeId: 'challenge-1',
      codeHash: 'hash',
      expiresAt: 1_800_000_000_000,
      attempts: 0,
    };
    const updated = { ...challenge, attempts: 1 };
    let updateInput: UpdateCommand['input'] | undefined;
    clientMock.on(UpdateCommand).callsFake(async (input) => {
      updateInput = input;

      return { Attributes: updated };
    });

    await expect(store().incrementAttempts(challenge, 5, 1_799_999_000_000)).resolves.toEqual(updated);
    expect(updateInput?.Key).toEqual({ PK: 'OTP#user-mfa', SK: 'LOGIN_MFA' });
    expect(updateInput?.ConditionExpression).toContain('attempts < :maxAttempts');
    expect(updateInput?.ConditionExpression).toContain('expiresAt > :now');
    expect(updateInput?.ExpressionAttributeValues).toMatchObject({
      ':maxAttempts': 5,
      ':one': 1,
      ':challengeId': 'challenge-1',
    });
  });

  it('rejects attempts once the conditional DynamoDB counter is exhausted', async () => {
    const challengeToken = createMfaChallengeToken('user-mfa-limit');
    const challenge = {
      userId: 'user-mfa-limit',
      accountId: 'account-mfa',
      email: 'mfa@example.test',
      purpose: 'LOGIN_MFA' as const,
      challengeToken,
      challengeId: 'challenge-limit',
      codeHash: 'hash',
      expiresAt: 1_800_000_000_000,
      attempts: 4,
    };
    const conditionalError = Object.assign(new Error('condition failed'), {
      name: 'ConditionalCheckFailedException',
    });
    clientMock.on(UpdateCommand).rejects(conditionalError);
    clientMock.on(GetCommand).resolves({ Item: { ...challenge, attempts: 5 } });

    await expect(store().incrementAttempts(challenge, 5, 1_799_999_000_000))
      .rejects.toBeInstanceOf(OtpChallengeError);
    await expect(store().incrementAttempts(challenge, 5, 1_799_999_000_000))
      .rejects.toMatchObject({ reason: 'exhausted' });
  });

  it('conditionally deletes only the current, unexpired challenge', async () => {
    const challengeToken = createMfaChallengeToken('user-mfa-delete');
    const challenge = {
      userId: 'user-mfa-delete',
      accountId: 'account-mfa',
      email: 'mfa@example.test',
      purpose: 'LOGIN_MFA' as const,
      challengeToken,
      challengeId: 'challenge-delete',
      codeHash: 'hash',
      expiresAt: 1_800_000_000_000,
      attempts: 1,
    };
    let deleteInput: DeleteCommand['input'] | undefined;
    clientMock.on(DeleteCommand).callsFake(async (input) => {
      deleteInput = input;

      return {};
    });

    await store().delete(challenge, 1_799_999_000_000);

    expect(deleteInput?.ConditionExpression).toContain('challengeId = :challengeId');
    expect(deleteInput?.ConditionExpression).toContain('expiresAt > :now');
    expect(deleteInput?.ConditionExpression).toContain('codeHash = :codeHash');
  });

  it('updates the password and consumes the OTP in one conditional DynamoDB transaction', async () => {
    const challenge = {
      userId: 'user-reset-transaction',
      accountId: 'account-reset-transaction',
      email: 'reset@example.test',
      purpose: 'PASSWORD_RESET' as const,
      challengeToken: 'internal-token',
      challengeId: 'reset-challenge-id',
      codeHash: 'expected-code-hash',
      expiresAt: 1_800_000_000_000,
      attempts: 1,
    };
    let transactionInput: TransactWriteCommand['input'] | undefined;
    clientMock.on(TransactWriteCommand).callsFake(async (input) => {
      transactionInput = input;

      return {};
    });
    const updateLocalPassword = vi.fn(async () => undefined);

    await store().completePasswordReset(challenge, 'password-hash', updateLocalPassword);

    expect(updateLocalPassword).not.toHaveBeenCalled();
    expect(transactionInput?.TransactItems).toHaveLength(2);
    expect(transactionInput?.TransactItems?.[0]?.Update).toMatchObject({
      TableName: tableName,
      Key: { PK: 'ACCOUNT#account-reset-transaction', SK: 'USER#user-reset-transaction' },
      ConditionExpression: expect.stringContaining('attribute_exists(PK)'),
    });
    expect(transactionInput?.TransactItems?.[0]?.Update?.UpdateExpression)
      .toContain('SET passwordHash = :passwordHash');
    expect(transactionInput?.TransactItems?.[1]?.Delete).toMatchObject({
      TableName: tableName,
      Key: { PK: 'OTP#user-reset-transaction', SK: 'PASSWORD_RESET' },
      ConditionExpression: expect.stringContaining('challengeId = :challengeId'),
    });
    expect(transactionInput?.TransactItems?.[1]?.Delete?.ConditionExpression)
      .toContain('codeHash = :codeHash');
    expect(transactionInput?.TransactItems?.[1]?.Delete?.ConditionExpression)
      .toContain('expiresAt > :now');
    expect(transactionInput?.TransactItems?.[1]?.Delete?.ConditionExpression)
      .toContain('attribute_not_exists(consumedAt)');
  });

  it('propagates a failed reset transaction when the challenge remains valid', async () => {
    const challenge = {
      userId: 'user-reset-transaction-failure',
      accountId: 'account-reset-transaction-failure',
      email: 'reset-failure@example.test',
      purpose: 'PASSWORD_RESET' as const,
      challengeToken: 'internal-token',
      challengeId: 'reset-challenge-failure',
      codeHash: 'expected-code-hash',
      expiresAt: 1_800_000_000_000,
      attempts: 1,
    };
    const transactionFailure = Object.assign(new Error('transaction cancelled'), {
      name: 'TransactionCanceledException',
    });
    clientMock.on(TransactWriteCommand).rejects(transactionFailure);
    clientMock.on(GetCommand).resolves({ Item: challenge });

    await expect(store().completePasswordReset(challenge, 'password-hash', vi.fn()))
      .rejects.toBe(transactionFailure);
  });
});
