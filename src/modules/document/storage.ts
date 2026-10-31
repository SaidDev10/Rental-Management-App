import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { ulid } from 'ulid';

import { AppError } from '../../shared/errors';
import { getS3Client } from '../../shared/aws/clients';
import type { DocumentContentType } from './types';

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const URL_EXPIRY_SECONDS = 300;
const extensionFor: Record<DocumentContentType, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

export type DocumentStorage = {
  presignUpload: (
    accountId: string,
    documentType: DocumentContentType,
    sizeBytes: number,
  ) => Promise<{ uploadUrl: string; s3Key: string; expiresIn: number }>;
  verifyUpload: (accountId: string, documentId: string, s3Key: string, mimeType: DocumentContentType, sizeBytes: number) => Promise<void>;
  presignDownload: (s3Key: string, documentId: string, mimeType: DocumentContentType) => Promise<{ url: string; expiresIn: number }>;
};

type DocumentStorageOptions = {
  client?: S3Client;
  bucketName?: string;
  signUrl?: typeof getSignedUrl;
};

const bucket = (configured: string | undefined): string => {
  if (!configured) {
    throw new Error('DOCUMENTS_BUCKET must be configured before using document storage.');
  }

  return configured;
};

const keyPrefix = (accountId: string): string => `accounts/${encodeURIComponent(accountId)}/documents/`;
const isNotFound = (error: unknown): boolean =>
  !!error && typeof error === 'object' &&
  ((error as { name?: string }).name === 'NotFound' ||
    (error as { name?: string }).name === 'NoSuchKey' ||
    (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404);

const requireUpload: (mimeType: string, sizeBytes: number) => asserts mimeType is DocumentContentType = (mimeType, sizeBytes) => {
  if (
    !Object.hasOwn(extensionFor, mimeType) ||
    !Number.isInteger(sizeBytes) ||
    sizeBytes < 1 ||
    sizeBytes > MAX_UPLOAD_BYTES
  ) {
    throw new AppError('Invalid document content type or size.', 400, 'VALIDATION_ERROR');
  }
};

export const createDocumentStorage = ({
  client,
  bucketName = process.env.DOCUMENTS_BUCKET,
  signUrl = getSignedUrl,
}: DocumentStorageOptions = {}): DocumentStorage => ({
  async presignUpload(accountId, mimeType, sizeBytes) {
    requireUpload(mimeType, sizeBytes);
    const documentId = ulid();
    const s3Key = `${keyPrefix(accountId)}${documentId}.${extensionFor[mimeType]}`;
    const uploadUrl = await signUrl(
      client ?? getS3Client(),
      new PutObjectCommand({
        Bucket: bucket(bucketName),
        Key: s3Key,
        ContentType: mimeType,
      }),
      { expiresIn: URL_EXPIRY_SECONDS },
    );

    return { uploadUrl, s3Key, expiresIn: URL_EXPIRY_SECONDS };
  },

  async verifyUpload(accountId, documentId, s3Key, mimeType, sizeBytes) {
    requireUpload(mimeType, sizeBytes);
    const prefix = keyPrefix(accountId);
    const match = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([0-9A-HJKMNP-TV-Z]{26})\\.(jpg|png|webp)$`).exec(s3Key);
    if (!match || match[1] !== documentId || extensionFor[mimeType] !== match[2]) {
      throw new AppError('Document key does not belong to this account or upload.', 400, 'INVALID_DOCUMENT_KEY');
    }

    let result;
    try {
      result = await (client ?? getS3Client()).send(
        new HeadObjectCommand({ Bucket: bucket(bucketName), Key: s3Key }),
      );
    } catch (error) {
      if (isNotFound(error)) {
        throw new AppError('Uploaded document was not found in storage.', 400, 'DOCUMENT_UPLOAD_NOT_FOUND');
      }

      throw error;
    }

    if (
      result.ContentType !== mimeType ||
      typeof result.ContentLength !== 'number' ||
      !Number.isInteger(result.ContentLength) ||
      result.ContentLength !== sizeBytes ||
      result.ContentLength < 1 ||
      result.ContentLength > MAX_UPLOAD_BYTES
    ) {
      throw new AppError('Uploaded document has an invalid content type or size.', 400, 'INVALID_DOCUMENT_UPLOAD');
    }
  },

  async presignDownload(s3Key, documentId, mimeType) {
    const extension = extensionFor[mimeType];
    const safeFilename = `document-${documentId}.${extension}`.replace(/[^A-Za-z0-9._-]/g, '_');
    const url = await signUrl(
      client ?? getS3Client(),
      new GetObjectCommand({
        Bucket: bucket(bucketName),
        Key: s3Key,
        ResponseContentDisposition: `attachment; filename="${safeFilename}"`,
      }),
      { expiresIn: URL_EXPIRY_SECONDS },
    );

    return { url, expiresIn: URL_EXPIRY_SECONDS };
  },
});

export const documentStorage = createDocumentStorage();
