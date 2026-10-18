import { AppError, UnauthenticatedError } from '../../shared/errors';
import { createAuthRepository } from './repository';
import { hashPassword, verifyPassword } from './passwords';
import { signAccessToken } from './tokens';
import type { LoginInput, LoginResult, RegisterInput, RegisterResult } from './types';

const defaultAuthRepository = createAuthRepository();

export const authService = {
  async login(
    { email, password }: LoginInput,
    repository = defaultAuthRepository,
  ): Promise<LoginResult> {
    const normalizedEmail = email.trim().toLowerCase();

    if (!normalizedEmail || !password) {
      throw new UnauthenticatedError('Invalid credentials');
    }

    const userRecord = await repository.findUserByEmail(normalizedEmail);

    if (!userRecord) {
      throw new UnauthenticatedError('Invalid credentials');
    }

    const isValidPassword = await verifyPassword(password, userRecord.passwordHash);

    if (!isValidPassword) {
      throw new UnauthenticatedError('Invalid credentials');
    }

    const accessToken = await signAccessToken({
      userId: userRecord.id,
      accountId: userRecord.accountId,
      email: userRecord.email,
      role: userRecord.role,
      sessionId: `session_${userRecord.id}`,
    });

    return {
      token: accessToken,
      accessToken,
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

  async register(
    input: RegisterInput,
    repository = defaultAuthRepository,
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
