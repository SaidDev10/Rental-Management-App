import { AppError, UnauthenticatedError } from '../../shared/errors';
import { hashPassword, verifyPassword } from './passwords';
import { signAccessToken } from './tokens';
import type { AuthUser, LoginInput, LoginResult, RegisterInput, RegisterResult } from './types';

const demoUsers = new Map<string, { user: AuthUser; passwordHash: string }>([
  [
    'owner@example.com',
    {
      user: {
        id: 'user_demo_owner',
        accountId: 'ACCOUNT#demo-account',
        email: 'owner@example.com',
        name: 'Demo Owner',
        role: 'owner',
        locale: 'fr',
      },
      passwordHash: '',
    },
  ],
]);

const ensureDemoUserHash = async () => {
  const demoUser = demoUsers.get('owner@example.com');

  if (!demoUser || demoUser.passwordHash) {
    return;
  }

  demoUser.passwordHash = await hashPassword('supersecret123');
};

export const authService = {
  async login({ email, password }: LoginInput): Promise<LoginResult> {
    const normalizedEmail = email.trim().toLowerCase();

    if (!normalizedEmail || !password) {
      throw new UnauthenticatedError('Invalid credentials');
    }

    await ensureDemoUserHash();

    const entry = demoUsers.get(normalizedEmail);

    if (!entry) {
      throw new UnauthenticatedError('Invalid credentials');
    }

    const isValidPassword = await verifyPassword(password, entry.passwordHash);

    if (!isValidPassword) {
      throw new UnauthenticatedError('Invalid credentials');
    }

    const accessToken = await signAccessToken({
      userId: entry.user.id,
      accountId: entry.user.accountId,
      email: entry.user.email,
      role: entry.user.role,
      sessionId: `session_${entry.user.id}`,
    });

    return {
      token: accessToken,
      accessToken,
      accountId: entry.user.accountId,
      user: entry.user,
    };
  },

  async register(input: RegisterInput): Promise<RegisterResult> {
    const normalizedEmail = input.email.trim().toLowerCase();

    if (!normalizedEmail || input.password.length < 8) {
      throw new AppError('Validation error', 400, 'VALIDATION_ERROR');
    }

    if (demoUsers.has(normalizedEmail)) {
      throw new AppError('Email already taken', 409, 'EMAIL_TAKEN');
    }

    const accountId = `ACCOUNT#${normalizedEmail.replace(/[^a-z0-9]+/gi, '').slice(0, 20) || 'account'}`;
    const userId = `user_${Math.random().toString(36).slice(2, 10)}`;
    const locale = input.locale ?? 'fr';
    const user: AuthUser = {
      id: userId,
      accountId,
      email: normalizedEmail,
      name: input.ownerName,
      role: 'owner',
      locale,
    };

    demoUsers.set(normalizedEmail, {
      user,
      passwordHash: await hashPassword(input.password),
    });

    return {
      user,
      account: {
        id: accountId,
        name: input.accountName,
        locale,
      },
    };
  },
};
