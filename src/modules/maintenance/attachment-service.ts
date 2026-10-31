import { createDocumentStorage, type DocumentStorage } from '../document/storage';
import {
  createMaintenanceAttachmentRepository,
  type MaintenanceAttachmentRepository,
} from './attachment-repository';
import type { DocumentContentType } from '../document/types';
import { AppError } from '../../shared/errors';

const attachmentIdFromKey = (accountId: string, s3Key: string): string => {
  const prefix = `accounts/${encodeURIComponent(accountId)}/documents/`;
  const escapedPrefix = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`^${escapedPrefix}([0-9A-HJKMNP-TV-Z]{26})\\.(jpg|png|webp)$`).exec(s3Key);
  if (!match) {
    throw new AppError('Attachment key does not belong to this account.', 400, 'INVALID_DOCUMENT_KEY');
  }

  return match[1]!;
};

export type MaintenanceAttachmentService = {
  presign: (
    accountId: string,
    ticketId: string,
    input: { contentType: DocumentContentType; sizeBytes: number },
  ) => Promise<{ uploadUrl: string; s3Key: string; expiresIn: number }>;
  confirm: (
    accountId: string,
    ticketId: string,
    input: { s3Key: string; contentType: DocumentContentType; sizeBytes: number },
  ) => Promise<{ s3Key: string; mimeType: DocumentContentType; sizeBytes: number }>;
};

type Options = {
  repositoryFor?: (accountId: string) => MaintenanceAttachmentRepository;
  storage?: DocumentStorage;
};

export const createMaintenanceAttachmentService = ({
  repositoryFor = (accountId) => createMaintenanceAttachmentRepository({ accountId }),
  storage = createDocumentStorage(),
}: Options = {}): MaintenanceAttachmentService => ({
  async presign(accountId, ticketId, input) {
    await repositoryFor(accountId).assertTicketExists(ticketId);

    return storage.presignUpload(accountId, input.contentType, input.sizeBytes);
  },

  async confirm(accountId, ticketId, input) {
    const documentId = attachmentIdFromKey(accountId, input.s3Key);
    const repository = repositoryFor(accountId);
    await repository.assertTicketExists(ticketId);
    await storage.verifyUpload(accountId, documentId, input.s3Key, input.contentType, input.sizeBytes);

    const attachment = {
      s3Key: input.s3Key,
      mimeType: input.contentType,
      sizeBytes: input.sizeBytes,
    };
    await repository.addAttachment(ticketId, attachment);

    return attachment;
  },
});

export const maintenanceAttachmentService = createMaintenanceAttachmentService();
