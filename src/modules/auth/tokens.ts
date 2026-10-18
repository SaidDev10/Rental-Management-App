import { createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID } from 'node:crypto';

import { SignJWT, jwtVerify } from 'jose';

import { getSecret } from '../../shared/config/secrets';

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
let cachedKeyPairSource = '';

const loadPemKeyPair = async (): Promise<{ privateKey: ReturnType<typeof createPrivateKey>; publicKey: ReturnType<typeof createPublicKey> }> => {
  const explicitPrivateKey = process.env.JWT_PRIVATE_KEY;
  const explicitPublicKey = process.env.JWT_PUBLIC_KEY;
  const secretPrefix = process.env.SSM_PARAM_PREFIX;
  const useSsmKeys = process.env.USE_SSM_JWT_KEYS === 'true';

  if (explicitPrivateKey && explicitPublicKey) {
    return {
      privateKey: createPrivateKey(explicitPrivateKey),
      publicKey: createPublicKey(explicitPublicKey),
    };
  }

  if (useSsmKeys && secretPrefix) {
    const [privateKeyPem, publicKeyPem] = await Promise.all([
      getSecret(`${secretPrefix}/jwt/private-key`),
      getSecret(`${secretPrefix}/jwt/public-key`),
    ]);

    return {
      privateKey: createPrivateKey(privateKeyPem),
      publicKey: createPublicKey(publicKeyPem),
    };
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

  return {
    privateKey: createPrivateKey(generated.privateKey),
    publicKey: createPublicKey(generated.publicKey),
  };
};

const getKeyPair = async () => {
  const cacheKey = JSON.stringify({
    privateKey: Boolean(process.env.JWT_PRIVATE_KEY),
    publicKey: Boolean(process.env.JWT_PUBLIC_KEY),
    useSsmKeys: process.env.USE_SSM_JWT_KEYS === 'true',
    secretPrefix: process.env.SSM_PARAM_PREFIX ?? '',
  });

  if (cachedKeyPair === null || cachedKeyPairSource !== cacheKey) {
    cachedKeyPair = await loadPemKeyPair();
    cachedKeyPairSource = cacheKey;
  }

  return cachedKeyPair;
};

export const signAccessToken = async (input: {
  userId: string;
  accountId: string;
  email: string;
  role: 'owner' | 'super_admin';
  sessionId: string;
}): Promise<string> => {
  const { privateKey } = await getKeyPair();
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
  const { publicKey } = await getKeyPair();
  const { payload } = await jwtVerify(token, publicKey, {
    algorithms: ['RS256'],
    audience: 'rental-app-api',
    issuer: 'rental-app',
  });

  return payload as AccessTokenClaims;
};
