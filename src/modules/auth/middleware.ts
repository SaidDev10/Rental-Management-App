import type { MiddlewareHandler } from 'hono';

import { UnauthenticatedError } from '../../shared/errors';
import { createAuthRepository, type AuthRepository } from './repository';
import { verifyAccessToken } from './tokens';
import type { AuthEnv } from './types';

const getAuthRepository = (): AuthRepository => createAuthRepository();

export const authMiddleware: MiddlewareHandler<AuthEnv> = async (c, next) => {
  const authorization = c.req.header('Authorization');

  if (!authorization?.startsWith('Bearer ')) {
    throw new UnauthenticatedError('Missing or invalid bearer token');
  }

  const token = authorization.slice(7).trim();

  try {
    const claims = await verifyAccessToken(token);

    if (claims.role === 'super_admin') {
      const repository = getAuthRepository();
      const activeSession = await repository.findSessionByUser(claims.sub, claims.sid);

      if (!activeSession || !activeSession.active || activeSession.sessionId !== claims.sid) {
        throw new UnauthenticatedError('Session superseded');
      }
    }

    c.set('accountId', claims.account_id);
    c.set('userId', claims.sub);
    c.set('role', claims.role);
    c.set('email', claims.email);
    c.set('sessionId', claims.sid);
    await next();
  } catch (error) {
    if (error instanceof UnauthenticatedError) {
      throw error;
    }

    throw new UnauthenticatedError('Invalid or expired token');
  }
};
