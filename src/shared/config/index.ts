import { z } from 'zod';

const commonSchema = z.object({
  AWS_REGION: z.string().min(1),
  STAGE: z.enum(['dev', 'prod']),
  TABLE_NAME: z.string().min(1),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

const apiSchema = commonSchema.extend({
  DOCUMENTS_BUCKET: z.string().min(1),
  PHOTOS_BUCKET: z.string().min(1),
  PDF_QUEUE_URL: z.url(),
  REPORT_QUEUE_URL: z.url(),
  NOTIFICATION_QUEUE_URL: z.url(),
  SSM_PARAM_PREFIX: z.string().startsWith('/'),
  ALLOWED_ORIGINS: z
    .string()
    .min(1)
    .transform((value) => value.split(',').map((origin) => origin.trim()))
    .pipe(z.array(z.url()).min(1)),
  SENTRY_DSN: z.url().optional(),
});

const authorizerSchema = z.object({
  AWS_REGION: z.string().min(1),
  STAGE: z.enum(['dev', 'prod']),
  SSM_PARAM_PREFIX: z.string().startsWith('/'),
});

const pdfSchema = commonSchema.extend({
  DOCUMENTS_BUCKET: z.string().min(1),
  PDF_QUEUE_URL: z.url(),
  NOTIFICATION_QUEUE_URL: z.url(),
});

const reportSchema = commonSchema.extend({
  DOCUMENTS_BUCKET: z.string().min(1),
  REPORT_QUEUE_URL: z.url(),
  NOTIFICATION_QUEUE_URL: z.url(),
});

const notificationSchema = commonSchema.extend({
  NOTIFICATION_QUEUE_URL: z.url(),
  SES_FROM_ADDRESS: z.email(),
  SES_CONFIG_SET: z.string().min(1),
  SSM_PARAM_PREFIX: z.string().startsWith('/'),
  TWILIO_MONTHLY_CAP: z.coerce.number().int().positive().default(500),
});

const streamSchema = commonSchema;

export type PdfWorkerConfig = z.infer<typeof pdfSchema>;
export type ReportWorkerConfig = z.infer<typeof reportSchema>;
export type NotificationWorkerConfig = z.infer<typeof notificationSchema>;
export type StreamWorkerConfig = z.infer<typeof streamSchema>;
export type AuthorizerConfig = z.infer<typeof authorizerSchema>;
export type ApiConfig = z.infer<typeof apiSchema>;

export const readApiConfig = (env: NodeJS.ProcessEnv = process.env): ApiConfig => {
  return apiSchema.parse(env);
};

export const readAuthorizerConfig = (env: NodeJS.ProcessEnv = process.env): AuthorizerConfig => {
  return authorizerSchema.parse(env);
};

export const readPdfWorkerConfig = (env: NodeJS.ProcessEnv = process.env): PdfWorkerConfig => {
  return pdfSchema.parse(env);
};

export const readReportWorkerConfig = (env: NodeJS.ProcessEnv = process.env): ReportWorkerConfig => {
  return reportSchema.parse(env);
};

export const readNotificationWorkerConfig = (
  env: NodeJS.ProcessEnv = process.env,
): NotificationWorkerConfig => {
  return notificationSchema.parse(env);
};

export const readStreamWorkerConfig = (env: NodeJS.ProcessEnv = process.env): StreamWorkerConfig => {
  return streamSchema.parse(env);
};
