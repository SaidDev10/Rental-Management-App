import type { Payment } from './types';

const localPayments = new Map<string, Map<string, Payment>>();

export const localPaymentStoreFor = (accountId: string): Map<string, Payment> => {
  let payments = localPayments.get(accountId);
  if (!payments) {
    payments = new Map();
    localPayments.set(accountId, payments);
  }

  return payments;
};
