import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

import { AppError } from '../../src/shared/errors';
import type { AuthEnv } from '../../src/modules/auth/types';
import { createDocumentRoutes } from '../../src/modules/document/routes';
import type { DocumentService } from '../../src/modules/document/service';

const metadata = {
  id: 'doc-1',
  accountId: 'account-1',
  documentType: 'lease' as const,
  s3Bucket: 'documents-test',
  s3Key: 'accounts/account-1/documents/01JABCDEF0123456789ABCDEFG.jpg',
  mimeType: 'image/jpeg' as const,
  sizeBytes: 100,
  checksumSha256: null,
  linkedEntityType: 'Lease' as const,
  linkedEntityId: 'lease-1',
  generatedBy: 'upload' as const,
  retentionClass: 'standard' as const,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const routeApp = (service: DocumentService, role: 'owner' | 'super_admin' = 'owner') => {
  const app = new Hono<AuthEnv>();
  app.use('*', async (c, next) => {
    c.set('accountId', 'account-1');
    c.set('userId', 'user-1');
    c.set('role', role);
    c.set('email', 'owner@example.test');
    c.set('sessionId', 'session-1');
    await next();
  });

  app.route('/documents', createDocumentRoutes({ service }));
  app.onError((error, c) => c.json({ error: error.message }, (error instanceof AppError ? error.status : 500) as 400 | 401 | 403 | 404 | 409 | 500));

  return app;
};

describe('document routes', () => {
  it('provides metadata, download links, and account-scoped upload flows for owner callers', async () => {
    const service = {
      list: vi.fn(async () => ({ items: [metadata] })),
      get: vi.fn(async () => metadata),
      presign: vi.fn(async () => ({ uploadUrl: 'https://storage.test/upload', s3Key: metadata.s3Key, expiresIn: 300 })),
      confirm: vi.fn(async () => metadata),
      downloadUrl: vi.fn(async () => ({ url: 'https://storage.test/download', expiresIn: 300 })),
      delete: vi.fn(async () => undefined),
    } as unknown as DocumentService;
    const app = routeApp(service);

    const listed = await app.request('/documents?linkedEntityType=Lease&linkedEntityId=lease-1');
    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject({ data: [{ id: 'doc-1' }] });
    expect(service.list).toHaveBeenCalledWith('account-1', expect.objectContaining({ linkedEntityType: 'Lease', linkedEntityId: 'lease-1' }));

    const detail = await app.request('/documents/doc-1');
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({ data: { id: 'doc-1' } });

    const download = await app.request('/documents/doc-1/download-url');
    expect(download.status).toBe(200);
    expect(await download.json()).toEqual({ url: 'https://storage.test/download', expiresIn: 300 });

    const uploadInput = {
      documentType: 'lease',
      linkedEntityType: 'Lease',
      linkedEntityId: 'lease-1',
      contentType: 'image/jpeg',
      sizeBytes: 100,
    };
    const presign = await app.request('/documents/presign', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(uploadInput),
    });
    expect(presign.status).toBe(200);
    expect(service.presign).toHaveBeenCalledWith('account-1', uploadInput);

    const confirmInput = { ...uploadInput, s3Key: metadata.s3Key };
    const confirmed = await app.request('/documents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(confirmInput),
    });
    expect(confirmed.status).toBe(201);
    expect(service.confirm).toHaveBeenCalledWith('account-1', confirmInput);

    const deleted = await app.request('/documents/doc-1', { method: 'DELETE' });
    expect(deleted.status).toBe(204);
    expect(service.delete).toHaveBeenCalledWith('account-1', 'doc-1');
  });

  it('rejects unauthenticated-account context, non-owner role, and malformed file uploads', async () => {
    const service = {
      list: vi.fn(),
      get: vi.fn(),
      presign: vi.fn(),
      confirm: vi.fn(),
      downloadUrl: vi.fn(),
      delete: vi.fn(),
    } as unknown as DocumentService;
    const adminResponse = await routeApp(service, 'super_admin').request('/documents');
    expect(adminResponse.status).toBe(403);

    const app = routeApp(service);
    const invalid = await app.request('/documents/presign', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        documentType: 'lease',
        linkedEntityType: 'Lease',
        linkedEntityId: 'lease-1',
        contentType: 'application/pdf',
        sizeBytes: 1024,
      }),
    });
    expect(invalid.status).toBe(400);
    expect(service.presign).not.toHaveBeenCalled();
  });
});
