import { HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createPropertyPhotoStorage } from '../../src/modules/property/photo-storage';

const clientMock = mockClient(S3Client);

afterEach(() => {
  clientMock.reset();
});

describe('property photo storage', () => {
  it('presigns uploads with a property-scoped key and pinned content type', async () => {
    const signUrl = vi.fn(
      async (client: S3Client, command: PutObjectCommand, options: { expiresIn: number }) => {
        expect(client).toBe(clientMock);
        expect(command).toBeInstanceOf(PutObjectCommand);
        expect(options.expiresIn).toBe(300);

        return 'https://photos.example.test/upload';
      },
    );
    const client = clientMock as unknown as S3Client;
    const storage = createPropertyPhotoStorage({ client, bucketName: 'photos-test', signUrl });

    const result = await storage.presignUpload('account-1', 'property-1', 'image/jpeg', 1024);

    expect(result).toMatchObject({
      uploadUrl: 'https://photos.example.test/upload',
      expiresIn: 300,
    });
    expect(result.s3Key).toMatch(/^accounts\/account-1\/properties\/property-1\/[0-9A-HJKMNP-TV-Z]{26}\.jpg$/);
    expect(signUrl.mock.calls[0]?.[0]).toBe(client);
    const command = signUrl.mock.calls[0]?.[1];
    expect(command).toBeInstanceOf(PutObjectCommand);
    expect(command?.input).toMatchObject({
      Bucket: 'photos-test',
      Key: result.s3Key,
      ContentType: 'image/jpeg',
    });
    expect(signUrl.mock.calls[0]?.[2]).toEqual({ expiresIn: 300 });
  });

  it('rejects invalid upload content types and sizes', async () => {
    const storage = createPropertyPhotoStorage({
      client: clientMock as unknown as S3Client,
      bucketName: 'photos-test',
      signUrl: vi.fn(async () => 'https://photos.example.test/upload'),
    });

    await expect(
      // @ts-expect-error Verify runtime checks for values rejected by the static type.
      storage.presignUpload('account-1', 'property-1', 'image/gif', 1024),
    ).rejects.toMatchObject({ status: 400, code: 'VALIDATION_ERROR' });
    await expect(
      storage.presignUpload('account-1', 'property-1', 'image/jpeg', 10 * 1024 * 1024 + 1),
    ).rejects.toMatchObject({ status: 400, code: 'VALIDATION_ERROR' });
  });

  it('checks ownership and S3 object size and content type before recording uploads', async () => {
    const storage = createPropertyPhotoStorage({
      client: clientMock as unknown as S3Client,
      bucketName: 'photos-test',
      signUrl: vi.fn(async () => 'https://photos.example.test/upload'),
    });
    const { s3Key } = await storage.presignUpload('account-1', 'property-1', 'image/png', 1024);
    clientMock.on(HeadObjectCommand).resolves({ ContentLength: 1024, ContentType: 'image/png' });

    await expect(storage.verifyUpload('account-1', 'property-1', s3Key)).resolves.toBeUndefined();
    expect(clientMock.commandCalls(HeadObjectCommand)[0]?.args[0].input).toEqual({
      Bucket: 'photos-test',
      Key: s3Key,
    });

    await expect(storage.verifyUpload('account-2', 'property-1', s3Key)).rejects.toMatchObject({
      status: 400,
      code: 'INVALID_PHOTO_KEY',
    });
    expect(clientMock.commandCalls(HeadObjectCommand)).toHaveLength(1);
  });

  it('rejects S3 objects that exceed the limit or have a mismatched content type', async () => {
    const storage = createPropertyPhotoStorage({
      client: clientMock as unknown as S3Client,
      bucketName: 'photos-test',
      signUrl: vi.fn(async () => 'https://photos.example.test/upload'),
    });
    const { s3Key } = await storage.presignUpload('account-1', 'property-1', 'image/jpeg', 1024);

    clientMock.on(HeadObjectCommand).resolves({
      ContentLength: 10 * 1024 * 1024 + 1,
      ContentType: 'image/jpeg',
    });
    await expect(storage.verifyUpload('account-1', 'property-1', s3Key)).rejects.toMatchObject({
      status: 400,
      code: 'INVALID_PHOTO_UPLOAD',
    });

    clientMock.on(HeadObjectCommand).resolves({ ContentLength: 1024, ContentType: 'image/png' });
    await expect(storage.verifyUpload('account-1', 'property-1', s3Key)).rejects.toMatchObject({
      status: 400,
      code: 'INVALID_PHOTO_UPLOAD',
    });
  });

  it('returns a client error when the uploaded object is missing and propagates other S3 failures', async () => {
    const storage = createPropertyPhotoStorage({
      client: clientMock as unknown as S3Client,
      bucketName: 'photos-test',
      signUrl: vi.fn(async () => 'https://photos.example.test/upload'),
    });
    const { s3Key } = await storage.presignUpload('account-1', 'property-1', 'image/jpeg', 1024);
    const missingObject = new Error('Not found');
    missingObject.name = 'NotFound';
    clientMock.on(HeadObjectCommand).rejects(missingObject);

    await expect(storage.verifyUpload('account-1', 'property-1', s3Key)).rejects.toMatchObject({
      status: 400,
      code: 'PHOTO_UPLOAD_NOT_FOUND',
    });

    const accessDenied = new Error('Access denied');
    accessDenied.name = 'AccessDenied';
    clientMock.on(HeadObjectCommand).rejects(accessDenied);
    await expect(storage.verifyUpload('account-1', 'property-1', s3Key)).rejects.toBe(accessDenied);
  });
});
