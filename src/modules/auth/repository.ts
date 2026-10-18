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

const usersById = new Map<string, AuthUserRecord>();
const emailDirectory = new Map<string, { accountId: string; userId: string }>();
const accountsById = new Map<string, AccountRecord>();

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
};

export const createAuthRepository = (): AuthRepository => ({
  async findUserByEmail(email: string): Promise<AuthUserRecord | undefined> {
    await bootstrapDemoUser();

    const normalizedEmail = email.trim().toLowerCase();
    const directoryEntry = emailDirectory.get(normalizedEmail);

    if (!directoryEntry) {
      return undefined;
    }

    return usersById.get(directoryEntry.userId);
  },

  async createAccountAndUser({ accountName, ownerName, email, passwordHash, locale }) {
    const normalizedEmail = email.trim().toLowerCase();
    if (emailDirectory.has(normalizedEmail)) {
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
    usersById.set(userId, userRecord);
    accountsById.set(accountId, account);

    return { user, account };
  },
});
