import { describe, expect, it } from 'vitest';

import {
  readApiConfig,
  readAuthorizerConfig,
  readNotificationWorkerConfig,
  readPdfWorkerConfig,
  readReportWorkerConfig,
  readStreamWorkerConfig,
} from '../../src/shared/config';

const commonEnv = {
  AWS_REGION: 'eu-west-1',
  STAGE: 'dev',
  TABLE_NAME: 'rental-app-test',
  LOG_LEVEL: 'debug',
  SSM_PARAM_PREFIX: '/rental-app/test',
};

const workerEnv = {
  ...commonEnv,
  DOCUMENTS_BUCKET: 'documents-test',
  PDF_QUEUE_URL: 'http://localhost:4566/000000000000/pdf',
  REPORT_QUEUE_URL: 'http://localhost:4566/000000000000/reports',
  NOTIFICATION_QUEUE_URL: 'http://localhost:4566/000000000000/notifications',
  SES_FROM_ADDRESS: 'no-reply@example.test',
  SES_CONFIG_SET: 'test',
  SSM_PARAM_PREFIX: '/rental-app/test',
};

describe('application configuration', () => {
  it('parses required API settings and splits allowed origins', () => {
    const config = readApiConfig({
      ...workerEnv,
      PHOTOS_BUCKET: 'photos-test',
      ALLOWED_ORIGINS: 'https://app.example.test, http://localhost:5173',
    });

    expect(config.ALLOWED_ORIGINS).toEqual([
      'https://app.example.test',
      'http://localhost:5173',
    ]);
    expect(config.LOG_LEVEL).toBe('debug');
  });

  it('rejects missing API queue configuration', () => {
    expect(() =>
      readApiConfig({
        ...workerEnv,
        PHOTOS_BUCKET: 'photos-test',
        ALLOWED_ORIGINS: 'http://localhost:5173',
        PDF_QUEUE_URL: undefined,
      }),
    ).toThrow();
  });

  it('validates the authorizer configuration', () => {
    expect(readAuthorizerConfig(commonEnv)).toMatchObject({
      AWS_REGION: 'eu-west-1',
      STAGE: 'dev',
      SSM_PARAM_PREFIX: '/rental-app/test',
    });
  });

  it('validates the PDF worker configuration', () => {
    expect(readPdfWorkerConfig(workerEnv)).toMatchObject({
      DOCUMENTS_BUCKET: 'documents-test',
      PDF_QUEUE_URL: 'http://localhost:4566/000000000000/pdf',
      NOTIFICATION_QUEUE_URL: 'http://localhost:4566/000000000000/notifications',
    });
  });

  it('validates the report worker configuration', () => {
    expect(readReportWorkerConfig(workerEnv)).toMatchObject({
      DOCUMENTS_BUCKET: 'documents-test',
      REPORT_QUEUE_URL: 'http://localhost:4566/000000000000/reports',
      NOTIFICATION_QUEUE_URL: 'http://localhost:4566/000000000000/notifications',
    });
  });

  it('validates the notification worker configuration and defaults its monthly cap', () => {
    const config = readNotificationWorkerConfig(workerEnv);

    expect(config.TWILIO_MONTHLY_CAP).toBe(500);
    expect(config.SES_FROM_ADDRESS).toBe('no-reply@example.test');
  });

  it('validates the stream worker configuration', () => {
    expect(readStreamWorkerConfig(commonEnv)).toMatchObject({
      AWS_REGION: 'eu-west-1',
      TABLE_NAME: 'rental-app-test',
    });
  });
});
