import { Hono } from 'hono';

import { UnauthenticatedError } from '../../shared/errors';
import { propertyService } from './service';

export const propertyRoutes = new Hono();

propertyRoutes.get('', async (c) => {
  const accountId = (c as any).get('accountId') as string | undefined;

  if (!accountId || typeof accountId !== 'string') {
    throw new UnauthenticatedError('Missing account context');
  }

  const properties = await propertyService.list(accountId);

  return c.json({ data: properties }, 200 as const);
});

propertyRoutes.get('/*', async (c) => {
  const accountId = (c as any).get('accountId') as string | undefined;

  if (!accountId || typeof accountId !== 'string') {
    throw new UnauthenticatedError('Missing account context');
  }

  const properties = await propertyService.list(accountId);

  return c.json({ data: properties }, 200 as const);
});
