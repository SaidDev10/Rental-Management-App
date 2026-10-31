import type { MiddlewareHandler } from 'hono';

import { ForbiddenError, UnauthenticatedError } from '../../shared/errors';
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

    // Every authenticated token is tied to its authoritative session so logout and
    // admin-driven account disabling invalidate outstanding access tokens immediately.
    const repository = getAuthRepository();
    const session = await repository.findSessionStateByUser(claims.sub);
    const requiresActiveSession = claims.role === 'super_admin' || claims.imp === true;
    const sessionExpired = session ? new Date(session.expiresAt).getTime() <= Date.now() : true;
    const sessionInvalid = !session || !session.active || session.sessionId !== claims.sid || sessionExpired;

    if (requiresActiveSession && sessionInvalid) {
      throw new UnauthenticatedError('Session superseded');
    }
    if (!requiresActiveSession && session && sessionInvalid && c.req.path !== '/auth/logout') {
      throw new UnauthenticatedError('Session superseded');
    }

    if (claims.imp === true && c.req.method !== 'GET') {
      throw new ForbiddenError('Impersonation sessions are read-only');
    }

    c.set('accountId', claims.account_id);
    c.set('userId', claims.sub);
    c.set('role', claims.role);
    c.set('email', claims.email);
    c.set('sessionId', claims.sid);
    c.set('impersonating', claims.imp === true);
    await next();
  } catch (error) {
    if (error instanceof UnauthenticatedError || error instanceof ForbiddenError) {
      throw error;
    }

    throw new UnauthenticatedError('Invalid or expired token');
  }
};