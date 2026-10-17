import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';

import { UnauthenticatedError } from '../../shared/errors';
import { authService } from './service';

const loginSchema = z.object({
  email: z.email(),
  password: z.string().min(8),
});

const registerSchema = z.object({
  accountName: z.string().min(2),
  ownerName: z.string().min(2),
  email: z.email(),
  password: z.string().min(8),
  phone: z.string().min(5),
  locale: z.enum(['fr', 'en']).optional(),
});

export const authRoutes = new Hono();

authRoutes.post('/register', zValidator('json', registerSchema), async (c) => {
  const payload = c.req.valid('json');
  const result = await authService.register(payload);

  return c.json(result, 201);
});

authRoutes.post('/login', zValidator('json', loginSchema), async (c) => {
  const payload = c.req.valid('json');
  const result = await authService.login(payload);

  return c.json(result, 200);
});

authRoutes.get('/me', (c) => {
  const accountId = c.req.header('x-account-id');

  if (!accountId) {
    throw new UnauthenticatedError('Missing account context');
  }

  return c.json({ accountId, authenticated: true }, 200);
});
