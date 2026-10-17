import { z } from 'zod';

const commonJob = {
  jobId: z.string().min(1),
  accountId: z.string().min(1),
};

export const pdfJobSchema = z.discriminatedUnion('documentType', [
  z.object({ ...commonJob, documentType: z.literal('QUITTANCE'), paymentId: z.string().min(1) }),
  z.object({ ...commonJob, documentType: z.literal('LEASE'), leaseId: z.string().min(1) }),
  z.object({
    ...commonJob,
    documentType: z.literal('FICHE_POLICE'),
    leaseId: z.string().min(1),
  }),
  z.object({
    ...commonJob,
    documentType: z.literal('ETAT_DES_LIEUX'),
    leaseId: z.string().min(1),
    kind: z.enum(['entree', 'sortie']),
  }),
]);

export const reportJobSchema = z.object({
  ...commonJob,
  format: z.enum(['xlsx', 'pdf']),
  reportType: z.enum(['INCOME_STATEMENT', 'PAYMENT_REGISTER', 'LEASE_REGISTER', 'TAX_ANNUAL']),
  from: z.iso.date(),
  to: z.iso.date(),
  filters: z
    .object({
      propertyId: z.string().min(1).optional(),
      leaseId: z.string().min(1).optional(),
      status: z.array(z.string()).optional(),
    })
    .optional(),
});

export const notificationJobSchema = z.discriminatedUnion('kind', [
  z.object({
    ...commonJob,
    kind: z.literal('DOCUMENT_READY'),
    documentId: z.string().min(1),
    channel: z.enum(['email', 'whatsapp']),
  }),
  z.object({
    ...commonJob,
    kind: z.literal('REPORT_READY'),
    documentId: z.string().min(1),
    channel: z.enum(['email', 'whatsapp']),
  }),
  z.object({
    ...commonJob,
    kind: z.literal('RENT_REMINDER'),
    paymentId: z.string().min(1),
    channel: z.enum(['email', 'whatsapp']),
  }),
  z.object({
    ...commonJob,
    kind: z.literal('RENT_OVERDUE'),
    paymentId: z.string().min(1),
    channel: z.enum(['email', 'whatsapp']),
  }),
  z.object({
    ...commonJob,
    kind: z.literal('LEASE_EXPIRING'),
    leaseId: z.string().min(1),
    daysRemaining: z.number().int().nonnegative(),
    channel: z.enum(['email', 'whatsapp']),
  }),
  z.object({
    ...commonJob,
    kind: z.literal('MFA_OTP'),
    userId: z.string().min(1),
    code: z.string().min(1),
    channel: z.literal('email'),
  }),
  z.object({
    ...commonJob,
    kind: z.literal('PASSWORD_RESET'),
    userId: z.string().min(1),
    code: z.string().min(1),
    channel: z.literal('email'),
  }),
]);

export type PdfJobPayload = z.infer<typeof pdfJobSchema>;
export type ReportJobPayload = z.infer<typeof reportJobSchema>;
export type NotificationJobPayload = z.infer<typeof notificationJobSchema>;
