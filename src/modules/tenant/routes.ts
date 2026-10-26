import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';

import { AppError, ForbiddenError, UnauthenticatedError } from '../../shared/errors';
import { decodeCursor, encodeCursor } from '../../shared/db/pagination';
import type { AuthEnv } from '../auth/types';
import { tenantService } from './service';

const addressSchema = z.object({
  line1: z.string().trim().min(1).max(200),
  line2: z.string().trim().max(200).optional(),
  city: z.string().trim().min(1).max(100),
  postalCode: z.string().trim().max(20).optional(),
  country: z.literal('MA'),
});

const createTenantSchema = z.object({
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().min(1).max(100),
  email: z.email(),
  phone: z.string().trim().min(1).max(30),
  dateOfBirth: z.iso.date().nullable().default(null),
  address: addressSchema.nullable().default(null),
}).strict();

const updateTenantSchema = createTenantSchema.partial().refine(
  (value) => Object.keys(value).length > 0,
  'At least one tenant field must be provided.',
).strict();

const idDocumentSchema = z.object({
  type: z.enum(['CIN', 'passport']),
  number: z.string().trim().min(1).max(100),
  issuedAt: z.iso.date().optional(),
  expiresAt: z.iso.date().optional(),
  fileKey: z.string().trim().min(1).max(1024).optional(),
}).strict();

type TenantRouteService = Pick<
  typeof tenantService,
  'list' | 'get' | 'create' | 'update' | 'setIdDocument' | 'getDecryptedIdDocument' | 'delete'
>;

export const createTenantRoutes = (
  { service = tenantService }: { service?: TenantRouteService } = {},
) => {
  const routes = new Hono<AuthEnv>();

  const getAccountId = (c: Context<AuthEnv>): string => {
    const accountId = c.get('accountId');
    if (!accountId) {
      throw new UnauthenticatedError('Missing account context');
    }
    if (c.get('role') !== 'owner') {
      throw new ForbiddenError('Owner access required');
    }

    return accountId;
  };

  const expectedVersion = (value: string | undefined): number => {
    const versionValue = value?.trim().replace(/^"|"$/g, '');
    if (!versionValue || !/^[1-9]\d*$/.test(versionValue)) {
      throw new AppError('A valid If-Match version is required.', 428, 'PRECONDITION_REQUIRED');
    }

    return Number(versionValue);
  };

  const idempotencyKey = (value: string | undefined): string => {
    const key = value?.trim();
    if (!key || key.length > 128) {
      throw new AppError('A valid Idempotency-Key header is required.', 400, 'VALIDATION_ERROR');
    }

    return key;
  };

  const listTenants = async (c: Context<AuthEnv>) => {
    const requestedLimit = c.req.query('limit') === undefined ? 25 : Number(c.req.query('limit'));
    if (!Number.isInteger(requestedLimit) || requestedLimit < 1) {
      throw new AppError('Invalid tenant page size.', 400, 'VALIDATION_ERROR');
    }
    let cursor: Record<string, unknown> | undefined;
    try {
      cursor = decodeCursor(c.req.query('cursor'));
    } catch (error) {
      if (!(error instanceof SyntaxError) && !(error instanceof TypeError)) {
        throw error;
      }
      throw new AppError('Invalid tenant pagination cursor.', 400, 'VALIDATION_ERROR');
    }

    const page = await service.list(
      getAccountId(c),
      { limit: Math.min(requestedLimit, 100), ...(cursor ? { cursor } : {}) },
    );

    return c.json({ data: page.items, nextCursor: encodeCursor(page.nextCursor) }, 200);
  };

  routes.get('', listTenants);
  routes.get('/', listTenants);
  routes.post('', zValidator('json', createTenantSchema), async (c) => {
    const tenant = await service.create(
      getAccountId(c),
      c.req.valid('json'),
      idempotencyKey(c.req.header('Idempotency-Key')),
    );
    c.header('ETag', String(tenant.version));

    return c.json({ data: tenant }, 201);
  });
  routes.post('/', zValidator('json', createTenantSchema), async (c) => {
    const tenant = await service.create(
      getAccountId(c),
      c.req.valid('json'),
      idempotencyKey(c.req.header('Idempotency-Key')),
    );
    c.header('ETag', String(tenant.version));

    return c.json({ data: tenant }, 201);
  });

  routes.get('/:id', async (c) => {
    const tenant = await service.get(getAccountId(c), c.req.param('id'));
    c.header('ETag', String(tenant.version));

    return c.json({ data: tenant }, 200);
  });

  routes.patch('/:id', zValidator('json', updateTenantSchema), async (c) => {
    const tenant = await service.update(
      getAccountId(c),
      c.req.param('id'),
      expectedVersion(c.req.header('If-Match')),
      c.req.valid('json'),
    );
    c.header('ETag', String(tenant.version));

    return c.json({ data: tenant }, 200);
  });

  routes.delete('/:id', async (c) => {
    await service.delete(
      getAccountId(c),
      c.req.param('id'),
      expectedVersion(c.req.header('If-Match')),
    );

    return c.body(null, 204);
  });

  routes.put('/:id/id-document', zValidator('json', idDocumentSchema), async (c) => {
    const tenant = await service.setIdDocument(
      getAccountId(c),
      c.req.param('id'),
      expectedVersion(c.req.header('If-Match')),
      c.req.valid('json'),
    );
    c.header('ETag', String(tenant.version));

    return c.json({ data: tenant }, 200);
  });

  routes.get('/:id/id-document', async (c) => {
    const document = await service.getDecryptedIdDocument(getAccountId(c), c.req.param('id'));

    return c.json({ data: document }, 200);
  });

  return routes;
};

export const tenantRoutes = createTenantRoutes();