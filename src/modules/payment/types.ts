import type { LeasePayment } from '../lease/types';

export type Payment = LeasePayment & {
  notes?: string | null | undefined;
  createdAt?: string | undefined;
  updatedAt?: string | undefined;
};

export type CreatePaymentInput = {
  leaseId: string;
  periodStart: string;
  periodEnd: string;
  dueDate: string;
  amountDue: number;
  notes?: string | undefined;
};

export type UpdatePaymentInput = {
  periodStart?: string | undefined;
  periodEnd?: string | undefined;
  dueDate?: string | undefined;
  amountDue?: number | undefined;
  notes?: string | null | undefined;
};

export type RecordPaymentInput = {
  paidAt: string;
  paymentMethod: NonNullable<LeasePayment['paymentMethod']>;
  amountPaid: number;
};

export type PaymentListOptions = {
  limit: number;
  cursor?: Record<string, unknown> | undefined;
  status?: LeasePayment['status'] | undefined;
  leaseId?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
};
