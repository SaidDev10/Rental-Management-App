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

  it('verifies and persists the confirmed account-scoped object on its ticket', async () => {
    const attachment = {
      s3Key: 'accounts/account-1/documents/01JABCDEF0123456789ABCDEFG.jpg',
      mimeType: 'image/jpeg',
      sizeBytes: 123,
    };
    const repository = {
      assertTicketExists: vi.fn(async () => undefined),
      addAttachment: vi.fn(async () => undefined),
    } as unknown as MaintenanceAttachmentRepository;
    const storage = {
      verifyUpload: vi.fn(async () => undefined),
    } as unknown as DocumentStorage;
    const service = createMaintenanceAttachmentService({
      repositoryFor: vi.fn((accountId) => {
        expect(accountId).toBe('account-1');

        return repository;
      }),
      storage,
    });

    await expect(service.confirm('account-1', 'ticket-1', {
      s3Key: attachment.s3Key,
      contentType: 'image/jpeg',
      sizeBytes: 123,
    })).resolves.toEqual(attachment);
    expect(repository.assertTicketExists).toHaveBeenCalledWith('ticket-1');
    expect(storage.verifyUpload).toHaveBeenCalledWith(
      'account-1',
      '01JABCDEF0123456789ABCDEFG',
      attachment.s3Key,
      'image/jpeg',
      123,
    );
    expect(repository.addAttachment).toHaveBeenCalledWith('ticket-1', attachment);
  });

  it('rejects foreign-account keys and does not persist failed or mismatched storage objects', async () => {
    const repository = {
      assertTicketExists: vi.fn(async () => undefined),
      addAttachment: vi.fn(async () => undefined),
    } as unknown as MaintenanceAttachmentRepository;
    const storage = {
      verifyUpload: vi.fn(async () => {
        throw new Error('INVALID_DOCUMENT_UPLOAD');
      }),
    } as unknown as DocumentStorage;
    const service = createMaintenanceAttachmentService({ repositoryFor: () => repository, storage });

    await expect(service.confirm('account-1', 'ticket-1', {
      s3Key: 'accounts/account-2/documents/01JABCDEF0123456789ABCDEFG.jpg',
      contentType: 'image/jpeg',
      sizeBytes: 123,
    })).rejects.toMatchObject({ code: 'INVALID_DOCUMENT_KEY' });
    await expect(service.confirm('account-1', 'ticket-1', {
      s3Key: 'accounts/account-1/documents/01JABCDEF0123456789ABCDEFG.jpg',
      contentType: 'image/jpeg',
      sizeBytes: 123,
    })).rejects.toThrow('INVALID_DOCUMENT_UPLOAD');
    expect(storage.verifyUpload).toHaveBeenCalledTimes(1);
    expect(repository.addAttachment).not.toHaveBeenCalled();
  });

  it('does not verify an upload for a ticket outside the authenticated account', async () => {
    const repository = {
      assertTicketExists: vi.fn(async () => {
        throw new Error('MAINTENANCE_TICKET_NOT_FOUND');
      }),
      addAttachment: vi.fn(),
    } as unknown as MaintenanceAttachmentRepository;
    const storage = { verifyUpload: vi.fn() } as unknown as DocumentStorage;
    const service = createMaintenanceAttachmentService({ repositoryFor: () => repository, storage });

    await expect(service.confirm('account-2', 'foreign-ticket', {
      s3Key: 'accounts/account-2/documents/01JABCDEF0123456789ABCDEFG.jpg',
      contentType: 'image/jpeg',
      sizeBytes: 123,
    })).rejects.toThrow('MAINTENANCE_TICKET_NOT_FOUND');
    expect(storage.verifyUpload).not.toHaveBeenCalled();
    expect(repository.addAttachment).not.toHaveBeenCalled();
  });
});
