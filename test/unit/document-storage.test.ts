import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDocumentStorage } from '../../src/modules/document/storage';

const clientMock = mockClient(S3Client);

afterEach(() => clientMock.reset());

describe('document storage', () => {
  it('pins upload content type and five-minute expiry to an account-scoped key', async () => {
    const signUrl = vi.fn(async (_client: S3Client, command: PutObjectCommand, options: { expiresIn: number }) => {
      expect(command.input.ContentType).toBe('image/png');
      expect(options.expiresIn).toBe(300);

      return 'https://storage.example.test/upload';
    });
    const storage = createDocumentStorage({
      client: clientMock as unknown as S3Client,
      bucketName: 'documents-test',
      signUrl: signUrl as never,
    });

    const upload = await storage.presignUpload('account-1', 'image/png', 100);
    expect(upload).toMatchObject({
      uploadUrl: 'https://storage.example.test/upload',
      expiresIn: 300,
    });
    expect(upload.s3Key).toMatch(/^accounts\/account-1\/documents\/[0-9A-HJKMNP-TV-Z]{26}\.png$/);
    expect(signUrl.mock.calls[0]?.[1]).toBeInstanceOf(PutObjectCommand);
  });

  it('rejects invalid media types and sizes before signing', async () => {
    const signUrl = vi.fn(async () => 'url');
    const storage = createDocumentStorage({
      client: clientMock as unknown as S3Client,
      bucketName: 'documents-test',
      signUrl: signUrl as never,
    });
    await expect(storage.presignUpload('account-1', 'image/gif' as never, 20)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    await expect(storage.presignUpload('account-1', 'image/jpeg', 10 * 1024 * 1024 + 1)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    expect(signUrl).not.toHaveBeenCalled();
  });

  it('validates account/key ownership, exact declared type and length before confirmation', async () => {
    const storage = createDocumentStorage({
      client: clientMock as unknown as S3Client,
      bucketName: 'documents-test',
      signUrl: vi.fn(async () => 'url') as never,
    });
    const { s3Key } = await storage.presignUpload('account-1', 'image/jpeg', 123);
    const id = s3Key.split('/').at(-1)!.slice(0, 26);
    clientMock.on(HeadObjectCommand).resolves({ ContentType: 'image/jpeg', ContentLength: 123 });

    await expect(storage.verifyUpload('account-1', id, s3Key, 'image/jpeg', 123)).resolves.toBeUndefined();
    expect(clientMock.commandCalls(HeadObjectCommand)[0]?.args[0].input).toEqual({
      Bucket: 'documents-test',
      Key: s3Key,
    });
    await expect(storage.verifyUpload('other-account', id, s3Key, 'image/jpeg', 123)).rejects.toMatchObject({
      code: 'INVALID_DOCUMENT_KEY',
    });
    expect(clientMock.commandCalls(HeadObjectCommand)).toHaveLength(1);

    clientMock.on(HeadObjectCommand).resolves({ ContentType: 'image/png', ContentLength: 123 });
    await expect(storage.verifyUpload('account-1', id, s3Key, 'image/jpeg', 123)).rejects.toMatchObject({
      code: 'INVALID_DOCUMENT_UPLOAD',
    });
    clientMock.on(HeadObjectCommand).resolves({ ContentType: 'image/jpeg', ContentLength: 124 });
    await expect(storage.verifyUpload('account-1', id, s3Key, 'image/jpeg', 123)).rejects.toMatchObject({
      code: 'INVALID_DOCUMENT_UPLOAD',
    });
  });

  it('rejects confirmation when the uploaded S3 object does not exist', async () => {
    const storage = createDocumentStorage({
      client: clientMock as unknown as S3Client,
      bucketName: 'documents-test',
      signUrl: vi.fn(async () => 'url') as never,
    });
    const { s3Key } = await storage.presignUpload('account-1', 'image/jpeg', 123);
    const id = s3Key.split('/').at(-1)!.slice(0, 26);
    clientMock.on(HeadObjectCommand).rejects(Object.assign(new Error('missing'), {
      name: 'NotFound',
      $metadata: { httpStatusCode: 404 },
    }));

    await expect(storage.verifyUpload('account-1', id, s3Key, 'image/jpeg', 123)).rejects.toMatchObject({
      code: 'DOCUMENT_UPLOAD_NOT_FOUND',
      status: 400,
    });
  });

  it('presigns a five-minute attachment download with a sanitized filename', async () => {
    const signUrl = vi.fn(async (_client: S3Client, command: GetObjectCommand, options: { expiresIn: number }) => {
      expect(command.input.ResponseContentDisposition).toMatch(/^attachment; filename="document-[A-Za-z0-9._-]+\.webp"$/);
      expect(options.expiresIn).toBe(300);

      return 'https://storage.example.test/download';
    });
    const storage = createDocumentStorage({
      client: clientMock as unknown as S3Client,
      bucketName: 'documents-test',
      signUrl: signUrl as never,
    });

    await expect(storage.presignDownload('accounts/a/key.webp', '01JABCDEF0123456789ABCDEFG', 'image/webp')).resolves.toEqual({
      url: 'https://storage.example.test/download',
      expiresIn: 300,
    });
    expect(signUrl.mock.calls[0]?.[1]).toBeInstanceOf(GetObjectCommand);
  });
});
