export type LoginInput = {
  email: string;
  password: string;
};

export type LoginResult = {
  token: string;
  accountId: string;
};
