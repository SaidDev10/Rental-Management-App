import { createHash, createPrivateKey, createPublicKey, randomBytes, randomUUID } from 'node:crypto';

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
  imp?: boolean;
};

let cachedKeyPair: { privateKey: ReturnType<typeof createPrivateKey>; publicKey: ReturnType<typeof createPublicKey> } | null = null;
let cachedKeyPairSource = '';

const loadPemKeyPair = async (): Promise<{ privateKey: ReturnType<typeof createPrivateKey>; publicKey: ReturnType<typeof createPublicKey> }> => {
  const explicitPrivateKey = process.env.JWT_PRIVATE_KEY;
  const explicitPublicKey = process.env.JWT_PUBLIC_KEY;
  const secretPrefix = process.env.SSM_PARAM_PREFIX;
  const useSsmKeys = process.env.USE_SSM_JWT_KEYS === 'true' || process.env.STAGE === 'prod';

  if (Boolean(explicitPrivateKey) !== Boolean(explicitPublicKey)) {
    throw new Error('JWT_PRIVATE_KEY and JWT_PUBLIC_KEY must be configured together.');
  }

  if (process.env.STAGE !== 'prod' && explicitPrivateKey && explicitPublicKey) {
    return {
      privateKey: createPrivateKey(explicitPrivateKey),
      publicKey: createPublicKey(explicitPublicKey),
    };
  }

  if (useSsmKeys && !secretPrefix) {
    throw new Error('SSM_PARAM_PREFIX is required to load JWT keys from SSM.');
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

  throw new Error('JWT keys must be configured using PEM keys or SSM.');
};

const getKeyPair = async () => {
  const cacheKey = JSON.stringify({
    privateKey: process.env.JWT_PRIVATE_KEY
      ? createHash('sha256').update(process.env.JWT_PRIVATE_KEY).digest('hex')
      : '',
    publicKey: process.env.JWT_PUBLIC_KEY
      ? createHash('sha256').update(process.env.JWT_PUBLIC_KEY).digest('hex')
      : '',
    useSsmKeys: process.env.USE_SSM_JWT_KEYS === 'true',
    stage: process.env.STAGE ?? '',
    secretPrefix: process.env.SSM_PARAM_PREFIX ?? '',
  });

  if (cachedKeyPair === null || cachedKeyPairSource !== cacheKey) {
    cachedKeyPair = await loadPemKeyPair();
    cachedKeyPairSource = cacheKey;
  }

  return cachedKeyPair;
};

export const generateRefreshToken = (): string => randomBytes(32).toString('base64url');

export const hashRefreshToken = (token: string): string => createHash('sha256').update(token).digest('hex');

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


export const signImpersonationToken = async (input: {
  userId: string;
  accountId: string;
  email: string;
  sessionId: string;
}): Promise<string> => {
  const { privateKey } = await getKeyPair();
  const now = Math.floor(Date.now() / 1000);

  return new SignJWT({
    sub: input.userId,
    account_id: input.accountId,
    role: 'owner',
    email: input.email,
    sid: input.sessionId,
    imp: true,
  })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
    .setIssuedAt(now)
    .setIssuer('rental-app')
    .setAudience('rental-app-api')
    .setSubject(input.userId)
    .setExpirationTime(now + 30 * 60)
    .setJti(randomUUID())
    .sign(privateKey);
};
