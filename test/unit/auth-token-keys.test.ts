import { generateKeyPairSync } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { signAccessToken, verifyAccessToken } from '../../src/modules/auth/tokens';

describe('JWT key configuration', () => {
  it('signs and verifies a token using explicitly configured PEM keys', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });

    const previousPrivateKey = process.env.JWT_PRIVATE_KEY;
    const previousPublicKey = process.env.JWT_PUBLIC_KEY;
    const previousUseSsm = process.env.USE_SSM_JWT_KEYS;
    process.env.JWT_PRIVATE_KEY = privateKey.toString();
    process.env.JWT_PUBLIC_KEY = publicKey.toString();
    delete process.env.USE_SSM_JWT_KEYS;

    try {
      const token = await signAccessToken({
        userId: 'user_123',
        accountId: 'demo-account',
        email: 'owner@example.com',
        role: 'owner',
        sessionId: 'session_123',
      });

      const claims = await verifyAccessToken(token);
      expect(claims.sub).toBe('user_123');
      expect(claims.account_id).toBe('demo-account');
    } finally {
      if (previousPrivateKey === undefined) {
        delete process.env.JWT_PRIVATE_KEY;
      } else {
        process.env.JWT_PRIVATE_KEY = previousPrivateKey;
      }

      if (previousPublicKey === undefined) {
        delete process.env.JWT_PUBLIC_KEY;
      } else {
        process.env.JWT_PUBLIC_KEY = previousPublicKey;
      }

      if (previousUseSsm === undefined) {
        delete process.env.USE_SSM_JWT_KEYS;
      } else {
        process.env.USE_SSM_JWT_KEYS = previousUseSsm;
      }
    }
  });
});
