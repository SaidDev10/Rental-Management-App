import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

const decodeKey = (encodedKey: string): Buffer => {
  const key = Buffer.from(encodedKey, 'base64');
  if (key.length !== KEY_BYTES || key.toString('base64') !== encodedKey) {
    throw new Error('Field encryption key must be a base64-encoded 256-bit key.');
  }

  return key;
};

export const createFieldCrypto = (encodedKey: string) => {
  const key = decodeKey(encodedKey);

  return {
    encrypt(value: string): string {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();

      return `v1:${iv.toString('base64')}:${ciphertext.toString('base64')}:${tag.toString('base64')}`;
    },

    decrypt(value: string): string {
      const [version, encodedIv, encodedCiphertext, encodedTag, ...extra] = value.split(':');
      if (version !== 'v1' || !encodedIv || encodedCiphertext === undefined || !encodedTag || extra.length > 0) {
        throw new Error('Encrypted field has an invalid format.');
      }

      const iv = Buffer.from(encodedIv, 'base64');
      const ciphertext = Buffer.from(encodedCiphertext, 'base64');
      const tag = Buffer.from(encodedTag, 'base64');
      if (
        iv.length !== IV_BYTES ||
        tag.length !== TAG_BYTES ||
        iv.toString('base64') !== encodedIv ||
        ciphertext.toString('base64') !== encodedCiphertext ||
        tag.toString('base64') !== encodedTag
      ) {
        throw new Error('Encrypted field has invalid base64 data.');
      }

      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);

      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    },
  };
};