import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';

import { AppError, ForbiddenError, UnauthenticatedError } from '../../shared/errors';
import { decodeCursor, encodeCursor } from '../../shared/db/pagination';
import type { AuthEnv } from '../auth/types';
import { paymentService } from './service';

const createPaymentSchema = z.object({
  leaseId: z.string().trim().min(1).max(128),
  periodStart: z.iso.date(),
  periodEnd: z.iso.date(),
  dueDate: z.iso.date(),
  amountDue: z.number().int().positive().max(100_000_000),
  notes: z.string().max(500).optional(),
}).refine((value) => value.periodEnd > value.periodStart, {
  message: 'periodEnd must be after periodStart',
  path: ['periodEnd'],
}).strict();

const updatePaymentSchema = z.object({
  periodStart: z.iso.date().optional(),
  periodEnd: z.iso.date().optional(),
  dueDate: z.iso.date().optional(),
  amountDue: z.number().int().positive().max(100_000_000).optional(),
  notes: z.string().max(500).nullable().optional(),
}).refine((value) => Object.keys(value).length > 0, 'At least one payment field must be provided.').strict();

const recordPaymentSchema = z.object({
  paidAt: z.iso.datetime(),
  paymentMethod: z.enum(['cash', 'bank_transfer', 'cheque', 'other']),
  amountPaid: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).strict();

type PaymentRouteService = Pick<
  typeof paymentService,
  'list' | 'overdue' | 'get' | 'create' | 'update' | 'recordPaid' | 'cancel' | 'enqueueQuittance'
>;

export const createPaymentRoutes = (
  { service = paymentService }: { service?: PaymentRouteService } = {},
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

  const getIdempotencyKey = (value: string | undefined): string => {
    const key = value?.trim();
    if (!key || key.length < 16 || key.length > 128) {
      throw new AppError('A valid Idempotency-Key header is required.', 400, 'VALIDATION_ERROR');
    }

    return key;
  };

  const listPayments = async (c: Context<AuthEnv>) => {
    const limitValue = c.req.query('limit');
    const limit = limitValue === undefined ? 25 : Number(limitValue);
    if (!Number.isInteger(limit) || limit < 1) {
      throw new AppError('Invalid payment page size.', 400, 'VALIDATION_ERROR');
    }
    const statusValue = c.req.query('status');
    const statusResult = statusValue
      ? z.enum(['due', 'partial', 'paid', 'late', 'cancelled']).safeParse(statusValue)
      : undefined;
    if (statusResult && !statusResult.success) {
      throw new AppError('Invalid payment status filter.', 400, 'VALIDATION_ERROR');
    }
    const from = c.req.query('from');
    const to = c.req.query('to');
    if (
      (from && !z.iso.date().safeParse(from).success) ||
      (to && !z.iso.date().safeParse(to).success) ||
      (from && to && from > to)
    ) {
      throw new AppError('Invalid payment date range.', 400, 'VALIDATION_ERROR');
    }
    let cursor: Record<string, unknown> | undefined;
    try {
      cursor = decodeCursor(c.req.query('cursor'));
    } catch (error) {
      if (!(error instanceof SyntaxError) && !(error instanceof TypeError)) {
        throw error;
      }
      throw new AppError('Invalid payment pagination cursor.', 400, 'VALIDATION_ERROR');
    }
    const page = await service.list(getAccountId(c), {
      limit: Math.min(limit, 100),
      ...(cursor ? { cursor } : {}),
      ...(statusResult?.success ? { status: statusResult.data } : {}),
      ...(c.req.query('leaseId') ? { leaseId: c.req.query('leaseId') } : {}),
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
    });

    return c.json({ data: page.items, nextCursor: encodeCursor(page.nextCursor) }, 200);
  };

  routes.get('', listPayments);
  routes.get('/', listPayments);
  routes.get('/overdue', async (c) => {
    const payments = await service.overdue(getAccountId(c));

    return c.json({ data: payments }, 200);
  });
  routes.post('', zValidator('json', createPaymentSchema), async (c) => {
    const payment = await service.create(
      getAccountId(c),
      c.req.valid('json'),
      getIdempotencyKey(c.req.header('Idempotency-Key')),
    );
    c.header('ETag', String(payment.version));

    return c.json({ data: payment }, 201);
  });
  routes.post('/', zValidator('json', createPaymentSchema), async (c) => {
    const payment = await service.create(
      getAccountId(c),
      c.req.valid('json'),
      getIdempotencyKey(c.req.header('Idempotency-Key')),
    );
    c.header('ETag', String(payment.version));

    return c.json({ data: payment }, 201);
  });
  routes.get('/:id', async (c) => {
    const payment = await service.get(getAccountId(c), c.req.param('id'));
    c.header('ETag', String(payment.version));

    return c.json({ data: payment }, 200);
  });
  routes.patch('/:id', zValidator('json', updatePaymentSchema), async (c) => {
    const payment = await service.update(
      getAccountId(c),
      c.req.param('id'),
      expectedVersion(c.req.header('If-Match')),
      c.req.valid('json'),
    );
    c.header('ETag', String(payment.version));

    return c.json({ data: payment }, 200);
  });
  routes.post('/:id/mark-paid', zValidator('json', recordPaymentSchema), async (c) => {
    const payment = await service.recordPaid(
      getAccountId(c),
      c.req.param('id'),
      expectedVersion(c.req.header('If-Match')),
      c.req.valid('json'),
    );
    c.header('ETag', String(payment.version));

    return c.json({ data: payment }, 200);
  });
  routes.post('/:id/quittance', async (c) => {
    const result = await service.enqueueQuittance(
      getAccountId(c),
      c.req.param('id'),
      getIdempotencyKey(c.req.header('Idempotency-Key')),
    );

    return c.json(result, 202);
  });
  routes.post('/:id/cancel', async (c) => {
    const payment = await service.cancel(
      getAccountId(c),
      c.req.param('id'),
      expectedVersion(c.req.header('If-Match')),
    );
    c.header('ETag', String(payment.version));

    return c.json({ data: payment }, 200);
  });

  return routes;
};

export const paymentRoutes = createPaymentRoutes();
