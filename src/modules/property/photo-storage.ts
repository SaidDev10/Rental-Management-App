import { HeadObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { ulid } from 'ulid';

import { AppError } from '../../shared/errors';
import { getS3Client } from '../../shared/aws/clients';

const PHOTO_MAX_SIZE_BYTES = 10 * 1024 * 1024;
const UPLOAD_URL_EXPIRES_IN = 300;

const photoTypes = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
} as const;

export type PropertyPhotoContentType = keyof typeof photoTypes;

export type PropertyPhotoStorage = {
  presignUpload: (
    accountId: string,
    propertyId: string,
    contentType: PropertyPhotoContentType,
    sizeBytes: number,
  ) => Promise<{ uploadUrl: string; s3Key: string; expiresIn: number }>;
  verifyUpload: (accountId: string, propertyId: string, s3Key: string) => Promise<void>;
};

type PropertyPhotoStorageOptions = {
  client?: S3Client;
  bucketName?: string;
  signUrl?: (
    client: S3Client,
    command: PutObjectCommand,
    options: { expiresIn: number },
  ) => Promise<string>;
};

const getBucketName = (bucketName: string | undefined): string => {
  if (!bucketName) {
    throw new Error('PHOTOS_BUCKET must be configured before using property photo storage.');
  }

  return bucketName;
};

const photoKeyPrefix = (accountId: string, propertyId: string): string =>
  `accounts/${encodeURIComponent(accountId)}/properties/${encodeURIComponent(propertyId)}/`;

const isMissingS3Object = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const s3Error = error as { name?: string; $metadata?: { httpStatusCode?: number } };

  return (
    s3Error.name === 'NotFound' ||
    s3Error.name === 'NoSuchKey' ||
    s3Error.$metadata?.httpStatusCode === 404
  );
};

export const createPropertyPhotoStorage = ({
  client,
  bucketName = process.env.PHOTOS_BUCKET,
  signUrl = getSignedUrl,
}: PropertyPhotoStorageOptions = {}): PropertyPhotoStorage => ({
  async presignUpload(accountId, propertyId, contentType, sizeBytes) {
    if (
      !Object.hasOwn(photoTypes, contentType) ||
      !Number.isInteger(sizeBytes) ||
      sizeBytes < 1 ||
      sizeBytes > PHOTO_MAX_SIZE_BYTES
    ) {
      throw new AppError('Invalid property photo content type or size.', 400, 'VALIDATION_ERROR');
    }

    const s3Key = `${photoKeyPrefix(accountId, propertyId)}${ulid()}.${photoTypes[contentType]}`;
    const uploadUrl = await signUrl(
      client ?? getS3Client(),
      new PutObjectCommand({
        Bucket: getBucketName(bucketName),
        Key: s3Key,
        ContentType: contentType,
      }),
      { expiresIn: UPLOAD_URL_EXPIRES_IN },
    );

    return { uploadUrl, s3Key, expiresIn: UPLOAD_URL_EXPIRES_IN };
  },

  async verifyUpload(accountId, propertyId, s3Key) {
    const prefix = photoKeyPrefix(accountId, propertyId);
    const filename = s3Key.startsWith(prefix) ? s3Key.slice(prefix.length) : '';
    const match = /^([0-9A-HJKMNP-TV-Z]{26})\.(jpg|png|webp)$/.exec(filename);
    if (!match) {
      throw new AppError('Photo key does not belong to this account and property.', 400, 'INVALID_PHOTO_KEY');
    }

    let result;
    try {
      result = await (client ?? getS3Client()).send(
        new HeadObjectCommand({ Bucket: getBucketName(bucketName), Key: s3Key }),
      );
    } catch (error) {
      if (isMissingS3Object(error)) {
        throw new AppError('Uploaded photo was not found in storage.', 400, 'PHOTO_UPLOAD_NOT_FOUND');
      }

      throw error;
    }
    const contentType = result.ContentType;
    const contentLength = result.ContentLength;
    const expectedExtension =
      contentType && Object.hasOwn(photoTypes, contentType)
        ? photoTypes[contentType as PropertyPhotoContentType]
        : undefined;

    if (
      !contentType ||
      expectedExtension !== match[2] ||
      typeof contentLength !== 'number' ||
      !Number.isInteger(contentLength) ||
      contentLength < 1 ||
      contentLength > PHOTO_MAX_SIZE_BYTES
    ) {
      throw new AppError('Uploaded photo has an invalid content type or size.', 400, 'INVALID_PHOTO_UPLOAD');
    }
  },
});

export const propertyPhotoStorage = createPropertyPhotoStorage();
