export type AuthEnv = {
  Variables: {
    accountId: string;
    userId: string;
    role: 'owner' | 'super_admin';
    email: string;
    sessionId: string;
  };
};

export type LoginInput = {
  email: string;
  password: string;
};

export type RegisterInput = {
  accountName: string;
  ownerName: string;
  email: string;
  password: string;
  phone: string;
  locale?: 'fr' | 'en' | undefined;
};

export type AuthUser = {
  id: string;
  accountId: string;
  email: string;
  name: string;
  role: 'owner' | 'super_admin';
  locale: 'fr' | 'en';
  mfaEnabled?: boolean;
};

export type AccountRecord = {
  id: string;
  name: string;
  locale: 'fr' | 'en';
};

export type LoginResult = {
  token: string;
  accessToken: string;
  refreshToken: string;
  accountId: string;
  user: AuthUser;
};

export type MfaChallengeResult = {
  mfaRequired: true;
  challengeToken: string;
  expiresIn: number;
};

export type MfaVerifyInput = {
  challengeToken: string;
  code: string;
};

export type RefreshResult = {
  accessToken: string;
  refreshToken: string;
};

export type RegisterResult = {
  user: AuthUser;
  account: AccountRecord;
};
