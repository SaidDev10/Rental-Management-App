import { createHash } from 'node:crypto';

import { AppError, NotFoundError } from '../../shared/errors';
import { leaseService } from '../lease/service';
import { createPaymentRepository, type PaymentRepository } from './repository';
import type {
  CreatePaymentInput,
  Payment,
  PaymentListOptions,
  RecordPaymentInput,
  UpdatePaymentInput,
} from './types';

const requestHash = (input: CreatePaymentInput): string =>
  createHash('sha256')
    .update(JSON.stringify(Object.fromEntries(Object.entries(input).sort(([a], [b]) => a.localeCompare(b)))))
    .digest('hex');

const isCalendarDate = (value: string): boolean => {
  const date = new Date(`${value}T00:00:00.000Z`);

  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
};

const toPayment = (record: Awaited<ReturnType<PaymentRepository['getById']>> & object): Payment => ({
  id: record.id,
  leaseId: record.leaseId,
  propertyId: record.propertyId,
  tenantId: record.tenantId,
  periodStart: record.periodStart,
  periodEnd: record.periodEnd,
  dueDate: record.dueDate,
  amountDue: record.amountDue,
  amountPaid: record.amountPaid,
  paymentMethod: record.paymentMethod,
  paidAt: record.paidAt,
  status: record.status,
  quittanceNumber: record.quittanceNumber,
  quittanceDocId: record.quittanceDocId,
  version: record.version,
  ...(record.notes !== undefined ? { notes: record.notes } : {}),
  ...(record.createdAt !== undefined ? { createdAt: record.createdAt } : {}),
  ...(record.updatedAt !== undefined ? { updatedAt: record.updatedAt } : {}),
});

const repositoryFor = (accountId: string): PaymentRepository => createPaymentRepository({ accountId });

export const paymentService = {
  async list(
    accountId: string,
    options: PaymentListOptions,
    repository = repositoryFor(accountId),
  ): Promise<{ items: Payment[]; nextCursor?: Record<string, unknown> | undefined }> {
    const page = await repository.list(options);

    return {
      items: page.items.map((payment) => toPayment(payment)),
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    };
  },

  async overdue(
    accountId: string,
    today = new Date().toISOString().slice(0, 10),
    repository = repositoryFor(accountId),
  ): Promise<Payment[]> {
    if (!isCalendarDate(today)) {
      throw new AppError('Overdue lookup requires a valid calendar date.', 400, 'VALIDATION_ERROR');
    }

    return (await repository.listOverdue(today)).map((payment) => toPayment(payment));
  },

  async markOverdue(
    accountId: string,
    today = new Date().toISOString().slice(0, 10),
    repository = repositoryFor(accountId),
  ): Promise<number> {
    if (!isCalendarDate(today)) {
      throw new AppError('Overdue processing requires a valid calendar date.', 400, 'VALIDATION_ERROR');
    }

    return repository.markOverdue(today);
  },

  async get(
    accountId: string,
    paymentId: string,
    repository = repositoryFor(accountId),
  ): Promise<Payment> {
    const payment = await repository.getById(paymentId);
    if (!payment) {
      throw new NotFoundError('Payment not found');
    }

    return toPayment(payment);
  },

  async create(
    accountId: string,
    input: CreatePaymentInput,
    idempotencyKey: string,
    repository = repositoryFor(accountId),
  ): Promise<Payment> {
    if (
      !isCalendarDate(input.periodStart) ||
      !isCalendarDate(input.periodEnd) ||
      !isCalendarDate(input.dueDate) ||
      input.periodEnd <= input.periodStart
    ) {
      throw new AppError('Payment period and due date must be valid calendar dates.', 400, 'VALIDATION_ERROR');
    }
    if (!Number.isSafeInteger(input.amountDue) || input.amountDue <= 0 || input.amountDue > 100_000_000) {
      throw new AppError('Payment amount must be a positive integer in centimes.', 400, 'VALIDATION_ERROR');
    }
    if (input.notes !== undefined && input.notes.length > 500) {
      throw new AppError('Payment notes cannot exceed 500 characters.', 400, 'VALIDATION_ERROR');
    }
    const lease = await leaseService.get(accountId, input.leaseId);
    if (input.periodStart < lease.startDate || input.periodEnd > lease.endDate) {
      throw new AppError('Payment period must fall within the lease term.', 400, 'PAYMENT_PERIOD_INVALID');
    }
    const payment = await repository.create(
      input,
      { propertyId: lease.propertyId, tenantId: lease.tenantIds[0]! },
      idempotencyKey,
      requestHash(input),
    );

    return toPayment(payment);
  },

  async update(
    accountId: string,
    paymentId: string,
    expectedVersion: number,
    input: UpdatePaymentInput,
    repository = repositoryFor(accountId),
  ): Promise<Payment> {
    const current = await repository.getById(paymentId);
    if (!current) {
      throw new NotFoundError('Payment not found');
    }
    if (current.status !== 'due' || current.amountPaid !== 0) {
      throw new AppError('Only an unpaid due payment can be updated.', 409, 'PAYMENT_STATE_CONFLICT');
    }
    const periodStart = input.periodStart ?? current.periodStart;
    const periodEnd = input.periodEnd ?? current.periodEnd;
    if (
      (input.periodStart !== undefined && !isCalendarDate(input.periodStart)) ||
      (input.periodEnd !== undefined && !isCalendarDate(input.periodEnd)) ||
      (input.dueDate !== undefined && !isCalendarDate(input.dueDate)) ||
      periodEnd <= periodStart
    ) {
      throw new AppError('Payment period and due date must be valid calendar dates.', 400, 'VALIDATION_ERROR');
    }
    if (
      input.amountDue !== undefined &&
      (!Number.isSafeInteger(input.amountDue) || input.amountDue <= 0 || input.amountDue > 100_000_000)
    ) {
      throw new AppError('Payment amount must be a positive integer in centimes.', 400, 'VALIDATION_ERROR');
    }
    if (input.notes !== undefined && input.notes !== null && input.notes.length > 500) {
      throw new AppError('Payment notes cannot exceed 500 characters.', 400, 'VALIDATION_ERROR');
    }

    return toPayment(await repository.update(paymentId, expectedVersion, input));
  },

  async recordPaid(
    accountId: string,
    paymentId: string,
    expectedVersion: number,
    input: RecordPaymentInput,
    repository = repositoryFor(accountId),
  ): Promise<Payment> {
    const current = await repository.getById(paymentId);
    if (!current) {
      throw new NotFoundError('Payment not found');
    }
    if (!['due', 'partial', 'late'].includes(current.status)) {
      throw new AppError('This payment can no longer receive a payment record.', 409, 'PAYMENT_STATE_CONFLICT');
    }
    if (!Number.isSafeInteger(input.amountPaid) || input.amountPaid <= current.amountPaid) {
      throw new AppError('Recorded amount must increase the total paid amount.', 400, 'VALIDATION_ERROR');
    }
    if (input.amountPaid > current.amountDue) {
      throw new AppError('Recorded amount cannot exceed the amount due.', 400, 'PAYMENT_AMOUNT_EXCEEDS_DUE');
    }
    if (!Number.isFinite(Date.parse(input.paidAt)) || new Date(input.paidAt).toISOString() !== input.paidAt) {
      throw new AppError('Payment date must be a valid ISO timestamp.', 400, 'VALIDATION_ERROR');
    }
    const status = input.amountPaid === current.amountDue ? 'paid' : 'partial';

    return toPayment(await repository.recordPaid(paymentId, expectedVersion, input, status));
  },

  async cancel(
    accountId: string,
    paymentId: string,
    expectedVersion: number,
    repository = repositoryFor(accountId),
  ): Promise<Payment> {
    const current = await repository.getById(paymentId);
    if (!current) {
      throw new NotFoundError('Payment not found');
    }
    if (current.status === 'paid') {
      throw new AppError('A paid payment cannot be cancelled.', 409, 'PAYMENT_ALREADY_PAID');
    }

    return toPayment(await repository.cancel(paymentId, expectedVersion));
  },
};
