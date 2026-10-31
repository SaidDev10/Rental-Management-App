import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

import type { AuthEnv } from '../../src/modules/auth/types';
import { createMaintenanceAttachmentRoutes } from '../../src/modules/maintenance/attachment-routes';
import type { MaintenanceAttachmentService } from '../../src/modules/maintenance/attachment-service';
import { AppError } from '../../src/shared/errors';

const createApp = (service: MaintenanceAttachmentService, role: 'owner' | 'super_admin' = 'owner') => {
  const app = new Hono<AuthEnv>();
  app.use('*', async (c, next) => {
    c.set('accountId', 'claim-account');
    c.set('userId', 'owner-1');
    c.set('role', role);
    c.set('email', 'owner@example.test');
    c.set('sessionId', 'session-1');
    await next();
  });
  app.route('/maintenance/tickets', createMaintenanceAttachmentRoutes({ service }));
  app.onError((error, c) => {
    const appError = error instanceof AppError ? error : new AppError('Internal error', 500, 'INTERNAL_ERROR');

    return c.json({ error: { code: appError.code } }, appError.status as 400 | 401 | 403 | 404 | 409 | 500);
  });

  return app;
};

describe('maintenance attachment routes', () => {
  it('uses the owner claim, ticket path, and validated image data to create a presigned upload', async () => {
    const service = {
      presign: vi.fn(async () => ({
        uploadUrl: 'https://storage.example.test/upload',
        s3Key: 'accounts/claim-account/documents/01JABCDEF0123456789ABCDEFG.jpg',
        expiresIn: 300,
      })),
    } as unknown as MaintenanceAttachmentService;
    const response = await createApp(service).request('/maintenance/tickets/ticket-1/attachments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contentType: 'image/jpeg', sizeBytes: 1024 }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: { uploadUrl: 'https://storage.example.test/upload', expiresIn: 300 },
    });
    expect(service.presign).toHaveBeenCalledWith('claim-account', 'ticket-1', {
      contentType: 'image/jpeg',
      sizeBytes: 1024,
    });
  });

  it('rejects non-owner role and invalid attachment content before presigning', async () => {
    const service = { presign: vi.fn() } as unknown as MaintenanceAttachmentService;
    const adminResponse = await createApp(service, 'super_admin').request(
      '/maintenance/tickets/ticket-1/attachments',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contentType: 'image/jpeg', sizeBytes: 1024 }),
      },
    );
    expect(adminResponse.status).toBe(403);

    const invalidResponse = await createApp(service).request(
      '/maintenance/tickets/ticket-1/attachments',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contentType: 'application/pdf', sizeBytes: 10 * 1024 * 1024 + 1 }),
      },
    );
    expect(invalidResponse.status).toBe(400);
    expect(service.presign).not.toHaveBeenCalled();
  });

  it('confirms an uploaded attachment using the owner claim and rejects malformed or oversized data', async () => {
    const service = {
      presign: vi.fn(),
      confirm: vi.fn(async (_accountId, _ticketId, input) => ({
        s3Key: input.s3Key,
        mimeType: input.contentType,
        sizeBytes: input.sizeBytes,
      })),
    } as unknown as MaintenanceAttachmentService;
    const app = createApp(service);
    const response = await app.request('/maintenance/tickets/ticket-1/attachments/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        s3Key: 'accounts/claim-account/documents/01JABCDEF0123456789ABCDEFG.jpg',
        contentType: 'image/jpeg',
        sizeBytes: 1024,
      }),
    });

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      data: {
        s3Key: 'accounts/claim-account/documents/01JABCDEF0123456789ABCDEFG.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: 1024,
      },
    });
    expect(service.confirm).toHaveBeenCalledWith('claim-account', 'ticket-1', {
      s3Key: 'accounts/claim-account/documents/01JABCDEF0123456789ABCDEFG.jpg',
      contentType: 'image/jpeg',
      sizeBytes: 1024,
    });

    const forbiddenResponse = await createApp(service, 'super_admin').request(
      '/maintenance/tickets/ticket-1/attachments/confirm',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          s3Key: 'accounts/claim-account/documents/01JABCDEF0123456789ABCDEFG.jpg',
          contentType: 'image/jpeg',
          sizeBytes: 1024,
        }),
      },
    );
    const oversizedResponse = await app.request('/maintenance/tickets/ticket-1/attachments/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        s3Key: 'accounts/claim-account/documents/01JABCDEF0123456789ABCDEFG.jpg',
        contentType: 'image/jpeg',
        sizeBytes: 10 * 1024 * 1024 + 1,
      }),
    });
    const malformedResponse = await app.request('/maintenance/tickets/ticket-1/attachments/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        s3Key: 'accounts/claim-account/documents/01JABCDEF0123456789ABCDEFG.jpg',
        contentType: 'image/jpeg',
        sizeBytes: 0,
        unexpected: true,
      }),
    });
    expect(forbiddenResponse.status).toBe(403);
    expect(oversizedResponse.status).toBe(400);
    expect(malformedResponse.status).toBe(400);
    expect(service.confirm).toHaveBeenCalledTimes(1);
  });
});
