import { describe, expect, it, vi } from 'vitest';

import type { DocumentStorage } from '../../src/modules/document/storage';
import type { MaintenanceAttachmentRepository } from '../../src/modules/maintenance/attachment-repository';
import { createMaintenanceAttachmentService } from '../../src/modules/maintenance/attachment-service';

describe('maintenance attachment service', () => {
  it('checks ticket ownership within the account before delegating to the common upload rules', async () => {
    const repository = {
      assertTicketExists: vi.fn(async () => undefined),
    } as unknown as MaintenanceAttachmentRepository;
    const storage = {
      presignUpload: vi.fn(async () => ({
        uploadUrl: 'https://storage.test/upload',
        s3Key: 'accounts/account-1/documents/key.jpg',
        expiresIn: 300,
      })),
    } as unknown as DocumentStorage;
    const repositoryFor = vi.fn((accountId: string) => {
      expect(accountId).toBe('account-1');

      return repository;
    });
    const service = createMaintenanceAttachmentService({ repositoryFor, storage });

    await expect(service.presign('account-1', 'ticket-1', {
      contentType: 'image/jpeg',
      sizeBytes: 1024,
    })).resolves.toMatchObject({ expiresIn: 300 });
    expect(repository.assertTicketExists).toHaveBeenCalledWith('ticket-1');
    expect(storage.presignUpload).toHaveBeenCalledWith('account-1', 'image/jpeg', 1024);
  });

  it('does not presign when the ticket is missing from the owner account', async () => {
    const repository = {
      assertTicketExists: vi.fn(async () => {
        throw new Error('not found');
      }),
    } as unknown as MaintenanceAttachmentRepository;
    const storage = { presignUpload: vi.fn() } as unknown as DocumentStorage;
    const service = createMaintenanceAttachmentService({ repositoryFor: () => repository, storage });

    await expect(service.presign('account-2', 'foreign-ticket', {
      contentType: 'image/png',
      sizeBytes: 10,
    })).rejects.toThrow('not found');
    expect(storage.presignUpload).not.toHaveBeenCalled();
  });
});
