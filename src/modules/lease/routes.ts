import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';

import { AppError, ForbiddenError, UnauthenticatedError } from '../../shared/errors';
import { decodeCursor, encodeCursor } from '../../shared/db/pagination';
import type { AuthEnv } from '../auth/types';
import { leaseService } from './service';

const leaseIndexationSchema = z.object({
  enabled: z.boolean(),
  ratePct: z.number().min(0).max(100).optional(),
  effectiveFrom: z.iso.date().optional(),
}).strict();

const createLeaseSchema = z.object({
  propertyId: z.string().trim().min(1).max(128),
  tenantIds: z.array(z.string().trim().min(1).max(128)).min(1).max(99),
  startDate: z.iso.date(),
  endDate: z.iso.date(),
  rentAmount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  chargesAmount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  depositAmount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  paymentDayOfMonth: z.number().int().min(1).max(28),
  billingFrequency: z.enum(['monthly', 'quarterly']),
  indexation: leaseIndexationSchema.default({ enabled: false }),
  status: z.enum(['draft', 'active']).default('active'),
}).strict();

const updateLeaseSchema = z.object({
  endDate: z.iso.date().optional(),
  rentAmount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  chargesAmount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  depositAmount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  paymentDayOfMonth: z.number().int().min(1).max(28).optional(),
  billingFrequency: z.enum(['monthly', 'quarterly']).optional(),
  indexation: leaseIndexationSchema.optional(),
  status: z.enum(['draft', 'active']).optional(),
}).refine((value) => Object.keys(value).length > 0, 'At least one lease field must be provided.').strict();

const terminationSchema = z.object({
  terminatedAt: z.iso.date(),
  reason: z.string().trim().min(1).max(1000),
}).strict();

const renewalSchema = z.object({
  startDate: z.iso.date().optional(),
  endDate: z.iso.date().optional(),
}).strict();

type LeaseRouteService = Pick<
  typeof leaseService,
  'list' | 'get' | 'create' | 'update' | 'terminate' | 'schedule' | 'renew'
>;

export const createLeaseRoutes = (
  { service = leaseService }: { service?: LeaseRouteService } = {},
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

  const listLeases = async (c: Context<AuthEnv>) => {
    const limitValue = c.req.query('limit');
    const requestedLimit = limitValue === undefined ? 25 : Number(limitValue);
    if (!Number.isInteger(requestedLimit) || requestedLimit < 1) {
      throw new AppError('Invalid lease page size.', 400, 'VALIDATION_ERROR');
    }
    const statusValue = c.req.query('status');
    const statusResult = statusValue
      ? z.enum(['draft', 'active', 'terminated', 'expired']).safeParse(statusValue)
      : undefined;
    if (statusResult && !statusResult.success) {
      throw new AppError('Invalid lease status filter.', 400, 'VALIDATION_ERROR');
    }
    const status = statusResult?.success ? statusResult.data : undefined;
    const propertyId = c.req.query('propertyId');
    const tenantId = c.req.query('tenantId');
    let cursor: Record<string, unknown> | undefined;
    try {
      cursor = decodeCursor(c.req.query('cursor'));
    } catch (error) {
      if (!(error instanceof SyntaxError) && !(error instanceof TypeError)) {
        throw error;
      }
      throw new AppError('Invalid lease pagination cursor.', 400, 'VALIDATION_ERROR');
    }
    const page = await service.list(getAccountId(c), {
      limit: Math.min(requestedLimit, 100),
      ...(cursor ? { cursor } : {}),
      ...(status ? { status } : {}),
      ...(propertyId ? { propertyId } : {}),
      ...(tenantId ? { tenantId } : {}),
    });

    return c.json({ data: page.items, nextCursor: encodeCursor(page.nextCursor) }, 200);
  };

  routes.get('', listLeases);
  routes.get('/', listLeases);
  routes.post('', zValidator('json', createLeaseSchema), async (c) => {
    const lease = await service.create(
      getAccountId(c),
      c.req.valid('json'),
      idempotencyKey(c.req.header('Idempotency-Key')),
    );
    c.header('ETag', String(lease.version));

    return c.json({ data: lease }, 201);
  });
  routes.post('/', zValidator('json', createLeaseSchema), async (c) => {
    const lease = await service.create(
      getAccountId(c),
      c.req.valid('json'),
      idempotencyKey(c.req.header('Idempotency-Key')),
    );
    c.header('ETag', String(lease.version));

    return c.json({ data: lease }, 201);
  });
  routes.get('/:id', async (c) => {
    const lease = await service.get(getAccountId(c), c.req.param('id'));
    c.header('ETag', String(lease.version));

    return c.json({ data: lease }, 200);
  });
  routes.patch('/:id', zValidator('json', updateLeaseSchema), async (c) => {
    const lease = await service.update(
      getAccountId(c),
      c.req.param('id'),
      expectedVersion(c.req.header('If-Match')),
      c.req.valid('json'),
    );
    c.header('ETag', String(lease.version));

    return c.json({ data: lease }, 200);
  });
  routes.post('/:id/terminate', zValidator('json', terminationSchema), async (c) => {
    const { terminatedAt, reason } = c.req.valid('json');
    const lease = await service.terminate(
      getAccountId(c),
      c.req.param('id'),
      expectedVersion(c.req.header('If-Match')),
      terminatedAt,
      reason,
    );
    c.header('ETag', String(lease.version));

    return c.json({ data: lease }, 200);
  });
  routes.post('/:id/renew', zValidator('json', renewalSchema), async (c) => {
    const lease = await service.renew(
      getAccountId(c),
      c.req.param('id'),
      expectedVersion(c.req.header('If-Match')),
      c.req.valid('json'),
      idempotencyKey(c.req.header('Idempotency-Key')),
    );
    c.header('ETag', String(lease.version));

    return c.json({ data: lease }, 201);
  });
  routes.get('/:id/schedule', async (c) => {
    const schedule = await service.schedule(getAccountId(c), c.req.param('id'));

    return c.json({ data: schedule }, 200);
  });

  return routes;
};

export const leaseRoutes = createLeaseRoutes();
