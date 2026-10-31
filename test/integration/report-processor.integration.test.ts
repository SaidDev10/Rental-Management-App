import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import ExcelJS from 'exceljs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const database = vi.hoisted(() => ({
  items: [] as Array<Record<string, unknown>>,
  commands: [] as Array<{ kind: string; input: Record<string, unknown> }>,
  repositoryAccounts: [] as string[],
  uploadedChunks: [] as Buffer[],
  notifications: [] as Array<{ jobId: string; payload: Record<string, unknown> }>,
}));

vi.mock('../../src/shared/db/worker-data', async () => {
  const { createScopedRepository } =
    await vi.importActual<typeof import('../../src/shared/db/scoped-repository')>(
      '../../src/shared/db/scoped-repository',
    );

  return {
    getWorkerData: (accountId: string) => {
      database.repositoryAccounts.push(accountId);
      const client = {
        send: async (command: {
          constructor: { name: string };
          input: Record<string, unknown>;
        }) => {
          database.commands.push({ kind: command.constructor.name, input: command.input });
          if (command.constructor.name === 'QueryCommand') {
            const values = command.input.ExpressionAttributeValues as Record<string, unknown>;
            const partition = values[':partition'];
            const sortPrefix = values[':sortPrefix'];

            return {
              Items: database.items.filter(
                (item) =>
                  item.PK === partition &&
                  (typeof sortPrefix !== 'string' || String(item.SK).startsWith(sortPrefix)),
              ),
            };
          }

          if (command.constructor.name === 'GetCommand') {
            return {};
          }

          throw new Error(`Unexpected DynamoDB command: ${command.constructor.name}`);
        },
      };

      return createScopedRepository({
        accountId,
        client: client as unknown as DynamoDBDocumentClient,
        tableName: 'report-integration-test',
      });
    },
  };
});

vi.mock('../../src/shared/aws/clients', () => ({
  getS3Client: () => ({}),
}));

vi.mock('../../src/shared/config', () => ({
  readReportWorkerConfig: () => ({ DOCUMENTS_BUCKET: 'report-test-bucket' }),
}));

vi.mock('../../src/shared/sqs/enqueue-notification', () => ({
  enqueueNotification: async (jobId: string, payload: Record<string, unknown>) => {
    database.notifications.push({ jobId, payload });
  },
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
          database.uploadedChunks.push(Buffer.from(chunk));
        });
        this.stream.once('error', reject);
        this.stream.once('end', resolve);
      });
    }
  },
}));

// eslint-disable-next-line import/extensions -- JSON fixtures must be imported with their extension for TypeScript resolution.
import paymentAndLeaseFixtures from '../fixtures/reports/payment-register.json';
import { createReportProcessor } from '../../src/workers/processors/report';

type ExportOptions = {
  reportType?: 'PAYMENT_REGISTER' | 'LEASE_REGISTER';
  from?: string;
  to?: string;
  filters?: { propertyId?: string; leaseId?: string; status?: string[] };
};

const expectAccountScopedQueriesOnly = () => {
  expect(database.repositoryAccounts.every((accountId) => accountId === 'account-a')).toBe(true);
  expect(database.commands.length).toBeGreaterThan(0);
  expect(database.commands.every(({ kind }) => kind === 'QueryCommand')).toBe(true);
  expect(
    database.commands.every(
      ({ input }) =>
        (input.ExpressionAttributeValues as Record<string, unknown>)[':partition'] ===
        'ACCOUNT#account-a',
    ),
  ).toBe(true);
};

const exportReport = async (options: ExportOptions = {}) => {
  const processReport = createReportProcessor(() => new Date('2026-10-31T00:00:00.000Z'));
  const result = await processReport({
    jobId: `report-${database.notifications.length}`,
    accountId: 'account-a',
    format: 'xlsx',
    reportType: options.reportType ?? 'PAYMENT_REGISTER',
    from: options.from ?? '2025-01-01',
    to: options.to ?? '2026-12-31',
    ...(options.filters === undefined ? {} : { filters: options.filters }),
  });
  const bytes = Buffer.concat(database.uploadedChunks);
  database.uploadedChunks = [];

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  const worksheet = workbook.getWorksheet('Report');
  if (worksheet === undefined) {
    throw new Error('Report export did not include the Report worksheet.');
  }
  const headerValues = worksheet.getRow(1).values;
  const headers = Array.isArray(headerValues) ? headerValues.slice(1).map(String) : [];
  const rows = Array.from({ length: Math.max(0, worksheet.rowCount - 1) }, (_, index) => {
    const row = worksheet.getRow(index + 2);

    return Object.fromEntries(
      headers.map((header, columnIndex) => [header, row.getCell(columnIndex + 1).value]),
    );
  });

  return { result, rows, headers };
};

describe('report processor integration', () => {
  beforeEach(() => {
    database.items = paymentAndLeaseFixtures as Array<Record<string, unknown>>;
    database.commands = [];
    database.repositoryAccounts = [];
    database.uploadedChunks = [];
    database.notifications = [];
  });

  it('applies property, lease, and status filters to formatted payment rows', async () => {
    const byProperty = await exportReport({ filters: { propertyId: 'property-a' } });
    expect(byProperty.rows.map((row) => row.Id)).toEqual([
      'payment-jan-first',
      'payment-jan-last',
      'payment-dec',
    ]);

    const byLease = await exportReport({ filters: { leaseId: 'lease-beta' } });
    expect(byLease.rows.map((row) => row.Id)).toEqual(['payment-jan-last', 'payment-feb']);

    const byStatus = await exportReport({ filters: { status: ['paid'] } });
    expect(byStatus.rows.map((row) => row.Id)).toEqual([
      'payment-jan-first',
      'payment-feb',
      'payment-dec',
    ]);
    expect(byStatus.headers).toContain('Amount Due (centimes)');
    expect(byStatus.rows[0]).toMatchObject({
      'Period Start': '2026-01-01',
      'Lease Id': 'lease-alpha',
      Status: 'paid',
      'Amount Due (centimes)': 125000,
    });
    expectAccountScopedQueriesOnly();
  });

  it('includes both date-range boundaries and filters lease register rows', async () => {
    const payments = await exportReport({ from: '2026-01-01', to: '2026-01-31' });
    expect(payments.rows.map((row) => row.Id)).toEqual([
      'payment-jan-first',
      'payment-jan-last',
    ]);

    const leases = await exportReport({
      reportType: 'LEASE_REGISTER',
      from: '2026-01-31',
      to: '2026-01-31',
      filters: { propertyId: 'property-a', leaseId: 'lease-beta', status: ['active'] },
    });
    expect(leases.rows).toHaveLength(1);
    expect(leases.rows[0]).toMatchObject({
      Id: 'lease-beta',
      'Start Date': '2026-01-31',
      'Rent Amount (centimes)': 130000,
    });
    expectAccountScopedQueriesOnly();
  });

  it('produces a valid empty workbook and keeps every query account-scoped and scan-free', async () => {
    const { result, rows, headers } = await exportReport({
      from: '2026-01-01',
      to: '2026-01-31',
      filters: { propertyId: 'property-with-no-results' },
    });

    expect(rows).toEqual([]);
    expect(headers).toEqual([]);
    expect(result.document?.sizeBytes).toBeGreaterThan(0);
    expect(database.repositoryAccounts).toEqual(['account-a']);
    expectAccountScopedQueriesOnly();
    expect(database.notifications).toHaveLength(1);
    expect(database.notifications[0]?.payload.accountId).toBe('account-a');
  });
});
