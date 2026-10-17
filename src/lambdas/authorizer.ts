import type { APIGatewayRequestAuthorizerEventV2 } from 'aws-lambda';
import { createPublicKey } from 'node:crypto';
import { jwtVerify } from 'jose';
import { z } from 'zod';

import { readAuthorizerConfig } from '../shared/config';
import { getSecret } from '../shared/config/secrets';

const config = readAuthorizerConfig();
const publicKey = createPublicKey(await getSecret(`${config.SSM_PARAM_PREFIX}/jwt/public-key`));

const accessClaimsSchema = z.object({
  sub: z.string().min(1),
  account_id: z.string().min(1),
  role: z.enum(['owner', 'super_admin']),
  email: z.string().email(),
  sid: z.string().min(1),
  imp: z.boolean().optional(),
  iat: z.number().int(),
  exp: z.number().int(),
  jti: z.string().min(1),
  iss: z.literal('rental-app'),
  aud: z.literal('rental-app-api'),
});

export const handler = async (event: APIGatewayRequestAuthorizerEventV2) => {
  const authorization = event.headers?.authorization;
  const token = authorization?.match(/^Bearer\s+(\S+)$/i)?.[1];

  if (!token) {
    return { isAuthorized: false };
  }

  try {
    const { payload } = await jwtVerify(token, publicKey, {
      algorithms: ['RS256'],
      issuer: 'rental-app',
      audience: 'rental-app-api',
      clockTolerance: 5,
    });
    const claims = accessClaimsSchema.parse(payload);

    return {
      isAuthorized: true,
      context: {
        userId: claims.sub,
        accountId: claims.account_id,
        role: claims.role,
        sid: claims.sid,
        impersonating: String(claims.imp === true),
      },
    };
  } catch {
    return { isAuthorized: false };
  }
};
