import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

import { createPropertyRoutes } from '../../src/modules/property/routes';
import type { AuthEnv } from '../../src/modules/auth/types';
import type { PropertyPhotoStorage } from '../../src/modules/property/photo-storage';
import { propertyService } from '../../src/modules/property/service';

const accountId = 'property-photo-route-account';
const propertyInput = {
  label: 'Photo test property',
  address: { line1: '1 Photo Road', city: 'Rabat', country: 'MA' as const },
  propertyType: 'apartment' as const,
  areaSqm: null,
  rooms: null,
  purchaseDate: null,
  purchasePrice: null,
  notes: null,
  status: 'active' as const,
};

const createPhotoApp = (photoStorage: PropertyPhotoStorage) => {
  const app = new Hono<AuthEnv>();
  app.use('*', async (c, next) => {
    c.set('accountId', accountId);
    c.set('userId', 'owner-1');
    c.set('role', 'owner');
    c.set('email', 'owner@example.test');
    c.set('sessionId', 'session-1');
    await next();
  });
  app.route('/properties', createPropertyRoutes({ photoStorage }));

  return app;
};

describe('property photo routes', () => {
  it('returns detail data with an active lease id and presigned photo upload data', async () => {
    const property = await propertyService.create(accountId, propertyInput, 'create-photo-route-test');
    const photoStorage: PropertyPhotoStorage = {
      presignUpload: vi.fn(async () => ({
        uploadUrl: 'https://photos.example.test/upload',
        s3Key: 'accounts/property-photo-route-account/properties/property-1/01JEXAMPLE00000000000000000.jpg',
        expiresIn: 300,
      })),
      verifyUpload: vi.fn(async () => undefined),
    };
    const app = createPhotoApp(photoStorage);

    const detailResponse = await app.request(`/properties/${property.id}`);
    expect(detailResponse.status).toBe(200);
    expect(await detailResponse.json()).toMatchObject({
      data: { id: property.id, activeLeaseId: null },
    });

    const presignResponse = await app.request(`/properties/${property.id}/photos/presign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contentType: 'image/jpeg', sizeBytes: 1024 }),
    });
    expect(presignResponse.status).toBe(200);
    expect(await presignResponse.json()).toMatchObject({
      data: {
        uploadUrl: 'https://photos.example.test/upload',
        expiresIn: 300,
      },
    });
    expect(photoStorage.presignUpload).toHaveBeenCalledWith(accountId, property.id, 'image/jpeg', 1024);
  });

  it('verifies uploaded objects before recording them and rejects oversized requests', async () => {
    const property = await propertyService.create(accountId, propertyInput, 'record-photo-route-test');
    const s3Key = `accounts/${accountId}/properties/${property.id}/01JEXAMPLE00000000000000000.png`;
    const photoStorage: PropertyPhotoStorage = {
      presignUpload: vi.fn(async () => ({
        uploadUrl: 'https://photos.example.test/upload',
        s3Key,
        expiresIn: 300,
      })),
      verifyUpload: vi.fn(async () => undefined),
    };
    const app = createPhotoApp(photoStorage);

    const invalidPresignResponse = await app.request(`/properties/${property.id}/photos/presign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contentType: 'image/jpeg', sizeBytes: 10 * 1024 * 1024 + 1 }),
    });
    expect(invalidPresignResponse.status).toBe(400);
    expect(photoStorage.presignUpload).not.toHaveBeenCalled();

    const recordResponse = await app.request(`/properties/${property.id}/photos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ s3Key }),
    });
    expect(recordResponse.status).toBe(200);
    expect(recordResponse.headers.get('ETag')).toBe('2');
    expect(await recordResponse.json()).toMatchObject({
      data: { id: property.id, photoKeys: [s3Key] },
    });
    expect(photoStorage.verifyUpload).toHaveBeenCalledWith(accountId, property.id, s3Key);
  });

  it('does not accept caller-supplied photo keys through property CRUD', async () => {
    const photoStorage: PropertyPhotoStorage = {
      presignUpload: vi.fn(),
      verifyUpload: vi.fn(),
    };
    const app = createPhotoApp(photoStorage);
    const response = await app.request('/properties', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'caller-supplied-photo-key',
      },
      body: JSON.stringify({ ...propertyInput, photoKeys: ['unverified/key'] }),
    });

    expect(response.status).toBe(400);
  });
});
