import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';

import { AppError, ForbiddenError, UnauthenticatedError } from '../../shared/errors';
import type { AuthEnv } from '../auth/types';
import { documentTypes, linkedEntityTypes } from './types';
import { documentService, type DocumentService } from './service';

const contentTypes = ['image/jpeg', 'image/png', 'image/webp'] as const;
const uploadSchema = z.object({
  documentType: z.enum(documentTypes),
  linkedEntityType: z.enum(linkedEntityTypes),
  linkedEntityId: z.string().trim().min(1).max(128),
  contentType: z.enum(contentTypes),
  sizeBytes: z.number().int().positive().max(10 * 1024 * 1024),
}).strict();
const confirmSchema = uploadSchema.extend({
  s3Key: z.string().min(1).max(1024),
}).strict();

export const createDocumentRoutes = ({ service = documentService }: { service?: DocumentService } = {}) => {
  const routes = new Hono<AuthEnv>();
  const ownerAccountId = (c: Context<AuthEnv>): string => {
    if (c.get('role') !== 'owner') throw new ForbiddenError('Owner role required.');
    const accountId = c.get('accountId');
    if (!accountId) throw new UnauthenticatedError('Missing account context');

    return accountId;
  };

  routes.get('/', async (c) => {
    const accountId = ownerAccountId(c);
    const linkedEntityType = c.req.query('linkedEntityType');
    const linkedEntityId = c.req.query('linkedEntityId');
    const documentType = c.req.query('documentType');
    if (linkedEntityType && !(linkedEntityTypes as readonly string[]).includes(linkedEntityType)) {
      throw new AppError('Invalid linked entity type.', 400, 'VALIDATION_ERROR');
    }
    if (documentType && !(documentTypes as readonly string[]).includes(documentType)) {
      throw new AppError('Invalid document type.', 400, 'VALIDATION_ERROR');
    }
    const cursorValue = c.req.query('cursor');
    let cursor: Record<string, unknown> | undefined;
    if (cursorValue) {
      try {
        const decoded = JSON.parse(Buffer.from(cursorValue, 'base64url').toString('utf8')) as unknown;
        if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) throw new Error();
        cursor = decoded as Record<string, unknown>;
      } catch {
        throw new AppError('Invalid document pagination cursor.', 400, 'VALIDATION_ERROR');
      }
    }
    const result = await service.list(accountId, {
      ...(linkedEntityType ? { linkedEntityType: linkedEntityType as (typeof linkedEntityTypes)[number] } : {}),
      ...(linkedEntityId ? { linkedEntityId } : {}),
      ...(documentType ? { documentType: documentType as (typeof documentTypes)[number] } : {}),
      ...(cursor ? { cursor } : {}),
    });

    return c.json({
      data: result.items,
      nextCursor: result.nextCursor ? Buffer.from(JSON.stringify(result.nextCursor)).toString('base64url') : null,
    }, 200);
  });

  routes.get('/:id/download-url', async (c) => {
    const result = await service.downloadUrl(ownerAccountId(c), c.req.param('id'));

    return c.json(result, 200);
  });
  routes.get('/:id', async (c) => {
    const document = await service.get(ownerAccountId(c), c.req.param('id'));

    return c.json({ data: document }, 200);
  });
  routes.post('/presign', zValidator('json', uploadSchema), async (c) => {
    const result = await service.presign(ownerAccountId(c), c.req.valid('json'));

    return c.json({ data: result }, 200);
  });
  routes.post('/', zValidator('json', confirmSchema), async (c) => {
    const document = await service.confirm(ownerAccountId(c), c.req.valid('json'));

    return c.json({ data: document }, 201);
  });
  routes.delete('/:id', async (c) => {
    await service.delete(ownerAccountId(c), c.req.param('id'));

    return c.body(null, 204);
  });

  return routes;
};

export const documentRoutes = createDocumentRoutes();
