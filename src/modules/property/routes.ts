import { Hono } from 'hono';

import { propertyService } from './service';

export const propertyRoutes = new Hono();

propertyRoutes.get('', async (c) => {
  const accountId = c.req.header('x-account-id');

  if (!accountId) {
    return c.json({ error: 'Missing account context' }, 401 as const);
  }

  const properties = await propertyService.list(accountId);

  return c.json({ data: properties }, 200 as const);
});

propertyRoutes.get('/', async (c) => {
  const accountId = c.req.header('x-account-id');

  if (!accountId) {
    return c.json({ error: 'Missing account context' }, 401 as const);
  }

  const properties = await propertyService.list(accountId);

  return c.json({ data: properties }, 200 as const);
});
