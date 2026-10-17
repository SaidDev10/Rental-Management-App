import { PutObjectCommand } from '@aws-sdk/client-s3';
import Handlebars from 'handlebars';

import { readPdfWorkerConfig } from '../../shared/config';
import { getS3Client } from '../../shared/aws/clients';
import { pk, sk } from '../../shared/db/keys';
import { getWorkerData, type WorkerEntity } from '../../shared/db/worker-data';
import { getBrowser } from '../../shared/pdf/browser';
import { enqueueNotification } from '../../shared/sqs/enqueue-notification';
import type { JobCompletion } from '../job-repository';
import type { PdfJobPayload } from '../payloads';
import { NonRetryableWorkerError } from '../job-processor';

type RenderContext = {
  title: string;
  locale: 'fr' | 'en';
  documentType: string;
  generatedAt: string;
  sections: Array<{ title: string; values: Array<{ label: string; value: string }> }>;
};

type PdfLabel =
  | 'QUITTANCE'
  | 'LEASE'
  | 'FICHE_POLICE'
  | 'ETAT_DES_LIEUX'
  | 'generated'
  | 'lease'
  | 'payment'
  | 'property'
  | 'tenant'
  | 'period'
  | 'due'
  | 'paid'
  | 'address'
  | 'status';

const safeString = (value: unknown): string => {
  if (typeof value === 'string' || typeof value === 'number') {
    return String(value);
  }

  return '—';
};

export const formatMoney = (value: unknown): string => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    return '—';
  }

  const sign = value < 0 ? '-' : '';
  const absoluteValue = Math.abs(value);
  const wholeUnits = Math.floor(absoluteValue / 100);
  const centimes = String(absoluteValue % 100).padStart(2, '0');

  return `${sign}${wholeUnits}.${centimes} MAD`;
};

const localeOf = (account: WorkerEntity | undefined): 'fr' | 'en' => {
  return account?.locale === 'en' ? 'en' : 'fr';
};

const labels: Record<'fr' | 'en', Record<PdfLabel, string>> = {
  fr: {
    QUITTANCE: 'Quittance de loyer',
    LEASE: 'Contrat de bail',
    FICHE_POLICE: 'Fiche de police',
    ETAT_DES_LIEUX: 'État des lieux',
    generated: 'Généré le',
    lease: 'Bail',
    payment: 'Paiement',
    property: 'Bien',
    tenant: 'Locataire',
    period: 'Période',
    due: 'Montant dû',
    paid: 'Montant payé',
    address: 'Adresse',
    status: 'Statut',
  },
  en: {
    QUITTANCE: 'Rent receipt',
    LEASE: 'Lease agreement',
    FICHE_POLICE: 'Police information sheet',
    ETAT_DES_LIEUX: 'Property condition report',
    generated: 'Generated on',
    lease: 'Lease',
    payment: 'Payment',
    property: 'Property',
    tenant: 'Tenant',
    period: 'Period',
    due: 'Amount due',
    paid: 'Amount paid',
    address: 'Address',
    status: 'Status',
  },
};

const htmlTemplate = Handlebars.compile(`<!doctype html>
<html lang="{{locale}}">
<head>
  <meta charset="utf-8">
  <style>
    @page { size: A4; margin: 22mm 18mm; }
    body { color: #202a35; font: 12px Arial, sans-serif; }
    h1 { border-bottom: 2px solid #2563eb; padding-bottom: 12px; }
    h2 { color: #334155; font-size: 14px; margin-top: 24px; }
    .meta { color: #64748b; font-size: 10px; }
    .row { display: flex; border-bottom: 1px solid #e2e8f0; padding: 7px 0; }
    .label { color: #64748b; width: 38%; }
    .value { font-weight: 600; }
  </style>
</head>
<body>
  <h1>{{title}}</h1>
  <p class="meta">{{generatedLabel}}: {{generatedAt}}</p>
  {{#each sections}}
    <h2>{{title}}</h2>
    {{#each values}}
      <div class="row"><span class="label">{{label}}</span><span class="value">{{value}}</span></div>
    {{/each}}
  {{/each}}
</body>
</html>`);

const getEntity = async (
  accountId: string,
  sortKey: string,
): Promise<WorkerEntity | undefined> => {
  const data = getWorkerData(accountId);

  return data.get(sortKey);
};

const loadContext = async (payload: PdfJobPayload, now: Date): Promise<RenderContext> => {
  const account = await getEntity(payload.accountId, sk.meta());
  const locale = localeOf(account);
  const text = labels[locale];
  const sections: RenderContext['sections'] = [];

  if (payload.documentType === 'QUITTANCE') {
    const payment = await getEntity(payload.accountId, sk.payment(payload.paymentId));

    if (!payment) {
      throw new NonRetryableWorkerError('PAYMENT_NOT_FOUND', 'Payment record was not found.');
    }

    const lease = await getEntity(payload.accountId, sk.lease(safeString(payment.leaseId)));
    const tenant = await getEntity(payload.accountId, sk.tenant(safeString(payment.tenantId)));
    const property = await getEntity(payload.accountId, sk.property(safeString(payment.propertyId)));

    sections.push({
      title: text.payment,
      values: [
        { label: text.tenant, value: `${safeString(tenant?.firstName)} ${safeString(tenant?.lastName)}` },
        { label: text.property, value: safeString(property?.label) },
        { label: text.lease, value: safeString(lease?.id ?? payment.leaseId) },
        { label: text.period, value: `${safeString(payment.periodStart)} – ${safeString(payment.periodEnd)}` },
        { label: text.due, value: formatMoney(payment.amountDue) },
        { label: text.paid, value: formatMoney(payment.amountPaid) },
        { label: text.status, value: safeString(payment.status) },
      ],
    });
  } else {
    const leaseId = payload.leaseId;
    const lease = await getEntity(payload.accountId, sk.lease(leaseId));

    if (!lease) {
      throw new NonRetryableWorkerError('LEASE_NOT_FOUND', 'Lease record was not found.');
    }

    const property = await getEntity(payload.accountId, sk.property(safeString(lease.propertyId)));
    const tenantIds = Array.isArray(lease.tenantIds) ? lease.tenantIds : [];
    const tenants = await Promise.all(
      tenantIds.map((tenantId) => getEntity(payload.accountId, sk.tenant(safeString(tenantId)))),
    );

    sections.push({
      title: text.lease,
      values: [
        { label: text.property, value: safeString(property?.label) },
        {
          label: text.address,
          value:
            typeof property?.address === 'object' && property.address !== null
              ? Object.values(property.address as Record<string, unknown>).map(safeString).join(', ')
              : '—',
        },
        {
          label: text.tenant,
          value: tenants
            .filter((tenant): tenant is WorkerEntity => tenant !== undefined)
            .map((tenant) => `${safeString(tenant.firstName)} ${safeString(tenant.lastName)}`)
            .join(', '),
        },
        { label: text.period, value: `${safeString(lease.startDate)} – ${safeString(lease.endDate)}` },
        { label: text.due, value: formatMoney(lease.rentAmount) },
      ],
    });
  }

  return {
    title: text[payload.documentType],
    locale,
    documentType: payload.documentType,
    generatedAt: now.toISOString(),
    sections,
  };
};

const renderPdf = async (context: RenderContext): Promise<Uint8Array> => {
  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    const html = htmlTemplate({
      ...context,
      generatedLabel: labels[context.locale].generated,
    });

    await page.setContent(html, { waitUntil: 'load', timeout: 10_000 });

    return await page.pdf({
      format: 'A4',
      printBackground: true,
      preferCSSPageSize: true,
    });
  } finally {
    await page.close();
  }
};

export const createPdfProcessor = (now: () => Date = () => new Date()) => {
  const config = readPdfWorkerConfig();

  return async (payload: PdfJobPayload): Promise<JobCompletion> => {
    const context = await loadContext(payload, now());
    const pdf = await renderPdf(context);

    if (pdf.byteLength > 50 * 1024 * 1024) {
      throw new NonRetryableWorkerError('PDF_TOO_LARGE', 'Generated PDF exceeds the size limit.');
    }

    const documentId = payload.jobId;
    const year = now().getUTCFullYear();
    const key = `documents/${payload.accountId}/${year}/${documentId}.pdf`;
    const s3 = getS3Client();

    await s3.send(
      new PutObjectCommand({
        Bucket: config.DOCUMENTS_BUCKET,
        Key: key,
        Body: pdf,
        ContentType: 'application/pdf',
        ServerSideEncryption: 'AES256',
        ChecksumAlgorithm: 'SHA256',
        Metadata: {
          accountid: payload.accountId,
          documenttype: payload.documentType.toLowerCase(),
          generatedby: 'pdf-worker',
        },
      }),
    );

    const createdAt = now().toISOString();
    const document = {
      PK: pk.account(payload.accountId),
      SK: sk.document(documentId),
      accountId: payload.accountId,
      entityType: 'Document' as const,
      documentType: payload.documentType.toLowerCase(),
      s3Bucket: config.DOCUMENTS_BUCKET,
      s3Key: key,
      mimeType: 'application/pdf',
      sizeBytes: pdf.byteLength,
      generatedBy: 'pdf-worker',
      retentionClass: 'standard',
      status: 'active',
      schemaVersion: 1,
      version: 1,
      createdAt,
      updatedAt: createdAt,
      linkedEntityType: payload.documentType === 'QUITTANCE' ? 'Payment' : 'Lease',
      linkedEntityId: payload.documentType === 'QUITTANCE' ? payload.paymentId : payload.leaseId,
    };

    await enqueueNotification(payload.jobId, {
      accountId: payload.accountId,
      kind: 'DOCUMENT_READY',
      documentId,
      channel: 'email',
    });

    return {
      resultS3Key: key,
      resultDocumentId: documentId,
      document,
    };
  };
};
