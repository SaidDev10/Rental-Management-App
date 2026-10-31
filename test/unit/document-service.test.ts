import { describe, expect, it, vi } from 'vitest';

import { createDocumentService } from '../../src/modules/document/service';
import type { DocumentRepository } from '../../src/modules/document/repository';
import type { DocumentStorage } from '../../src/modules/document/storage';

const storedDocument = {
  id: '01JABCDEF0123456789ABCDEFG',
  accountId: 'account-1',
  documentType: 'lease' as const,
  s3Bucket: 'documents-test',
  s3Key: 'accounts/account-1/documents/01JABCDEF0123456789ABCDEFG.jpg',
  mimeType: 'image/jpeg' as const,
  sizeBytes: 123,
  checksumSha256: null,
  linkedEntityType: 'Lease' as const,
  linkedEntityId: 'lease-1',
  generatedBy: 'upload' as const,
  retentionClass: 'standard' as const,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  PK: 'ACCOUNT#account-1',
  SK: 'DOC#01JABCDEF0123456789ABCDEFG',
  entityType: 'Document' as const,
  schemaVersion: 1,
};

describe('document service', () => {
  it('requires an entity in the authenticated account and verifies the stored upload before recording metadata', async () => {
    const repository = {
      assertLinkedEntityExists: vi.fn(async () => undefined),
      create: vi.fn(async () => storedDocument),
    } as unknown as DocumentRepository;
    const storage = {
      verifyUpload: vi.fn(async () => undefined),
    } as unknown as DocumentStorage;
    const previousBucket = process.env.DOCUMENTS_BUCKET;

    process.env.DOCUMENTS_BUCKET = 'documents-test';

    const service = createDocumentService({
      repositoryFor: vi.fn((accountId) => {
        expect(accountId).toBe('account-1');

        return repository;
      }),
      storage,
    });

    try {
      const input = {
        documentType: 'lease' as const,
        linkedEntityType: 'Lease' as const,
        linkedEntityId: 'lease-1',
        contentType: 'image/jpeg' as const,
        sizeBytes: 123,
        s3Key: storedDocument.s3Key,
      };
      await expect(service.confirm('account-1', input)).resolves.toEqual(storedDocument);
      expect(repository.assertLinkedEntityExists).toHaveBeenCalledWith('Lease', 'lease-1');
      expect(storage.verifyUpload).toHaveBeenCalledWith(
        'account-1',
        storedDocument.id,
        storedDocument.s3Key,
        'image/jpeg',
        123,
      );
      expect(repository.create).toHaveBeenCalledWith(expect.objectContaining({
        id: storedDocument.id,
        s3Bucket: 'documents-test',
        linkedEntityId: 'lease-1',
        sizeBytes: 123,
      }));
    } finally {
      if (previousBucket === undefined) delete process.env.DOCUMENTS_BUCKET;
      else process.env.DOCUMENTS_BUCKET = previousBucket;
    }
  });

  it('does not verify or create uploads for a key outside the caller account prefix', async () => {
    const repository = {
      assertLinkedEntityExists: vi.fn(),
      create: vi.fn(),
    } as unknown as DocumentRepository;
    const storage = { verifyUpload: vi.fn() } as unknown as DocumentStorage;
    const service = createDocumentService({ repositoryFor: () => repository, storage });

    await expect(service.confirm('account-1', {
      documentType: 'lease',
      linkedEntityType: 'Lease',
      linkedEntityId: 'lease-1',
      contentType: 'image/jpeg',
      sizeBytes: 123,
      s3Key: 'accounts/account-2/documents/01JABCDEF0123456789ABCDEFG.jpg',
    })).rejects.toMatchObject({ code: 'INVALID_DOCUMENT_KEY' });
    expect(repository.assertLinkedEntityExists).not.toHaveBeenCalled();
    expect(storage.verifyUpload).not.toHaveBeenCalled();
    expect(repository.create).not.toHaveBeenCalled();
  });
});
