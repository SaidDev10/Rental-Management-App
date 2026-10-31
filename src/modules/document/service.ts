import { AppError, NotFoundError } from '../../shared/errors';
import { createDocumentRepository, type DocumentRepository } from './repository';
import { createDocumentStorage, type DocumentStorage } from './storage';
import type { CreateDocumentInput, DocumentContentType, DocumentType, LinkedEntityType } from './types';

export type PresignDocumentInput = {
  documentType: DocumentType;
  linkedEntityType: LinkedEntityType;
  linkedEntityId: string;
  contentType: DocumentContentType;
  sizeBytes: number;
};

export type ConfirmDocumentInput = PresignDocumentInput & { s3Key: string };

export type DocumentService = {
  list: (accountId: string, filters: { linkedEntityType?: LinkedEntityType; linkedEntityId?: string; documentType?: DocumentType; cursor?: Record<string, unknown> }) => ReturnType<DocumentRepository['list']>;
  get: (accountId: string, id: string) => Promise<NonNullable<Awaited<ReturnType<DocumentRepository['getById']>>>>;
  presign: (accountId: string, input: PresignDocumentInput) => Promise<{ uploadUrl: string; s3Key: string; expiresIn: number }>;
  confirm: (accountId: string, input: ConfirmDocumentInput) => Promise<Awaited<ReturnType<DocumentRepository['create']>>>;
  downloadUrl: (accountId: string, id: string) => Promise<{ url: string; expiresIn: number }>;
  delete: (accountId: string, id: string) => Promise<void>;
};

type Options = {
  repositoryFor?: (accountId: string) => DocumentRepository;
  storage?: DocumentStorage;
};

const getDocumentIdFromKey = (accountId: string, s3Key: string): string => {
  const prefix = `accounts/${encodeURIComponent(accountId)}/documents/`;
  const match = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([0-9A-HJKMNP-TV-Z]{26})\\.(jpg|png|webp)$`).exec(s3Key);
  if (!match) throw new AppError('Document key does not belong to this account.', 400, 'INVALID_DOCUMENT_KEY');

  return match[1]!;
};

export const createDocumentService = ({
  repositoryFor = (accountId) => createDocumentRepository({ accountId }),
  storage = createDocumentStorage(),
}: Options = {}): DocumentService => ({
  list(accountId, filters) {
    return repositoryFor(accountId).list(filters);
  },

  async get(accountId, id) {
    const document = await repositoryFor(accountId).getById(id);
    if (!document) throw new NotFoundError('DOCUMENT_NOT_FOUND');

    return document;
  },

  async presign(accountId, input) {
    await repositoryFor(accountId).assertLinkedEntityExists(input.linkedEntityType, input.linkedEntityId);

    return storage.presignUpload(accountId, input.contentType, input.sizeBytes);
  },

  async confirm(accountId, input) {
    const documentId = getDocumentIdFromKey(accountId, input.s3Key);
    const repository = repositoryFor(accountId);
    await repository.assertLinkedEntityExists(input.linkedEntityType, input.linkedEntityId);
    await storage.verifyUpload(accountId, documentId, input.s3Key, input.contentType, input.sizeBytes);
    const record: CreateDocumentInput = {
      id: documentId,
      documentType: input.documentType,
      s3Bucket: process.env.DOCUMENTS_BUCKET ?? '',
      s3Key: input.s3Key,
      mimeType: input.contentType,
      sizeBytes: input.sizeBytes,
      checksumSha256: null,
      linkedEntityType: input.linkedEntityType,
      linkedEntityId: input.linkedEntityId,
    };
    if (!record.s3Bucket) throw new Error('DOCUMENTS_BUCKET must be configured before confirming document uploads.');

    return repository.create(record);
  },

  async downloadUrl(accountId, id) {
    const document = await this.get(accountId, id);

    return storage.presignDownload(document.s3Key, document.id, document.mimeType);
  },

  async delete(accountId, id) {
    await this.get(accountId, id);
    await repositoryFor(accountId).softDelete(id);
  },
});

export const documentService = createDocumentService();
