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

const bootstrapDemoUser = async (): Promise<void> => {
  const email = 'owner@example.com';

  if (usersByEmail.has(email)) {
    return;
  }

  usersByEmail.set(email, {
    id: 'user_demo_owner',
    accountId: 'demo-account',
    email,
    name: 'Demo Owner',
    role: 'owner',
    locale: 'fr',
    passwordHash: await hashPassword('supersecret123'),
  });
};

export const createAuthRepository = (): AuthRepository => ({
  async findUserByEmail(email: string): Promise<AuthUserRecord | undefined> {
    await bootstrapDemoUser();

    return usersByEmail.get(email.trim().toLowerCase());
  },

  async createAccountAndUser({ accountName, ownerName, email, passwordHash, locale }) {
    const normalizedEmail = email.trim().toLowerCase();
    if (usersByEmail.has(normalizedEmail)) {
      throw new Error('Email already taken');
    }

    const accountId = `demo-account-${Math.random().toString(36).slice(2, 10)}`;
    const userId = `user_${Math.random().toString(36).slice(2, 10)}`;
    const user: AuthUser = {
      id: userId,
      accountId,
      email: normalizedEmail,
      name: ownerName,
      role: 'owner',
      locale,
    };

    usersByEmail.set(normalizedEmail, {
      ...user,
      passwordHash,
    });

    return {
      user,
      account: {
        id: accountId,
        name: accountName,
        locale,
      },
    };
  },
});
