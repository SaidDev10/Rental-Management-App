import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';

import { UnauthenticatedError } from '../../shared/errors';
import { authMiddleware } from './middleware';
import { authService } from './service';
import type { AuthEnv } from './types';

const loginSchema = z.object({
  email: z.email(),
  password: z.string().min(8),
});

const mfaVerifySchema = z.object({
  challengeToken: z.string().min(1),
  code: z.string().min(4).max(6),
});

const mfaResendSchema = z.object({
  challengeToken: z.string().min(1),
});

const registerSchema = z.object({
  accountName: z.string().min(2),
  ownerName: z.string().min(2),
  email: z.email(),
  password: z.string().min(8),
  phone: z.string().min(5),
  locale: z.enum(['fr', 'en']).optional(),
});

export const authRoutes = new Hono<AuthEnv>();

authRoutes.post('/register', zValidator('json', registerSchema), async (c) => {
  const payload = c.req.valid('json');
  const result = await authService.register(payload);

  return c.json(result, 201);
});

authRoutes.post('/login', zValidator('json', loginSchema), async (c) => {
  const payload = c.req.valid('json');
  const result = await authService.login(payload);

  if ('mfaRequired' in result) {
    return c.json(result, 202);
  }

  return c.json(result, 200);
});

authRoutes.post('/refresh', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { refreshToken?: string };
  const refreshTokenFromBody = typeof body.refreshToken === 'string' ? body.refreshToken : undefined;
  const refreshTokenFromCookie = c.req.header('Cookie')
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith('__Host-rt='))
    ?.slice('__Host-rt='.length);

  const refreshToken = refreshTokenFromBody ?? refreshTokenFromCookie;
  const result = await authService.refresh(refreshToken ?? '');

  return c.json(result, 200);
});

authRoutes.post('/mfa/verify', zValidator('json', mfaVerifySchema), async (c) => {
  const payload = c.req.valid('json');
  const result = await authService.verifyMfa(payload);

  return c.json(result, 200);
});

authRoutes.post('/mfa/resend', zValidator('json', mfaResendSchema), async (c) => {
  const payload = c.req.valid('json');
  const result = await authService.resendMfaChallenge(payload.challengeToken);

  return c.json(result, 202);
});

authRoutes.post('/logout', authMiddleware, async (c) => {
  const userId = c.get('userId');
  const sessionId = c.get('sessionId');

  if (!userId || !sessionId) {
    throw new UnauthenticatedError('Missing account context');
  }

  await authService.logout(userId, sessionId);

  return c.body(null, 204);
});

authRoutes.get('/me', authMiddleware, (c) => {
  const accountId = c.get('accountId');
  const userId = c.get('userId');
  const role = c.get('role');
  const email = c.get('email');
  const sessionId = c.get('sessionId');

  if (!accountId || !userId || !role || !email || !sessionId) {
    throw new UnauthenticatedError('Missing account context');
  }

  return c.json({
    accountId,
    userId,
    role,
    email,
    sessionId,
    authenticated: true,
  }, 200);
});
