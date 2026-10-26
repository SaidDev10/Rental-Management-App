import { describe, expect, it } from 'vitest';

import { createFieldCrypto } from '../../src/shared/crypto/field-crypto';

const key = Buffer.alloc(32, 42).toString('base64');

describe('field encryption', () => {
  it('encrypts with the versioned AES-GCM format and decrypts to the original value', () => {
    const crypto = createFieldCrypto(key);
    const encrypted = crypto.encrypt('AB123456');

    expect(encrypted).toMatch(/^v1:[A-Za-z0-9+/]+=*:[A-Za-z0-9+/]+=*:[A-Za-z0-9+/]+=*$/);
    expect(encrypted).not.toContain('AB123456');
    expect(crypto.decrypt(encrypted)).toBe('AB123456');
  });

  it('rejects invalid keys, malformed ciphertext, and tampering', () => {
    expect(() => createFieldCrypto('not-a-key')).toThrow(/256-bit key/);

    const crypto = createFieldCrypto(key);
    const encrypted = crypto.encrypt('sensitive');
    const pieces = encrypted.split(':');
    pieces[2] = Buffer.from('tampered').toString('base64');

    expect(() => crypto.decrypt('bad-format')).toThrow(/invalid format/);
    expect(() => crypto.decrypt(pieces.join(':'))).toThrow();
  });
});