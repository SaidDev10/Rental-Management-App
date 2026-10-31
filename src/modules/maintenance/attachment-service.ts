import { createDocumentStorage, type DocumentStorage } from '../document/storage';
import {
  createMaintenanceAttachmentRepository,
  type MaintenanceAttachmentRepository,
} from './attachment-repository';
import type { DocumentContentType } from '../document/types';

export type MaintenanceAttachmentService = {
  presign: (
    accountId: string,
    ticketId: string,
    input: { contentType: DocumentContentType; sizeBytes: number },
  ) => Promise<{ uploadUrl: string; s3Key: string; expiresIn: number }>;
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
});

export const maintenanceAttachmentService = createMaintenanceAttachmentService();
