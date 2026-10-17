import { describe, expect, it, vi } from 'vitest';

import { createNotificationProcessor } from '../../src/workers/processors/notification';
import type { NotificationJobPayload } from '../../src/workers/payloads';

const payload: NotificationJobPayload = {
  jobId: 'job-1',
  accountId: 'account-1',
  kind: 'RENT_REMINDER',
  paymentId: 'payment-1',
  channel: 'email',
};

const contact = {
  email: 'tenant@example.test',
  phone: '+212600000000',
  name: 'Tenant',
  locale: 'fr' as const,
  reference: 'payment-1',
};

describe('notification processor', () => {
  it('applies the rent reminder dedupe lock before email delivery', async () => {
    const lock = {
      markSent: vi.fn(async () => undefined),
      release: vi.fn(async () => undefined),
    };
    const sendEmail = vi.fn(async () => undefined);
    const processor = createNotificationProcessor({
      getContact: vi.fn(async () => contact),
      sendEmail,
      sendWhatsApp: vi.fn(async () => undefined),
      acquireDedupe: vi.fn(async () => lock),
    });

    await processor(payload);

    expect(sendEmail).toHaveBeenCalledOnce();
    expect(lock.markSent).toHaveBeenCalledOnce();
    expect(lock.release).not.toHaveBeenCalled();
  });

  it('applies the same rent reminder dedupe lock before WhatsApp delivery', async () => {
    const lock = {
      markSent: vi.fn(async () => undefined),
      release: vi.fn(async () => undefined),
    };
    const sendWhatsApp = vi.fn(async () => undefined);
    const processor = createNotificationProcessor({
      getContact: vi.fn(async () => contact),
      sendEmail: vi.fn(async () => undefined),
      sendWhatsApp,
      acquireDedupe: vi.fn(async () => lock),
    });

    await processor({ ...payload, channel: 'whatsapp' });

    expect(sendWhatsApp).toHaveBeenCalledOnce();
    expect(lock.markSent).toHaveBeenCalledOnce();
    expect(lock.release).not.toHaveBeenCalled();
  });

  it('does not send when another worker already owns or completed the dedupe key', async () => {
    const sendEmail = vi.fn(async () => undefined);
    const processor = createNotificationProcessor({
      getContact: vi.fn(async () => contact),
      sendEmail,
      sendWhatsApp: vi.fn(async () => undefined),
      acquireDedupe: vi.fn(async () => undefined),
    });

    await processor(payload);

    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('releases a claimed reminder key when the provider fails', async () => {
    const providerError = new Error('provider unavailable');
    const lock = {
      markSent: vi.fn(async () => undefined),
      release: vi.fn(async () => undefined),
    };
    const processor = createNotificationProcessor({
      getContact: vi.fn(async () => contact),
      sendEmail: vi.fn(async () => {
        throw providerError;
      }),
      sendWhatsApp: vi.fn(async () => undefined),
      acquireDedupe: vi.fn(async () => lock),
    });

    await expect(processor(payload)).rejects.toBe(providerError);
    expect(lock.release).toHaveBeenCalledOnce();
    expect(lock.markSent).not.toHaveBeenCalled();
  });
});
