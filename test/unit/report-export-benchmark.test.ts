import { performance } from 'node:perf_hooks';
import { describe, expect, it, vi } from 'vitest';

const benchmark = vi.hoisted(() => ({
  queryPages: 0,
  rowsReturned: 0,
  uploadedBytes: 0,
}));

vi.mock('../../src/shared/db/worker-data', () => ({
  getWorkerData: () => ({
    query: async (input: { exclusiveStartKey?: Record<string, unknown> }) => {
      const page =
        typeof input.exclusiveStartKey?.benchmarkPage === 'number'
          ? input.exclusiveStartKey.benchmarkPage
          : 0;
      const items = Array.from({ length: 500 }, (_, offset) => {
        const row = page * 500 + offset;

        return {
          PK: 'ACCOUNT#benchmark',
          SK: `PAYMENT#${String(row).padStart(5, '0')}`,
          accountId: 'benchmark',
          entityType: 'Payment',
          periodStart: '2026-06-15',
          dueDate: '2026-06-15',
          leaseId: `lease-${row % 100}`,
          propertyId: `property-${row % 25}`,
          status: row % 3 === 0 ? 'paid' : 'due',
          amountDue: 125_000 + row,
          amountPaid: row % 3 === 0 ? 125_000 + row : 0,
        };
      });

      benchmark.queryPages += 1;
      benchmark.rowsReturned += items.length;

      return {
        items,
        lastEvaluatedKey: page < 19 ? { benchmarkPage: page + 1 } : undefined,
      };
    },
  }),
}));

vi.mock('../../src/shared/config', () => ({
  readReportWorkerConfig: () => ({
    DOCUMENTS_BUCKET: 'benchmark-only',
  }),
}));

vi.mock('../../src/shared/sqs/enqueue-notification', () => ({
  enqueueNotification: async () => undefined,
}));

vi.mock('@aws-sdk/lib-storage', () => ({
  Upload: class {
    private readonly stream: NodeJS.ReadableStream;

    constructor(options: { params: { Body: NodeJS.ReadableStream } }) {
      this.stream = options.params.Body;
    }

    done(): Promise<void> {
      return new Promise((resolve, reject) => {
        this.stream.on('data', (chunk: Buffer) => {
          benchmark.uploadedBytes += chunk.byteLength;
        });
        this.stream.once('error', reject);
        this.stream.once('end', resolve);
      });
    }
  },
}));

import { createReportProcessor } from '../../src/workers/processors/report';

describe('report export benchmark', () => {
  it(
    'benchmarks a 10,000-row XLSX export through the report processor',
    async () => {
      benchmark.queryPages = 0;
      benchmark.rowsReturned = 0;
      benchmark.uploadedBytes = 0;
      const startingRss = process.memoryUsage().rss;
      const payload = {
        jobId: 'benchmark-report',
        accountId: 'benchmark',
        format: 'xlsx' as const,
        reportType: 'PAYMENT_REGISTER' as const,
        from: '2026-01-01',
        to: '2026-12-31',
      };
      const processReport = createReportProcessor(() => new Date('2026-10-31T00:00:00.000Z'));

      const startedAt = performance.now();
      const result = await processReport(payload);
      const elapsedMs = performance.now() - startedAt;
      const rssDeltaBytes = process.memoryUsage().rss - startingRss;

      expect(benchmark.rowsReturned).toBe(10_000);
      expect(benchmark.queryPages).toBe(20);
      expect(benchmark.uploadedBytes).toBeGreaterThan(0);
      if (result.document === undefined) {
        throw new Error('Report processor did not return document metadata.');
      }
      expect(result.document.sizeBytes).toBe(benchmark.uploadedBytes);
      expect(elapsedMs).toBeLessThan(120_000);

      process.stdout.write(
        `REPORT_EXPORT_BENCHMARK ${JSON.stringify({
          rows: benchmark.rowsReturned,
          format: 'xlsx',
          elapsedMs: Math.round(elapsedMs),
          outputBytes: benchmark.uploadedBytes,
          queryPages: benchmark.queryPages,
          runtime: process.version,
          platform: `${process.platform}/${process.arch}`,
          workerTarget: { memoryMb: 1024, timeoutSeconds: 120 },
          rssDeltaBytes,
          environment: 'local report processor; DynamoDB data and S3/SQS integrations mocked',
        })}\n`,
      );
    },
    125_000,
  );
});
