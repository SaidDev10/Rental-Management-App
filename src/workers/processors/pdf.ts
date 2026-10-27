import { PutObjectCommand } from '@aws-sdk/client-s3';

import { readPdfWorkerConfig } from '../../shared/config';
import { getS3Client } from '../../shared/aws/clients';
import { pk, sk } from '../../shared/db/keys';
import { getBrowser } from '../../shared/pdf/browser';
import { enqueueNotification } from '../../shared/sqs/enqueue-notification';
import type { JobCompletion } from '../job-repository';
import type { PdfJobPayload } from '../payloads';
import { NonRetryableWorkerError } from '../job-processor';
import { buildPdfContext, renderPdfHtml, type RenderContext } from './pdf-documents';
export { formatMoney } from './pdf-documents';

const renderPdf = async (context: RenderContext): Promise<Uint8Array> => {
  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    const html = renderPdfHtml(context);

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
    const context = await buildPdfContext(payload, now());
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
