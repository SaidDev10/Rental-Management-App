import { AppError } from '../../shared/errors';
import type { Payment } from '../payment/types';
import { createDashboardRepository, type MonthlySummary } from './repository';

const repositoryFor = (accountId: string) => createDashboardRepository({ accountId });

const monthOf = (value: string): string => value.slice(0, 7);

const monthList = (from: string, to: string): string[] => {
  const months: string[] = [];
  const cursor = new Date(`${from}-01T00:00:00.000Z`);
  const end = new Date(`${to}-01T00:00:00.000Z`);
  while (cursor <= end) {
    months.push(cursor.toISOString().slice(0, 7));
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }

  return months;
};

const withTimeoutFallback = async <T>(promise: Promise<T>, fallback: T, timeoutMs: number): Promise<T> => {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timeout = setTimeout(() => resolve(fallback), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
};

const isValidRange = (value: string): boolean => {
  if (!/^\d{4}-\d{2}(?:-\d{2})?$/.test(value)) {
    return false;
  }
  const date = value.length === 7 ? `${value}-01` : value;
  const parsed = new Date(`${date}T00:00:00.000Z`);

  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
};

export const dashboardService = {
  async dashboard(
    accountId: string,
    now = new Date(),
    repository = repositoryFor(accountId),
  ): Promise<{
    currentMonth: MonthlySummary;
    previousMonth: MonthlySummary;
    upcomingPayments: Payment[];
    openMaintenanceTicketCount: number;
  }> {
    const currentMonth = now.toISOString().slice(0, 7);
    const previous = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    const previousMonth = previous.toISOString().slice(0, 7);
    const [current, prior, upcomingPayments, openMaintenanceTicketCount] = await Promise.all([
      repository.getSummary(currentMonth),
      repository.getSummary(previousMonth),
      withTimeoutFallback(repository.listDueNext30Days(10), [], 2_200),
      withTimeoutFallback(repository.countOpenTickets(), 0, 2_200),
    ]);

    return {
      currentMonth: current,
      previousMonth: prior,
      upcomingPayments,
      openMaintenanceTicketCount,
    };
  },

  async summaryReport(
    accountId: string,
    from: string,
    to: string,
    repository?: ReturnType<typeof repositoryFor>,
  ): Promise<MonthlySummary[]> {
    if (!isValidRange(from) || !isValidRange(to)) {
      throw new AppError('from and to must be valid YYYY-MM or YYYY-MM-DD values.', 400, 'VALIDATION_ERROR');
    }

    const fromMonth = monthOf(from);
    const toMonth = monthOf(to);
    if (fromMonth > toMonth) {
      throw new AppError('from must not be after to.', 400, 'VALIDATION_ERROR');
    }
    const months = monthList(fromMonth, toMonth);
    if (months.length > 24) {
      throw new AppError('Summary reports are limited to 24 months.', 400, 'VALIDATION_ERROR');
    }

    return (repository ?? repositoryFor(accountId)).getSummaries(months);
  },
};
