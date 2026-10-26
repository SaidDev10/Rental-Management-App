import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';

import { AppError, UnauthenticatedError } from '../../shared/errors';
import { decodeCursor, encodeCursor } from '../../shared/db/pagination';
import type { AuthEnv } from '../auth/types';
import { propertyPhotoStorage, type PropertyPhotoStorage } from './photo-storage';
import { propertyService } from './service';

const addressSchema = z.object({
  line1: z.string().trim().min(1).max(200),
  line2: z.string().trim().max(200).optional(),
  city: z.string().trim().min(1).max(100),
  postalCode: z.string().trim().max(20).optional(),
  country: z.literal('MA'),
});

const createPropertySchema = z.object({
  label: z.string().trim().min(2).max(120),
  address: addressSchema,
  propertyType: z.enum(['apartment', 'house', 'studio', 'commercial', 'other']),
  areaSqm: z.number().positive().nullable().default(null),
  rooms: z.number().int().nonnegative().nullable().default(null),
  purchaseDate: z.iso.date().nullable().default(null),
  purchasePrice: z.number().int().nonnegative().nullable().default(null),
  notes: z.string().max(2000).nullable().default(null),
  status: z.enum(['active', 'inactive']).default('active'),
}).strict();

const updatePropertySchema = createPropertySchema.partial().refine(
  (value) => Object.keys(value).length > 0,
  'At least one property field must be provided.',
).strict();

const photoPresignSchema = z.object({
  contentType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
  sizeBytes: z.number().int().positive().max(10 * 1024 * 1024),
}).strict();

const photoRecordSchema = z.object({
  s3Key: z.string().min(1).max(1024),
}).strict();

export const createPropertyRoutes = (
  { photoStorage = propertyPhotoStorage }: { photoStorage?: PropertyPhotoStorage } = {},
) => {
  const routes = new Hono<AuthEnv>();

  const getAccountId = (accountId: string | undefined): string => {
    if (!accountId) {
      throw new UnauthenticatedError('Missing account context');
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

  const listProperties = async (c: Context<AuthEnv>) => {
    const accountId = getAccountId(c.get('accountId'));
    const limitValue = c.req.query('limit');
    const requestedLimit = limitValue === undefined ? 25 : Number(limitValue);
    if (!Number.isInteger(requestedLimit) || requestedLimit < 1) {
      throw new AppError('Invalid property page size.', 400, 'VALIDATION_ERROR');
    }
    let cursor: Record<string, unknown> | undefined;
    try {
      cursor = decodeCursor(c.req.query('cursor'));
    } catch (error) {
      if (!(error instanceof SyntaxError) && !(error instanceof TypeError)) {
        throw error;
      }

      throw new AppError('Invalid property pagination cursor.', 400, 'VALIDATION_ERROR');
    }

    const page = await propertyService.list(
      accountId,
      { limit: Math.min(requestedLimit, 100), ...(cursor ? { cursor } : {}) },
    );
    const status = c.req.query('status');
    const query = c.req.query('q')?.trim().toLocaleLowerCase();

    if (status && status !== 'active' && status !== 'inactive') {
      throw new AppError('Invalid property status filter.', 400, 'VALIDATION_ERROR');
    }

    const filtered = page.items.filter(
      (property) =>
        (!status || property.status === status) &&
        (!query || property.label.toLocaleLowerCase().includes(query)),
    );

    return c.json({ data: filtered, nextCursor: encodeCursor(page.nextCursor) }, 200);
  };

  const createProperty = async (
    accountId: string,
    input: z.output<typeof createPropertySchema>,
    key: string,
  ) => propertyService.create(accountId, input, key);

  routes.get('', listProperties);
  routes.get('/', listProperties);
  routes.post('', zValidator('json', createPropertySchema), async (c) => {
    const property = await createProperty(
      getAccountId(c.get('accountId')),
      c.req.valid('json'),
      idempotencyKey(c.req.header('Idempotency-Key')),
    );
    c.header('ETag', String(property.version));

    return c.json({ data: property }, 201);
  });
  routes.post('/', zValidator('json', createPropertySchema), async (c) => {
    const property = await createProperty(
      getAccountId(c.get('accountId')),
      c.req.valid('json'),
      idempotencyKey(c.req.header('Idempotency-Key')),
    );
    c.header('ETag', String(property.version));

    return c.json({ data: property }, 201);
  });

  routes.get('/:id', async (c) => {
    const accountId = getAccountId(c.get('accountId'));
    const property = await propertyService.get(accountId, c.req.param('id'));

    c.header('ETag', String(property.version));

    return c.json({ data: property }, 200);
  });

  routes.patch('/:id', zValidator('json', updatePropertySchema), async (c) => {
    const accountId = getAccountId(c.get('accountId'));
    const property = await propertyService.update(
      accountId,
      c.req.param('id'),
      expectedVersion(c.req.header('If-Match')),
      c.req.valid('json'),
    );

    c.header('ETag', String(property.version));

    return c.json({ data: property }, 200);
  });

  routes.delete('/:id', async (c) => {
    const accountId = getAccountId(c.get('accountId'));
    await propertyService.delete(
      accountId,
      c.req.param('id'),
      expectedVersion(c.req.header('If-Match')),
    );

    return c.body(null, 204);
  });

  routes.post('/:id/photos/presign', zValidator('json', photoPresignSchema), async (c) => {
    const accountId = getAccountId(c.get('accountId'));
    const propertyId = c.req.param('id');
    await propertyService.get(accountId, propertyId);
    const { contentType, sizeBytes } = c.req.valid('json');
    const upload = await photoStorage.presignUpload(accountId, propertyId, contentType, sizeBytes);

    return c.json({ data: upload }, 200);
  });

  routes.post('/:id/photos', zValidator('json', photoRecordSchema), async (c) => {
    const accountId = getAccountId(c.get('accountId'));
    const propertyId = c.req.param('id');
    await propertyService.get(accountId, propertyId);
    const { s3Key } = c.req.valid('json');
    await photoStorage.verifyUpload(accountId, propertyId, s3Key);
    const property = await propertyService.addPhoto(accountId, propertyId, s3Key);
    c.header('ETag', String(property.version));

    return c.json({ data: property }, 200);
  });

  return routes;
};

export const propertyRoutes = createPropertyRoutes();
