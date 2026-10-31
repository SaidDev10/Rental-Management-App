import { createHash, randomInt, randomUUID } from 'node:crypto';

import { AppError, UnauthenticatedError } from '../../shared/errors';
import { enqueueNotification } from '../../shared/sqs/enqueue-notification';
import { baseLogger } from '../../shared/logger';
import {
  createMfaChallengeToken,
  createOtpChallengeStore,
  OtpChallengeError,
  type OtpChallenge,
  type OtpChallengeStore,
} from './otp-challenges';
import { createAuthRepository, type AuthRepository } from './repository';
import { hashPassword, verifyPassword } from './passwords';
import { enforceRateLimit } from '../../shared/security/rate-limit';
import { generateRefreshToken, hashRefreshToken, signAccessToken } from './tokens';
import type {
  LoginInput,
  LoginResult,
  MfaChallengeResult,
  MfaVerifyInput,
  RefreshResult,
  RegisterInput,
  RegisterResult,
} from './types';

const getDefaultAuthRepository = (): AuthRepository => createAuthRepository();

const assertAccountActive = (accountStatus: string | undefined): void => {
  if (accountStatus !== 'active') {
    throw new AppError('Account is disabled', 403, 'ACCOUNT_DISABLED');
  }
};

const getDefaultOtpChallengeStore = (): OtpChallengeStore => createOtpChallengeStore();
const hashCode = (code: string): string => createHash('sha256').update(code).digest('hex');
const generateOtp = (): string => `${randomInt(100_000, 1_000_000)}`;

const throwOtpChallengeError = (error: unknown): never => {
  if (!(error instanceof OtpChallengeError)) throw error;
  if (error.reason === 'expired') {
    throw new AppError('OTP expired', 410, 'OTP_EXPIRED');
  }
  if (error.reason === 'exhausted') {
    throw new AppError('OTP attempts exceeded', 429, 'OTP_ATTEMPTS_EXCEEDED');
  }

  throw new AppError('Invalid OTP challenge', 401, 'INVALID_OTP');
};

const createMfaChallenge = async (
  userRecord: { id: string; accountId: string; email: string },
  challengeStore: OtpChallengeStore,
): Promise<{ challengeToken: string; code: string; challenge: OtpChallenge }> => {
  const challengeToken = createMfaChallengeToken(userRecord.id);
  const code = generateOtp();
  const challenge = await challengeStore.create({
    userId: userRecord.id,
    accountId: userRecord.accountId,
    email: userRecord.email,
    purpose: 'LOGIN_MFA',
    challengeToken,
    code,
    expiresAt: Date.now() + 5 * 60 * 1000,
  });

  return { challengeToken, code, challenge };
};

const isLockedOut = (userRecord: { failedLoginAttempts?: number; lockedUntil?: string | null }): boolean => {
  const attempts = userRecord.failedLoginAttempts ?? 0;
  const lockedUntil = userRecord.lockedUntil ? new Date(userRecord.lockedUntil).getTime() : null;

  if (lockedUntil && lockedUntil > Date.now()) {
    return true;
  }

  return attempts >= 5 && (!lockedUntil || lockedUntil > Date.now());
};

export const authService = {
  async login(
    { email, password }: LoginInput,
    repository = getDefaultAuthRepository(),
    challengeStore?: OtpChallengeStore,
    enqueueMfaNotification = enqueueNotification,
  ): Promise<LoginResult | MfaChallengeResult> {
    const normalizedEmail = email.trim().toLowerCase();

    if (!normalizedEmail || !password) {
      throw new UnauthenticatedError('Invalid credentials');
    }

    const userRecord = await repository.findUserByEmail(normalizedEmail);

    if (!userRecord) {
      throw new UnauthenticatedError('Invalid credentials');
    }

    if (isLockedOut(userRecord)) {
      throw new AppError('Account locked', 423, 'ACCOUNT_LOCKED');
    }

    const isValidPassword = await verifyPassword(password, userRecord.passwordHash);

    if (!isValidPassword) {
      const nextAttempts = await repository.recordLoginFailure({
        userId: userRecord.id,
        accountId: userRecord.accountId,
      });

      if (nextAttempts >= 5) {
        throw new AppError('Account locked', 423, 'ACCOUNT_LOCKED');
      }

      throw new UnauthenticatedError('Invalid credentials');
    }

    assertAccountActive(userRecord.accountStatus);

    await repository.resetLoginFailures({
      userId: userRecord.id,
      accountId: userRecord.accountId,
    });

    if (userRecord.mfaEnabled) {
      const { challengeToken, code } = await createMfaChallenge(
        userRecord,
        challengeStore ?? getDefaultOtpChallengeStore(),
      );
      try {
        await enqueueMfaNotification(randomUUID(), {
          accountId: userRecord.accountId,
          kind: 'MFA_OTP',
          userId: userRecord.id,
          code,
          channel: 'email',
        });
      } catch (error) {
        baseLogger.error(
          { errorName: error instanceof Error ? error.name : 'UnknownError' },
          'MFA notification enqueue failed',
        );
        throw error;
      }

      return {
        mfaRequired: true,
        challengeToken,
        expiresIn: 300,
      };
    }

    const refreshToken = generateRefreshToken();
    const sessionId = `session_${randomUUID()}`;
    const familyId = `family_${randomUUID()}`;

    await repository.createSession({
      userId: userRecord.id,
      accountId: userRecord.accountId,
      email: userRecord.email,
      role: userRecord.role,
      sessionId,
      familyId,
      refreshTokenHash: hashRefreshToken(refreshToken),
    });

    const accessToken = await signAccessToken({
      userId: userRecord.id,
      accountId: userRecord.accountId,
      email: userRecord.email,
      role: userRecord.role,
      sessionId,
    });

    return {
      token: accessToken,
      accessToken,
      refreshToken,
      accountId: userRecord.accountId,
      user: {
        id: userRecord.id,
        accountId: userRecord.accountId,
        email: userRecord.email,
        name: userRecord.name,
        role: userRecord.role,
        locale: userRecord.locale,
      },
    };
  },

  async refresh(currentRefreshToken: string, repository = getDefaultAuthRepository()): Promise<RefreshResult> {
    if (!currentRefreshToken) {
      throw new AppError('Invalid refresh token', 401, 'INVALID_REFRESH');
    }

    const refreshTokenHash = hashRefreshToken(currentRefreshToken);
    const session = await repository.findSessionByRefreshTokenHash(refreshTokenHash);

    if (!session) {
      throw new AppError('Invalid refresh token', 401, 'INVALID_REFRESH');
    }

    if (session.consumedRefreshToken) {
      await repository.revokeSessionAfterRefreshTokenReuse({
        userId: session.userId,
        sessionId: session.sessionId,
        familyId: session.familyId,
        refreshTokenHash,
      });
      throw new AppError('Session revoked', 401, 'SESSION_REVOKED');
    }

    if (!session.active) {
      throw new AppError('Session revoked', 401, 'SESSION_REVOKED');
    }

    const nextRefreshToken = generateRefreshToken();
    const nextSession = await repository.rotateSession({
      userId: session.userId,
      sessionId: session.sessionId,
      nextRefreshTokenHash: hashRefreshToken(nextRefreshToken),
      updatedAt: new Date().toISOString(),
    });

    const accessToken = await signAccessToken({
      userId: nextSession.userId,
      accountId: nextSession.accountId,
      email: nextSession.email,
      role: nextSession.role,
      sessionId: nextSession.sessionId,
    });

    return {
      accessToken,
      refreshToken: nextRefreshToken,
    };
  },

  async verifyMfa(
    { challengeToken, code }: MfaVerifyInput,
    repository = getDefaultAuthRepository(),
    challengeStore: OtpChallengeStore = getDefaultOtpChallengeStore(),
  ): Promise<LoginResult> {
    const challenge = await challengeStore.getMfa(challengeToken);

    if (!challenge) {
      throw new AppError('Invalid MFA challenge', 401, 'INVALID_OTP');
    }

    if (Date.now() > challenge.expiresAt) {
      throw new AppError('OTP expired', 410, 'OTP_EXPIRED');
    }

    await enforceRateLimit('auth-mfa-user', challenge.userId, 10, 60 * 60);
    const updatedChallenge = await challengeStore
      .incrementAttempts(challenge, 5, Date.now())
      .catch((error: unknown) => throwOtpChallengeError(error));

    if (updatedChallenge.codeHash !== hashCode(code)) {
      if (updatedChallenge.attempts >= 5) {
        throw new AppError('OTP attempts exceeded', 429, 'OTP_ATTEMPTS_EXCEEDED');
      }
      throw new AppError('Invalid MFA code', 401, 'INVALID_OTP');
    }

    await challengeStore.delete(updatedChallenge, Date.now());

    const userRecord = await repository.findUserByEmail(challenge.email);

    if (!userRecord || userRecord.id !== challenge.userId || userRecord.accountId !== challenge.accountId) {
      throw new UnauthenticatedError('Invalid credentials');
    }

    assertAccountActive(userRecord.accountStatus);

    const refreshToken = generateRefreshToken();
    const sessionId = `session_${randomUUID()}`;
    const familyId = `family_${randomUUID()}`;

    await repository.createSession({
      userId: userRecord.id,
      accountId: userRecord.accountId,
      email: userRecord.email,
      role: userRecord.role,
      sessionId,
      familyId,
      refreshTokenHash: hashRefreshToken(refreshToken),
    });

    const accessToken = await signAccessToken({
      userId: userRecord.id,
      accountId: userRecord.accountId,
      email: userRecord.email,
      role: userRecord.role,
      sessionId,
    });

    return {
      token: accessToken,
      accessToken,
      refreshToken,
      accountId: userRecord.accountId,
      user: {
        id: userRecord.id,
        accountId: userRecord.accountId,
        email: userRecord.email,
        name: userRecord.name,
        role: userRecord.role,
        locale: userRecord.locale,
      },
    };
  },

  async resendMfaChallenge(
    challengeToken: string,
    challengeStore: OtpChallengeStore = getDefaultOtpChallengeStore(),
    enqueueMfaNotification = enqueueNotification,
  ): Promise<{ sent: true }> {
    const challenge = await challengeStore.getMfa(challengeToken);

    if (!challenge) {
      throw new AppError('Invalid MFA challenge', 401, 'INVALID_OTP');
    }

    if (Date.now() > challenge.expiresAt) {
      throw new AppError('OTP expired', 410, 'OTP_EXPIRED');
    }
    await enforceRateLimit('auth-mfa-resend-user', challenge.userId, 3, 60 * 60);

    const nextChallenge = await createMfaChallenge({
      id: challenge.userId,
      accountId: challenge.accountId,
      email: challenge.email,
    }, challengeStore);

    try {
      await enqueueMfaNotification(randomUUID(), {
        accountId: challenge.accountId,
        kind: 'MFA_OTP',
        userId: challenge.userId,
        code: nextChallenge.code,
        channel: 'email',
      });
    } catch (error) {
      baseLogger.error(
        { errorName: error instanceof Error ? error.name : 'UnknownError' },
        'MFA notification enqueue failed',
      );
      throw error;
    }

    await challengeStore.delete(challenge, Date.now());

    return { sent: true };
  },

  async requestPasswordReset(
    { email }: { email: string },
    repository = getDefaultAuthRepository(),
    challengeStore: OtpChallengeStore = getDefaultOtpChallengeStore(),
    enqueueResetNotification = enqueueNotification,
  ): Promise<{ sent: true }> {
    const normalizedEmail = email.trim().toLowerCase();
    if (!normalizedEmail) {
      throw new AppError('Validation error', 400, 'VALIDATION_ERROR');
    }

    await enforceRateLimit('auth-password-reset-email', normalizedEmail, 3, 60 * 60);

    const userRecord = await repository.findUserByEmail(normalizedEmail);
    if (!userRecord) {
      return { sent: true };
    }

    const code = generateOtp();
    try {
      await challengeStore.create({
        userId: userRecord.id,
        accountId: userRecord.accountId,
        email: userRecord.email,
        purpose: 'PASSWORD_RESET',
        challengeToken: randomUUID(),
        code,
        expiresAt: Date.now() + 5 * 60 * 1000,
      });
    } catch (error) {
      baseLogger.error(
        { errorName: error instanceof Error ? error.name : 'UnknownError' },
        'Password reset challenge persistence failed',
      );
      throw error;
    }

    try {
      await enqueueResetNotification(randomUUID(), {
        accountId: userRecord.accountId,
        kind: 'PASSWORD_RESET',
        userId: userRecord.id,
        code,
        channel: 'email',
      });
    } catch (error) {
      baseLogger.error(
        { errorName: error instanceof Error ? error.name : 'UnknownError' },
        'Password reset notification enqueue failed',
      );
      throw error;
    }

    return { sent: true };
  },

  async resetPassword(
    { email, code, newPassword }: { email: string; code: string; newPassword: string },
    repository = getDefaultAuthRepository(),
    challengeStore: OtpChallengeStore = getDefaultOtpChallengeStore(),
  ): Promise<{ passwordReset: true }> {
    if (newPassword.length < 12) {
      throw new AppError('Validation error', 400, 'VALIDATION_ERROR');
    }

    const normalizedEmail = email.trim().toLowerCase();
    const userRecord = normalizedEmail ? await repository.findUserByEmail(normalizedEmail) : undefined;
    const challenge = userRecord ? await challengeStore.getPasswordReset(userRecord.id) : undefined;
    if (!userRecord || !challenge || challenge.email !== normalizedEmail || challenge.userId !== userRecord.id) {
      throw new AppError('Invalid password reset code', 401, 'INVALID_OTP');
    }

    if (Date.now() > challenge.expiresAt) {
      throw new AppError('Invalid password reset code', 401, 'INVALID_OTP');
    }

    const updatedChallenge = await challengeStore
      .incrementAttempts(challenge, 5, Date.now())
      .catch((error: unknown) => throwOtpChallengeError(error));

    if (updatedChallenge.codeHash !== hashCode(code)) {
      if (updatedChallenge.attempts >= 5) {
        throw new AppError('OTP attempts exceeded', 429, 'OTP_ATTEMPTS_EXCEEDED');
      }
      throw new AppError('Invalid password reset code', 401, 'INVALID_OTP');
    }

    const passwordHash = await hashPassword(newPassword);
    await challengeStore
      .completePasswordReset(updatedChallenge, passwordHash, () => repository.updatePassword({
        userId: userRecord.id,
        accountId: userRecord.accountId,
        passwordHash,
      }))
      .catch((error: unknown) => throwOtpChallengeError(error));

    return { passwordReset: true };
  },

  async logout(userId: string, sessionId: string, repository = getDefaultAuthRepository()): Promise<void> {
    await repository.revokeSession(userId, sessionId);
  },

  async register(
    input: RegisterInput,
    repository = getDefaultAuthRepository(),
  ): Promise<RegisterResult> {
    const normalizedEmail = input.email.trim().toLowerCase();

    if (!normalizedEmail || input.password.length < 8) {
      throw new AppError('Validation error', 400, 'VALIDATION_ERROR');
    }

    try {
      const { user, account } = await repository.createAccountAndUser({
        accountName: input.accountName,
        ownerName: input.ownerName,
        email: normalizedEmail,
        passwordHash: await hashPassword(input.password),
        locale: input.locale ?? 'fr',
      });

      return { user, account };
    } catch (error) {
      if (error instanceof Error && error.message === 'Email already taken') {
        throw new AppError('Email already taken', 409, 'EMAIL_TAKEN');
      }

      throw error;
    }
  },
};
