import { describe, expect, it } from 'vitest';

import { formatMoney } from '../../src/workers/processors/pdf';
import { listReportMonths } from '../../src/workers/processors/report';
import { NonRetryableWorkerError } from '../../src/workers/job-processor';

describe('document processor formatting and range guards', () => {
  it('formats centimes without floating-point money conversion', () => {
    expect(formatMoney(12345)).toBe('123.45 MAD');
    expect(formatMoney(-1)).toBe('-0.01 MAD');
    expect(formatMoney(Number.MAX_SAFE_INTEGER + 1)).toBe('—');
  });

  it('enumerates inclusive report months and rejects ranges over 24 months', () => {
    expect(listReportMonths('2024-01-01', '2025-12-31')).toHaveLength(24);
    expect(listReportMonths('2024-12-01', '2025-02-28')).toEqual([
      '2024-12',
      '2025-01',
      '2025-02',
    ]);
    expect(() => listReportMonths('2023-01-01', '2025-01-31')).toThrow(NonRetryableWorkerError);
  });
});
