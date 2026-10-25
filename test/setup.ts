import { generateKeyPairSync } from 'node:crypto';

process.env.AWS_REGION ??= 'eu-west-1';
process.env.STAGE ??= 'dev';
process.env.TABLE_NAME ??= 'rental-app-test';
process.env.USE_DYNAMO_AUTH ??= 'false';
process.env.DOCUMENTS_BUCKET ??= 'rental-app-documents-test';
process.env.PHOTOS_BUCKET ??= 'rental-app-photos-test';
process.env.PDF_QUEUE_URL ??= 'https://sqs.eu-west-1.amazonaws.com/000000000000/pdf';
process.env.REPORT_QUEUE_URL ??= 'https://sqs.eu-west-1.amazonaws.com/000000000000/reports';
process.env.NOTIFICATION_QUEUE_URL ??= 'https://sqs.eu-west-1.amazonaws.com/000000000000/notifications';
process.env.ALLOWED_ORIGINS ??= 'http://localhost:5173';
process.env.SES_FROM_ADDRESS ??= 'no-reply@example.test';
process.env.SES_CONFIG_SET ??= 'test';
process.env.SSM_PARAM_PREFIX ??= '/rental-app/test';

if (!process.env.JWT_PRIVATE_KEY || !process.env.JWT_PUBLIC_KEY) {
  const keys = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  process.env.JWT_PRIVATE_KEY = keys.privateKey;
  process.env.JWT_PUBLIC_KEY = keys.publicKey;
}
