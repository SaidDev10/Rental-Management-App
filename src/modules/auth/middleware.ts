import { UnauthenticatedError } from '../../shared/errors';
import { verifyAccessToken } from './tokens';

export const authMiddleware = async (c: any, next: () => Promise<void>): Promise<void> => {
  const authorization = c.req.header('Authorization');

  if (!authorization?.startsWith('Bearer ')) {
    throw new UnauthenticatedError('Missing or invalid bearer token');
  }

  const token = authorization.slice(7).trim();

  try {
    const claims = await verifyAccessToken(token);
    c.set('accountId', claims.account_id);
    c.set('userId', claims.sub);
    c.set('role', claims.role);
    c.set('email', claims.email);
    c.set('sessionId', claims.sid);
    await next();
  } catch {
    throw new UnauthenticatedError('Invalid or expired token');
  }
};
