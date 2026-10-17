import { z } from 'zod';

const commonSchema = z.object({
  AWS_REGION: z.string().min(1),
  STAGE: z.enum(['dev', 'prod']),
  TABLE_NAME: z.string().min(1),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

const authorizerSchema = z.object({
  AWS_REGION: z.string().min(1),
  STAGE: z.enum(['dev', 'prod']),
  SSM_PARAM_PREFIX: z.string().startsWith('/'),
});

const pdfSchema = commonSchema.extend({
  DOCUMENTS_BUCKET: z.string().min(1),
  NOTIFICATION_QUEUE_URL: z.url(),
});

const reportSchema = commonSchema.extend({
  DOCUMENTS_BUCKET: z.string().min(1),
  NOTIFICATION_QUEUE_URL: z.url(),
});

const notificationSchema = commonSchema.extend({
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
