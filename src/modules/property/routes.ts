import { Hono } from 'hono';

import type { AuthEnv } from '../auth/types';
import { UnauthenticatedError } from '../../shared/errors';
import { propertyService } from './service';

export const propertyRoutes = new Hono<AuthEnv>();

propertyRoutes.get('', async (c) => {
  const accountId = c.get('accountId');

  if (!accountId || typeof accountId !== 'string') {
    throw new UnauthenticatedError('Missing account context');
  }

  const properties = await propertyService.list(accountId);

  return c.json({ data: properties }, 200 as const);
});

propertyRoutes.get('/*', async (c) => {
  const accountId = c.get('accountId');

  if (!accountId || typeof accountId !== 'string') {
    throw new UnauthenticatedError('Missing account context');
  }

  const properties = await propertyService.list(accountId);

  return c.json({ data: properties }, 200 as const);
});
