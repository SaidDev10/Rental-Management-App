import { hash, verify } from '@node-rs/argon2';

export const hashPassword = async (password: string): Promise<string> => {
  return hash(password);
};

export const verifyPassword = async (password: string, passwordHash: string): Promise<boolean> => {
  return verify(passwordHash, password);
};
