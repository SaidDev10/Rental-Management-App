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
};

export type AccountRecord = {
  id: string;
  name: string;
  locale: 'fr' | 'en';
};

export type LoginResult = {
  token: string;
  accessToken: string;
  accountId: string;
  user: AuthUser;
};

export type RegisterResult = {
  user: AuthUser;
  account: AccountRecord;
};
