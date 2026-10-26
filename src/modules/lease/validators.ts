import { AppError } from '../../shared/errors';
import type { CreateLeaseInput, LeasePayment } from './types';

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_LEASE_MONTHS = 12;

const parseDate = (value: string): Date => {
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new AppError('Lease dates must be valid calendar dates.', 400, 'VALIDATION_ERROR');
  }

  return date;
};

const addMonths = (date: Date, months: number): Date => {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + months;
  const targetFirst = new Date(Date.UTC(year, month, 1));
  const finalDay = new Date(Date.UTC(targetFirst.getUTCFullYear(), targetFirst.getUTCMonth() + 1, 0)).getUTCDate();

  return new Date(
    Date.UTC(targetFirst.getUTCFullYear(), targetFirst.getUTCMonth(), Math.min(date.getUTCDate(), finalDay)),
  );
};

const dateString = (date: Date): string => date.toISOString().slice(0, 10);

export const validateLeaseInput = (input: CreateLeaseInput): void => {
  const start = parseDate(input.startDate);
  const end = parseDate(input.endDate);
  if (end < start) {
    throw new AppError('Lease end date must not precede its start date.', 400, 'VALIDATION_ERROR');
  }
  if (end > addMonths(start, MAX_LEASE_MONTHS)) {
    throw new AppError('Lease duration cannot exceed one year.', 400, 'LEASE_DURATION_TOO_LONG');
  }
  if (input.tenantIds.length === 0 || input.tenantIds.length > 99) {
    throw new AppError('A lease requires between one and 99 tenants.', 400, 'VALIDATION_ERROR');
  }
  if (new Set(input.tenantIds).size !== input.tenantIds.length) {
    throw new AppError('A tenant may appear only once on a lease.', 400, 'VALIDATION_ERROR');
  }
  if (
    !input.propertyId.trim() ||
    input.tenantIds.some((tenantId) => !tenantId.trim()) ||
    !['draft', 'active'].includes(input.status)
  ) {
    throw new AppError('Lease property, tenants, or status are invalid.', 400, 'VALIDATION_ERROR');
  }
  if (
    !Number.isSafeInteger(input.rentAmount) ||
    !Number.isSafeInteger(input.chargesAmount) ||
    !Number.isSafeInteger(input.depositAmount) ||
    input.rentAmount < 0 ||
    input.chargesAmount < 0 ||
    input.depositAmount < 0 ||
    !Number.isSafeInteger(input.rentAmount + input.chargesAmount)
  ) {
    throw new AppError('Lease amounts must be non-negative safe integers.', 400, 'VALIDATION_ERROR');
  }
  if (
    !Number.isInteger(input.paymentDayOfMonth) ||
    input.paymentDayOfMonth < 1 ||
    input.paymentDayOfMonth > 28 ||
    !['monthly', 'quarterly'].includes(input.billingFrequency)
  ) {
    throw new AppError('Lease payment terms are invalid.', 400, 'VALIDATION_ERROR');
  }
  if (
    input.indexation.ratePct !== undefined &&
    (!Number.isFinite(input.indexation.ratePct) || input.indexation.ratePct < 0 || input.indexation.ratePct > 100)
  ) {
    throw new AppError('Lease indexation rate must be between 0 and 100 percent.', 400, 'VALIDATION_ERROR');
  }
  if (input.indexation.effectiveFrom !== undefined) {
    parseDate(input.indexation.effectiveFrom);
  }
};

export const generatePaymentSchedule = (
  lease: Pick<
    CreateLeaseInput,
    'startDate' | 'endDate' | 'billingFrequency' | 'paymentDayOfMonth' | 'rentAmount' | 'chargesAmount' | 'propertyId' | 'tenantIds'
  > & { id: string; version?: number },
): LeasePayment[] => {
  const start = parseDate(lease.startDate);
  const end = parseDate(lease.endDate);
  const step = lease.billingFrequency === 'monthly' ? 1 : 3;
  const payments: LeasePayment[] = [];

  for (let periodStart = start; periodStart <= end; periodStart = addMonths(periodStart, step)) {
    if (payments.length >= 120) {
      throw new AppError('Lease payment schedule cannot exceed 120 periods.', 400, 'LEASE_DURATION_TOO_LONG');
    }
    const nextPeriodStart = addMonths(periodStart, step);
    const periodEnd = new Date(Math.min(nextPeriodStart.getTime() - DAY_MS, end.getTime()));
    const dueDay = Math.min(lease.paymentDayOfMonth, 28);
    const dueDate = new Date(Date.UTC(periodStart.getUTCFullYear(), periodStart.getUTCMonth(), dueDay));
    const id = `${lease.id}-${dateString(periodStart).replaceAll('-', '')}`;

    payments.push({
      id,
      leaseId: lease.id,
      propertyId: lease.propertyId,
      tenantId: lease.tenantIds[0]!,
      periodStart: dateString(periodStart),
      periodEnd: dateString(periodEnd),
      dueDate: dateString(dueDate),
      amountDue: lease.rentAmount + lease.chargesAmount,
      amountPaid: 0,
      paymentMethod: null,
      paidAt: null,
      status: 'due',
      quittanceNumber: null,
      quittanceDocId: null,
      version: lease.version ?? 1,
    });
  }

  return payments;
};

export const addLeaseMonths = (date: string, months: number): string =>
  dateString(addMonths(parseDate(date), months));

export const addLeaseDays = (date: string, days: number): string =>
  dateString(new Date(parseDate(date).getTime() + days * DAY_MS));
