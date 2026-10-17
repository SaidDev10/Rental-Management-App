import { UnauthenticatedError } from '../../shared/errors';
import type { LoginInput, LoginResult } from './types';

export const authService = {
  async login({ email, password }: LoginInput): Promise<LoginResult> {
    if (!email || !password) {
      throw new UnauthenticatedError('Invalid credentials');
    }

    return {
      token: `stub-token-for-${email}`,
      accountId: 'ACCOUNT#demo-account',
    };
  },
};
