import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';

import { AppError, ForbiddenError, UnauthenticatedError } from '../../shared/errors';
import type { AuthEnv } from '../auth/types';
import { maintenanceAttachmentService, type MaintenanceAttachmentService } from './attachment-service';

const attachmentSchema = z.object({
  contentType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
  sizeBytes: z.number().int().positive().max(10 * 1024 * 1024),
}).strict();

export const createMaintenanceAttachmentRoutes = ({
  service = maintenanceAttachmentService,
}: { service?: MaintenanceAttachmentService } = {}) => {
  const routes = new Hono<AuthEnv>();
  const ownerAccountId = (c: Context<AuthEnv>): string => {
    if (c.get('role') !== 'owner') {
      throw new ForbiddenError('Owner role required.');
    }

    const accountId = c.get('accountId');
    if (!accountId) {
      throw new UnauthenticatedError('Missing account context');
    }

    return accountId;
  };

  routes.post('/:id/attachments', zValidator('json', attachmentSchema), async (c) => {
    const result = await service.presign(
      ownerAccountId(c),
      c.req.param('id'),
      c.req.valid('json'),
    );

    return c.json({ data: result }, 200);
  });

  routes.notFound((c) => c.json(
    { error: { code: 'NOT_FOUND', message: 'Route not found' } },
    404,
  ));
  routes.onError((error, c) => {
    const appError = error instanceof AppError
      ? error
      : new AppError('Unexpected server error', 500, 'INTERNAL_ERROR');

    return c.json({ error: { code: appError.code, message: appError.message } }, appError.status as 400 | 401 | 403 | 404 | 409 | 500);
  });

  return routes;
};

export const maintenanceAttachmentRoutes = createMaintenanceAttachmentRoutes();
