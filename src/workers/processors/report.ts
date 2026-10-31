import { PutObjectCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import ExcelJS from 'exceljs';
import { PassThrough } from 'node:stream';

import { getS3Client } from '../../shared/aws/clients';
import { readReportWorkerConfig } from '../../shared/config';
import { pk, sk } from '../../shared/db/keys';
import { getWorkerData, type WorkerEntity } from '../../shared/db/worker-data';
import { getBrowser } from '../../shared/pdf/browser';
import { enqueueNotification } from '../../shared/sqs/enqueue-notification';
import type { JobCompletion } from '../job-repository';
import type { ReportJobPayload } from '../payloads';
import { NonRetryableWorkerError } from '../job-processor';

type ReportRow = Record<string, string | number>;

const MAX_REPORT_ROWS = 50_000;
const MAX_REPORT_MONTHS = 24;

const compareIsoDate = (left: string, right: string): number => {
  return left.localeCompare(right);
};

export const listReportMonths = (from: string, to: string): string[] => {
  const startMonth = from.slice(0, 7);
  const endMonth = to.slice(0, 7);
  const [startYear = Number.NaN, startMonthValue = Number.NaN] = startMonth.split('-').map(Number);
  const [endYear = Number.NaN, endMonthValue = Number.NaN] = endMonth.split('-').map(Number);
  const validMonth =
    Number.isInteger(startYear) &&
    Number.isInteger(endYear) &&
    Number.isInteger(startMonthValue) &&
    Number.isInteger(endMonthValue) &&
    startMonthValue >= 1 &&
    startMonthValue <= 12 &&
    endMonthValue >= 1 &&
    endMonthValue <= 12;

  if (!validMonth) {
    throw new NonRetryableWorkerError('REPORT_RANGE_INVALID', 'Report dates must be valid ISO dates.');
  }
  const startIndex = startYear * 12 + startMonthValue - 1;
  const endIndex = endYear * 12 + endMonthValue - 1;
  const count = endIndex - startIndex + 1;

  if (count < 1 || count > MAX_REPORT_MONTHS) {
    throw new NonRetryableWorkerError('REPORT_RANGE_INVALID', 'Report date range exceeds 24 months.');
  }

  return Array.from({ length: count }, (_, offset) => {
    const absoluteMonth = startIndex + offset;
    const year = Math.floor(absoluteMonth / 12);
    const month = String((absoluteMonth % 12) + 1).padStart(2, '0');

    return `${year}-${month}`;
  });
};

const queryPrefix = async (
  accountId: string,
  prefix: string,
  from?: string,
  to?: string,
): Promise<WorkerEntity[]> => {
  const data = getWorkerData(accountId);
  const items: WorkerEntity[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;

  do {
    const page = await data.query({
      limit: 500,
      sortKeyPrefix: prefix,
      ...(exclusiveStartKey === undefined ? {} : { exclusiveStartKey }),
    });

    items.push(...page.items);

    if (items.length > MAX_REPORT_ROWS) {
      throw new NonRetryableWorkerError(
        'REPORT_TOO_LARGE',
        'Report contains more than 50,000 rows. Narrow the date range or filters.',
      );
    }

    exclusiveStartKey = page.lastEvaluatedKey;
  } while (exclusiveStartKey !== undefined);

  return items.filter((item) => {
    const date =
      typeof item.periodStart === 'string'
        ? item.periodStart
        : typeof item.startDate === 'string'
          ? item.startDate
          : undefined;

    return date === undefined || (from !== undefined && to !== undefined && date >= from && date <= to);
  });
};

const loadRows = async (payload: ReportJobPayload): Promise<ReportRow[]> => {
  if (compareIsoDate(payload.from, payload.to) > 0) {
    throw new NonRetryableWorkerError('REPORT_RANGE_INVALID', 'Report start date must not follow end date.');
  }

  if (payload.reportType === 'INCOME_STATEMENT' || payload.reportType === 'TAX_ANNUAL') {
    const months = listReportMonths(payload.from, payload.to);
    const data = getWorkerData(payload.accountId);
    const summaries = await Promise.all(months.map((month) => data.get(sk.summary(month))));

    return summaries
      .filter((summary): summary is WorkerEntity => summary !== undefined)
      .map((summary) => ({
        month: summary.SK.slice('SUMMARY#'.length),
        totalIncomeCentimes: typeof summary.totalIncome === 'number' ? summary.totalIncome : 0,
        totalExpensesCentimes: typeof summary.totalExpenses === 'number' ? summary.totalExpenses : 0,
        latePayments: typeof summary.latePayments === 'number' ? summary.latePayments : 0,
        paidPayments: typeof summary.paidPayments === 'number' ? summary.paidPayments : 0,
      }));
  }

  const prefix = payload.reportType === 'PAYMENT_REGISTER' ? 'PAYMENT#' : 'LEASE#';
  const items = await queryPrefix(payload.accountId, prefix, payload.from, payload.to);
  const filtered = items.filter((item) => {
    if (payload.filters?.leaseId && item.leaseId !== payload.filters.leaseId && item.SK !== sk.lease(payload.filters.leaseId)) {
      return false;
    }

    if (payload.filters?.propertyId && item.propertyId !== payload.filters.propertyId) {
      return false;
    }

    if (payload.filters?.status && !payload.filters.status.includes(String(item.status))) {
      return false;
    }

    return true;
  });

  return filtered.map((item) => ({
    id: item.SK.replace(/^[^#]+#/, ''),
    ...(typeof item.periodStart === 'string' ? { periodStart: item.periodStart } : {}),
    ...(typeof item.dueDate === 'string' ? { dueDate: item.dueDate } : {}),
    ...(typeof item.startDate === 'string' ? { startDate: item.startDate } : {}),
    ...(typeof item.endDate === 'string' ? { endDate: item.endDate } : {}),
    ...(typeof item.leaseId === 'string' ? { leaseId: item.leaseId } : {}),
    ...(typeof item.propertyId === 'string' ? { propertyId: item.propertyId } : {}),
    ...(typeof item.status === 'string' ? { status: item.status } : {}),
    ...(typeof item.amountDue === 'number' ? { amountDueCentimes: item.amountDue } : {}),
    ...(typeof item.amountPaid === 'number' ? { amountPaidCentimes: item.amountPaid } : {}),
    ...(typeof item.rentAmount === 'number' ? { rentAmountCentimes: item.rentAmount } : {}),
  }));
};

const formatHeader = (value: string): string => {
  return value
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\s*Centimes$/, ' (centimes)')
    .replace(/^./, (first) => first.toUpperCase());
};

const uploadXlsx = async (
  rows: ReportRow[],
  key: string,
  bucket: string,
): Promise<number> => {
  const stream = new PassThrough();
  let sizeBytes = 0;
  stream.on('data', (chunk: Uint8Array) => {
    sizeBytes += chunk.byteLength;
  });

  const s3 = getS3Client();
  const upload = new Upload({
    client: s3,
    params: {
      Bucket: bucket,
      Key: key,
      Body: stream,
      ContentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      ServerSideEncryption: 'AES256',
      Metadata: { generatedby: 'report-worker' },
    },
    queueSize: 2,
    partSize: 5 * 1024 * 1024,
    leavePartsOnError: false,
  });
  const uploadResult = upload.done();
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
    stream,
    useStyles: true,
    useSharedStrings: true,
  });
  const worksheet = workbook.addWorksheet('Report', {
    views: [{ state: 'frozen', ySplit: 1 }],
  });
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];

  worksheet.columns = columns.map((keyName) => ({
    header: formatHeader(keyName),
    key: keyName,
    width: Math.min(36, Math.max(14, formatHeader(keyName).length + 2)),
  }));
  for (const row of rows) {
    worksheet.addRow(row).commit();
  }

  worksheet.commit();
  await workbook.commit();
  await uploadResult;

  return sizeBytes;
};

const escapeHtml = (value: string): string => {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
};

const uploadPdf = async (
  rows: ReportRow[],
  payload: ReportJobPayload,
  key: string,
  bucket: string,
): Promise<number> => {
  const browser = await getBrowser();
  const page = await browser.newPage();
  const headings = rows.length > 0 ? Object.keys(rows[0] ?? {}) : ['message'];
  const body = rows
    .map((row) => `<tr>${headings.map((heading) => `<td>${escapeHtml(String(row[heading] ?? ''))}</td>`).join('')}</tr>`)
    .join('');
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    @page { size: A4 landscape; margin: 14mm; }
    body { font: 10px Arial, sans-serif; color: #1f2937; }
    h1 { font-size: 18px; } table { border-collapse: collapse; width: 100%; }
    th,td { border: 1px solid #cbd5e1; padding: 5px; text-align: left; }
    th { background: #e2e8f0; }
  </style></head><body><h1>${escapeHtml(payload.reportType)}</h1>
  <p>${escapeHtml(payload.from)} – ${escapeHtml(payload.to)}</p>
  <table><thead><tr>${headings.map((heading) => `<th>${escapeHtml(formatHeader(heading))}</th>`).join('')}</tr></thead>
  <tbody>${body}</tbody></table></body></html>`;

  try {
    await page.setContent(html, { waitUntil: 'load', timeout: 10_000 });
    const pdf = await page.pdf({
      format: 'A4',
      landscape: true,
      printBackground: true,
    });

    if (pdf.byteLength > 50 * 1024 * 1024) {
      throw new NonRetryableWorkerError('REPORT_TOO_LARGE', 'Generated report exceeds the 50 MB limit.');
    }

    await getS3Client().send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: pdf,
        ContentType: 'application/pdf',
        ServerSideEncryption: 'AES256',
        ChecksumAlgorithm: 'SHA256',
        Metadata: { generatedby: 'report-worker', accountid: payload.accountId },
      }),
    );

    return pdf.byteLength;
  } finally {
    await page.close();
  }
};

export const createReportProcessor = (now: () => Date = () => new Date()) => {
  const config = readReportWorkerConfig();

  return async (payload: ReportJobPayload): Promise<JobCompletion> => {
    const rows = await loadRows(payload);

    if (rows.length > MAX_REPORT_ROWS) {
      throw new NonRetryableWorkerError(
        'REPORT_TOO_LARGE',
        'Report contains more than 50,000 rows. Narrow the date range or filters.',
      );
    }

    const documentId = payload.jobId;
    const extension = payload.format === 'xlsx' ? 'xlsx' : 'pdf';
    const contentType =
      payload.format === 'xlsx'
        ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        : 'application/pdf';
    const key = `documents/${payload.accountId}/${now().getUTCFullYear()}/${documentId}.${extension}`;
    const sizeBytes =
      payload.format === 'xlsx'
        ? await uploadXlsx(rows, key, config.DOCUMENTS_BUCKET)
        : await uploadPdf(rows, payload, key, config.DOCUMENTS_BUCKET);
    const createdAt = now().toISOString();

    await enqueueNotification(payload.jobId, {
      accountId: payload.accountId,
      kind: 'REPORT_READY',
      documentId,
      channel: 'email',
    });

    return {
      resultS3Key: key,
      resultDocumentId: documentId,
      document: {
        PK: pk.account(payload.accountId),
        SK: sk.document(documentId),
        accountId: payload.accountId,
        entityType: 'Document',
        documentType: 'report',
        s3Bucket: config.DOCUMENTS_BUCKET,
        s3Key: key,
        mimeType: contentType,
        sizeBytes,
        generatedBy: 'report-worker',
        retentionClass: 'standard',
        status: 'active',
        linkedEntityType: payload.filters?.propertyId === undefined ? 'Account' : 'Property',
        linkedEntityId: payload.filters?.propertyId ?? payload.accountId,
        reportType: payload.reportType,
        reportFrom: payload.from,
        reportTo: payload.to,
        schemaVersion: 1,
        version: 1,
        createdAt,
        updatedAt: createdAt,
      },
    };
  };
};
