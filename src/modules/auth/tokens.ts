import { createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID } from 'node:crypto';

import { SignJWT, jwtVerify } from 'jose';

export type AccessTokenClaims = {
  sub: string;
  account_id: string;
  role: 'owner' | 'super_admin';
  email: string;
  sid: string;
  iat: number;
  exp: number;
  jti: string;
  iss: 'rental-app';
  aud: 'rental-app-api';
};

let cachedKeyPair: { privateKey: ReturnType<typeof createPrivateKey>; publicKey: ReturnType<typeof createPublicKey> } | null = null;

const getKeyPair = () => {
  if (cachedKeyPair) {
    return cachedKeyPair;
  }

  const generated = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: {
      type: 'spki',
      format: 'pem',
    },
    privateKeyEncoding: {
      type: 'pkcs8',
      format: 'pem',
    },
  });

  cachedKeyPair = {
    privateKey: createPrivateKey(generated.privateKey),
    publicKey: createPublicKey(generated.publicKey),
  };

  return cachedKeyPair;
};

export const signAccessToken = async (input: {
  userId: string;
  accountId: string;
  email: string;
  role: 'owner' | 'super_admin';
  sessionId: string;
}): Promise<string> => {
  const { privateKey } = getKeyPair();
  const now = Math.floor(Date.now() / 1000);

  return new SignJWT({
    sub: input.userId,
    account_id: input.accountId,
    role: input.role,
    email: input.email,
    sid: input.sessionId,
  })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
    .setIssuedAt(now)
    .setIssuer('rental-app')
    .setAudience('rental-app-api')
    .setSubject(input.userId)
    .setExpirationTime(now + 900)
    .setJti(randomUUID())
    .sign(privateKey);
};

export const verifyAccessToken = async (token: string): Promise<AccessTokenClaims> => {
  const { publicKey } = getKeyPair();
  const { payload } = await jwtVerify(token, publicKey, {
    algorithms: ['RS256'],
    audience: 'rental-app-api',
    issuer: 'rental-app',
  });

  return payload as AccessTokenClaims;
};
