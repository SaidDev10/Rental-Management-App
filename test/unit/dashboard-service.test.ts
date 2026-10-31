import { describe, expect, it, vi } from 'vitest';

import { dashboardService } from '../../src/modules/dashboard/service';
import type { Payment } from '../../src/modules/payment/types';

const summary = (month: string) => ({
  month,
  totalIncome: 10,
  totalExpenses: 2,
  netYield: 8,
  occupiedProperties: 1,
  totalProperties: 1,
  latePayments: 0,
  paidPayments: 1,
  openTickets: 0,
});

describe('dashboard service', () => {
  it('starts both summary and both optional reads before waiting for any result', async () => {
    let resolveCurrent!: (value: ReturnType<typeof summary>) => void;
    let resolvePrevious!: (value: ReturnType<typeof summary>) => void;
    let resolveUpcoming!: (value: Payment[]) => void;
    let resolveTickets!: (value: number) => void;
    const repository = {
      getSummary: vi.fn((month: string) => new Promise<ReturnType<typeof summary>>((resolve) => {
        if (month === '2026-10') {
          resolveCurrent = resolve;
        } else {
          resolvePrevious = resolve;
        }
      })),
      listDueNext30Days: vi.fn(() => new Promise<Payment[]>((resolve) => {
        resolveUpcoming = resolve;
      })),
      countOpenTickets: vi.fn(() => new Promise<number>((resolve) => {
        resolveTickets = resolve;
      })),
      getSummaries: vi.fn(async () => []),
    };

    const pending = dashboardService.dashboard(
      'verified-account',
      new Date('2026-10-31T12:00:00.000Z'),
      repository,
    );
    expect(repository.getSummary).toHaveBeenCalledTimes(2);
    expect(repository.listDueNext30Days).toHaveBeenCalledOnce();
    expect(repository.countOpenTickets).toHaveBeenCalledOnce();
    resolveCurrent(summary('2026-10'));
    resolvePrevious(summary('2026-09'));
    resolveUpcoming([]);
    resolveTickets(1);
    await expect(pending).resolves.toMatchObject({ openMaintenanceTicketCount: 1 });
  });

  it('degrades optional data when optional reads time out while keeping summaries mandatory', async () => {
    vi.useFakeTimers();
    const repository = {
      getSummary: vi.fn(async (month: string) => summary(month)),
      listDueNext30Days: vi.fn(() => new Promise<Payment[]>(() => undefined)),
      countOpenTickets: vi.fn(() => new Promise<number>(() => undefined)),
      getSummaries: vi.fn(async () => []),
    };

    try {
      const pending = dashboardService.dashboard(
        'verified-account',
        new Date('2026-10-31T12:00:00.000Z'),
        repository,
      );
      await vi.advanceTimersByTimeAsync(2_200);
      await expect(pending).resolves.toMatchObject({
        currentMonth: { month: '2026-10' },
        previousMonth: { month: '2026-09' },
        upcomingPayments: [],
        openMaintenanceTicketCount: 0,
      });
      expect(repository.getSummary).toHaveBeenNthCalledWith(1, '2026-10');
      expect(repository.getSummary).toHaveBeenNthCalledWith(2, '2026-09');
      expect(repository.listDueNext30Days).toHaveBeenCalledWith(10);
      expect(repository.countOpenTickets).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('propagates errors from optional reads instead of silently degrading', async () => {
    const repository = {
      getSummary: vi.fn(async (month: string) => summary(month)),
      listDueNext30Days: vi.fn(async () => {
        throw new Error('payment index unavailable');
      }),
      countOpenTickets: vi.fn(async () => 0),
      getSummaries: vi.fn(async () => []),
    };

    await expect(
      dashboardService.dashboard('verified-account', new Date('2026-10-31T12:00:00.000Z'), repository),
    ).rejects.toThrow('payment index unavailable');
  });

  it('does not degrade mandatory current or previous summary reads', async () => {
    const repository = {
      getSummary: vi.fn(async () => {
        throw new Error('summary store unavailable');
      }),
      listDueNext30Days: vi.fn(async () => []),
      countOpenTickets: vi.fn(async () => 0),
      getSummaries: vi.fn(async () => []),
    };

    await expect(
      dashboardService.dashboard('verified-account', new Date('2026-10-31T12:00:00.000Z'), repository),
    ).rejects.toThrow('summary store unavailable');
  });

  it('loads reports from requested monthly SUMMARY items and enforces the 24-month limit', async () => {
    const months = ['2025-01', '2025-02'];
    const repository = {
      getSummary: vi.fn(async (month: string) => summary(month)),
      listDueNext30Days: vi.fn(async () => []),
      countOpenTickets: vi.fn(async () => 0),
      getSummaries: vi.fn(async (requested: string[]) => requested.map(summary)),
    };

    await expect(
      dashboardService.summaryReport('verified-account', '2025-01-15', '2025-02', repository),
    ).resolves.toMatchObject([{ month: months[0] }, { month: months[1] }]);
    expect(repository.getSummaries).toHaveBeenCalledWith(months);
    await expect(
      dashboardService.summaryReport('verified-account', '2023-12', '2025-12', repository),
    ).rejects.toMatchObject({ status: 400, code: 'VALIDATION_ERROR' });
    await expect(
      dashboardService.summaryReport('verified-account', '2026-02-31', '2026-03', repository),
    ).rejects.toMatchObject({ status: 400, code: 'VALIDATION_ERROR' });
  });
});
