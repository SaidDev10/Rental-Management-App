import { randomUUID } from 'node:crypto';

import { AppError, UnauthenticatedError } from '../../shared/errors';
import { createAuthRepository, type AuthRepository } from './repository';
import { hashPassword, verifyPassword } from './passwords';
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

type MfaChallenge = {
  userId: string;
  accountId: string;
  email: string;
  code: string;
  expiresAt: number;
  attempts: number;
};

const mfaChallenges = new Map<string, MfaChallenge>();

const isLockedOut = (userRecord: { failedLoginAttempts?: number; lockedUntil?: string | null }): boolean => {
  const attempts = userRecord.failedLoginAttempts ?? 0;
  const lockedUntil = userRecord.lockedUntil ? new Date(userRecord.lockedUntil).getTime() : null;

  if (lockedUntil && lockedUntil > Date.now()) {
    return true;
  }

  return attempts >= 5 && (!lockedUntil || lockedUntil > Date.now());
};

const createMfaChallenge = (userRecord: { id: string; accountId: string; email: string; mfaEnabled?: boolean }): { challengeToken: string; challenge: MfaChallenge } => {
  const challengeToken = randomUUID();
  const code = `${Math.floor(100000 + Math.random() * 900000)}`;
  const challenge: MfaChallenge = {
    userId: userRecord.id,
    accountId: userRecord.accountId,
    email: userRecord.email,
    code,
    expiresAt: Date.now() + 5 * 60 * 1000,
    attempts: 0,
  };

  mfaChallenges.set(challengeToken, challenge);

  return { challengeToken, challenge };
};

export const authService = {
  async login(
    { email, password }: LoginInput,
    repository = getDefaultAuthRepository(),
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
      const nextAttempts = (userRecord.failedLoginAttempts ?? 0) + 1;
      userRecord.failedLoginAttempts = nextAttempts;

      if (nextAttempts >= 5) {
        userRecord.lockedUntil = new Date(Date.now() + 15 * 60 * 1000).toISOString();
        throw new AppError('Account locked', 423, 'ACCOUNT_LOCKED');
      }

      throw new UnauthenticatedError('Invalid credentials');
    }

    userRecord.failedLoginAttempts = 0;
    userRecord.lockedUntil = null;

    if (userRecord.mfaEnabled) {
      const { challengeToken } = createMfaChallenge(userRecord);

      return {
        mfaRequired: true,
        challengeToken,
        expiresIn: 300,
      };
    }

    const refreshToken = generateRefreshToken();
    const sessionId = `session_${userRecord.id}`;
    const familyId = `family_${userRecord.id}`;

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

    const session = await repository.findSessionByRefreshTokenHash(hashRefreshToken(currentRefreshToken));

    if (!session) {
      throw new AppError('Invalid refresh token', 401, 'INVALID_REFRESH');
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

  async verifyMfa({ challengeToken, code }: MfaVerifyInput, repository = getDefaultAuthRepository()): Promise<LoginResult> {
    const challenge = mfaChallenges.get(challengeToken);

    if (!challenge) {
      throw new AppError('Invalid MFA challenge', 401, 'INVALID_OTP');
    }

    if (Date.now() > challenge.expiresAt) {
      mfaChallenges.delete(challengeToken);
      throw new AppError('OTP expired', 410, 'OTP_EXPIRED');
    }

    challenge.attempts += 1;

    if (challenge.attempts > 5) {
      mfaChallenges.delete(challengeToken);
      throw new AppError('OTP attempts exceeded', 429, 'OTP_ATTEMPTS_EXCEEDED');
    }

    if (challenge.code !== code) {
      if (challenge.attempts >= 5) {
        mfaChallenges.delete(challengeToken);
        throw new AppError('OTP attempts exceeded', 429, 'OTP_ATTEMPTS_EXCEEDED');
      }

      throw new AppError('Invalid MFA code', 401, 'INVALID_OTP');
    }

    mfaChallenges.delete(challengeToken);

    const userRecord = await repository.findUserByEmail(challenge.email);

    if (!userRecord) {
      throw new UnauthenticatedError('Invalid credentials');
    }

    const refreshToken = generateRefreshToken();
    const sessionId = `session_${userRecord.id}`;
    const familyId = `family_${userRecord.id}`;

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

  async resendMfaChallenge(challengeToken: string): Promise<{ sent: true }> {
    const challenge = mfaChallenges.get(challengeToken);

    if (!challenge) {
      throw new AppError('Invalid MFA challenge', 401, 'INVALID_OTP');
    }

    if (Date.now() > challenge.expiresAt) {
      mfaChallenges.delete(challengeToken);
      throw new AppError('OTP expired', 410, 'OTP_EXPIRED');
    }

    const nextChallenge = createMfaChallenge({
      id: challenge.userId,
      accountId: challenge.accountId,
      email: challenge.email,
    });

    mfaChallenges.delete(challengeToken);
    mfaChallenges.set(nextChallenge.challengeToken, nextChallenge.challenge);

    return { sent: true };
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
