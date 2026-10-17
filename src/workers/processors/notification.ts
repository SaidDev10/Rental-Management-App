import { GetObjectCommand } from '@aws-sdk/client-s3';
import { randomUUID } from 'node:crypto';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import { SendEmailCommand } from '@aws-sdk/client-sesv2';
import { DeleteCommand, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import twilio from 'twilio';

import { getDynamoDocumentClient, getS3Client, getSesClient } from '../../shared/aws/clients';
import { getSecret } from '../../shared/config/secrets';
import { readNotificationWorkerConfig } from '../../shared/config';
import { pk, sk } from '../../shared/db/keys';
import { getWorkerData } from '../../shared/db/worker-data';
import { baseLogger } from '../../shared/logger';
import type { NotificationJobPayload } from '../payloads';
import { NonRetryableWorkerError } from '../job-processor';

type Contact = {
  email?: string;
  phone?: string;
  name: string;
  locale: 'fr' | 'en';
  reference: string;
  documentUrl?: string;
};

type NotificationDependencies = {
  sendEmail: (input: { to: string; locale: 'fr' | 'en'; payload: NotificationJobPayload; contact: Contact }) => Promise<void>;
  sendWhatsApp: (input: { to: string; payload: NotificationJobPayload; contact: Contact }) => Promise<void>;
  getContact: (payload: NotificationJobPayload) => Promise<Contact>;
  acquireDedupe?: (payload: NotificationJobPayload) => Promise<NotificationDedupeLock | undefined>;
};

type NotificationDedupeLock = {
  markSent: () => Promise<void>;
  release: () => Promise<void>;
};

const text = (value: unknown): string => {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
};

const resolveContact = async (payload: NotificationJobPayload): Promise<Contact> => {
  const data = getWorkerData(payload.accountId);
  const account = await data.get(sk.meta());

  if (!account) {
    throw new NonRetryableWorkerError('ACCOUNT_NOT_FOUND', 'Account record was not found.');
  }

  const locale = account.locale === 'en' ? 'en' : 'fr';

  if (payload.kind === 'MFA_OTP' || payload.kind === 'PASSWORD_RESET') {
    const user = await data.get(sk.user(payload.userId));

    if (!user || typeof user.email !== 'string') {
      throw new NonRetryableWorkerError('USER_CONTACT_NOT_FOUND', 'User email address was not found.');
    }

    return {
      email: user.email,
      name: text(user.name) || text(user.email),
      locale,
      reference: payload.userId,
    };
  }

  if (payload.kind === 'RENT_REMINDER' || payload.kind === 'RENT_OVERDUE') {
    const payment = await data.get(sk.payment(payload.paymentId));

    if (!payment || typeof payment.tenantId !== 'string') {
      throw new NonRetryableWorkerError('PAYMENT_CONTACT_NOT_FOUND', 'Payment tenant was not found.');
    }

    const tenant = await data.get(sk.tenant(payment.tenantId));

    if (!tenant) {
      throw new NonRetryableWorkerError('TENANT_NOT_FOUND', 'Tenant record was not found.');
    }

    return {
      ...(typeof tenant.email === 'string' ? { email: tenant.email } : {}),
      ...(typeof tenant.phone === 'string' ? { phone: tenant.phone } : {}),
      name: `${text(tenant.firstName)} ${text(tenant.lastName)}`.trim(),
      locale,
      reference: payload.paymentId,
    };
  }

  if (payload.kind === 'LEASE_EXPIRING') {
    const lease = await data.get(sk.lease(payload.leaseId));

    if (!lease) {
      throw new NonRetryableWorkerError('LEASE_NOT_FOUND', 'Lease record was not found.');
    }

    return {
      ...(typeof account.ownerEmail === 'string' ? { email: account.ownerEmail } : {}),
      ...(typeof account.phone === 'string' ? { phone: account.phone } : {}),
      name: text(account.ownerName) || text(account.name),
      locale,
      reference: payload.leaseId,
    };
  }

  const document = await data.get(sk.document(payload.documentId));

  if (!document) {
    throw new Error('Generated document metadata is not available yet.');
  }

  if (typeof document.s3Bucket !== 'string' || typeof document.s3Key !== 'string') {
    throw new NonRetryableWorkerError(
      'DOCUMENT_METADATA_INVALID',
      'Generated document storage metadata is invalid.',
    );
  }

  return {
    ...(typeof account.ownerEmail === 'string' ? { email: account.ownerEmail } : {}),
    ...(typeof account.phone === 'string' ? { phone: account.phone } : {}),
    name: text(account.ownerName) || text(account.name),
    locale,
    reference: payload.documentId,
    documentUrl: await getSignedUrl(
      getS3Client(),
      new GetObjectCommand({ Bucket: document.s3Bucket, Key: document.s3Key }),
      { expiresIn: 3600 },
    ),
  };
};

const templateName = (payload: NotificationJobPayload, locale: 'fr' | 'en'): string => {
  const normalizedKind = payload.kind.toLowerCase().replaceAll('_', '-');

  return `rental-app-${normalizedKind}-${locale}`;
};

const notificationTemplateData = (
  payload: NotificationJobPayload,
  contact: Contact,
): Record<string, string> => {
  return {
    firstName: contact.name,
    reference: contact.reference,
    ...(payload.kind === 'LEASE_EXPIRING'
      ? { daysRemaining: String(payload.daysRemaining) }
      : {}),
    ...(contact.documentUrl === undefined ? {} : { documentUrl: contact.documentUrl }),
  };
};

const sendEmail = async ({
  to,
  locale,
  payload,
  contact,
}: {
  to: string;
  locale: 'fr' | 'en';
  payload: NotificationJobPayload;
  contact: Contact;
}): Promise<void> => {
  const config = readNotificationWorkerConfig();
  const isOtp = payload.kind === 'MFA_OTP' || payload.kind === 'PASSWORD_RESET';
  const content = isOtp
    ? {
        Simple: {
          Subject: {
            Data: payload.kind === 'MFA_OTP' ? 'Your verification code' : 'Password reset code',
            Charset: 'UTF-8',
          },
          Body: {
            Text: {
              Data: `Your code is ${payload.code}. It expires shortly. Do not share it with anyone.`,
              Charset: 'UTF-8',
            },
          },
        },
      }
    : {
        Template: {
          TemplateName: templateName(payload, locale),
          TemplateData: JSON.stringify(notificationTemplateData(payload, contact)),
        },
      };

  try {
    await getSesClient().send(
      new SendEmailCommand({
        FromEmailAddress: `Rental App <${config.SES_FROM_ADDRESS}>`,
        Destination: { ToAddresses: [to] },
        ConfigurationSetName: config.SES_CONFIG_SET,
        Content: content,
      }),
    );
  } catch (error) {
    const failure = error as { name?: string; $metadata?: { httpStatusCode?: number } };

    if (
      failure.name === 'MessageRejected' ||
      (failure.$metadata?.httpStatusCode !== undefined &&
        failure.$metadata.httpStatusCode >= 400 &&
        failure.$metadata.httpStatusCode < 500 &&
        failure.$metadata.httpStatusCode !== 429)
    ) {
      throw new NonRetryableWorkerError('EMAIL_REJECTED', 'Email provider rejected the recipient.');
    }

    throw error;
  }
};

const sendWhatsApp = async ({
  to,
  payload,
  contact,
}: {
  to: string;
  payload: NotificationJobPayload;
  contact: Contact;
}): Promise<void> => {
  const config = readNotificationWorkerConfig();
  const month = new Date().toISOString().slice(0, 7);
  const counterResult = await getDynamoDocumentClient().send(
    new UpdateCommand({
      TableName: config.TABLE_NAME,
      Key: {
        PK: pk.account(payload.accountId),
        SK: sk.counterWhatsapp(month),
      },
      UpdateExpression: 'SET #accountId = :accountId, #updatedAt = :now ADD #sentCount :one',
      ExpressionAttributeNames: {
        '#accountId': 'accountId',
        '#sentCount': 'sentCount',
        '#updatedAt': 'updatedAt',
      },
      ExpressionAttributeValues: {
        ':accountId': payload.accountId,
        ':now': new Date().toISOString(),
        ':one': 1,
      },
      ReturnValues: 'UPDATED_NEW',
    }),
  );
  const sentCount = counterResult.Attributes?.sentCount;

  if (typeof sentCount !== 'number') {
    throw new Error('WhatsApp message counter did not return an updated count.');
  }

  if (sentCount > config.TWILIO_MONTHLY_CAP) {
    if (!contact.email) {
      throw new NonRetryableWorkerError(
        'WHATSAPP_CAP_NO_EMAIL',
        'WhatsApp message limit reached and no email fallback is available.',
      );
    }

    baseLogger.warn({ month, accountId: payload.accountId, sentCount }, 'WhatsApp cap reached; using email fallback');
    await sendEmail({ to: contact.email, locale: contact.locale, payload, contact });

    return;
  }

  const prefix = config.SSM_PARAM_PREFIX;
  const [accountSid, authToken, from, contentSid] = await Promise.all([
    getSecret(`${prefix}/twilio/account-sid`),
    getSecret(`${prefix}/twilio/auth-token`),
    getSecret(`${prefix}/twilio/whatsapp-from`),
    getSecret(`${prefix}/twilio/templates/${payload.kind.toLowerCase().replaceAll('_', '-')}`),
  ]);
  const client = twilio(accountSid, authToken);

  try {
    await client.messages.create({
      from: `whatsapp:${from}`,
      to: `whatsapp:${to}`,
      contentSid,
      contentVariables: JSON.stringify({
        '1': contact.name,
        '2': contact.reference,
        '3': payload.kind === 'LEASE_EXPIRING' ? String(payload.daysRemaining) : '',
        '4': contact.documentUrl ?? '',
      }),
    });
  } catch (error) {
    const failure = error as { status?: number };

    if (
      failure.status !== undefined &&
      failure.status >= 400 &&
      failure.status < 500 &&
      failure.status !== 429
    ) {
      throw new NonRetryableWorkerError('WHATSAPP_REJECTED', 'WhatsApp provider rejected the message.');
    }

    throw error;
  }
};

const acquireNotificationDedupe = async (
  payload: NotificationJobPayload,
): Promise<NotificationDedupeLock | undefined> => {
  if (payload.kind !== 'RENT_REMINDER' && payload.kind !== 'RENT_OVERDUE') {
    return {
      markSent: async () => undefined,
      release: async () => undefined,
    };
  }

  const config = readNotificationWorkerConfig();
  const month = new Date().toISOString().slice(0, 7);
  const dedupeKey = `${payload.kind}:${encodeURIComponent(payload.paymentId)}:${month}`;
  const key = {
    PK: pk.account(payload.accountId),
    SK: sk.idempotency(dedupeKey),
  };
  const now = new Date().toISOString();
  const claimId = randomUUID();
  const ttl = Math.floor(Date.now() / 1000) + 35 * 86_400;
  const client = getDynamoDocumentClient();

  try {
    await client.send(
      new PutCommand({
        TableName: config.TABLE_NAME,
        Item: {
          ...key,
          accountId: payload.accountId,
          entityType: 'IdempotencyRecord',
          status: 'sending',
          claimId,
          createdAt: now,
          updatedAt: now,
          ttl,
        },
        ConditionExpression: 'attribute_not_exists(PK) AND attribute_not_exists(SK)',
      }),
    );
  } catch (error) {
    if (!(error instanceof Error) || error.name !== 'ConditionalCheckFailedException') {
      throw error;
    }

    const current = await client.send(
      new GetCommand({
        TableName: config.TABLE_NAME,
        Key: key,
        ConsistentRead: true,
      }),
    );
    const item = current.Item;

    if (item?.status === 'sent') {
      return undefined;
    }

    const staleBefore = new Date(Date.now() - 5 * 60_000).toISOString();

    if (item?.status !== 'sending' || typeof item.updatedAt !== 'string' || item.updatedAt >= staleBefore) {
      return undefined;
    }

    try {
      await client.send(
        new UpdateCommand({
          TableName: config.TABLE_NAME,
          Key: key,
          UpdateExpression: 'SET #updatedAt = :now, #claimId = :claimId',
          ConditionExpression: '#status = :sending AND #updatedAt = :previous',
          ExpressionAttributeNames: {
            '#status': 'status',
            '#updatedAt': 'updatedAt',
            '#claimId': 'claimId',
          },
          ExpressionAttributeValues: {
            ':now': now,
            ':claimId': claimId,
            ':previous': item.updatedAt,
            ':sending': 'sending',
          },
        }),
      );
    } catch (claimError) {
      if (claimError instanceof Error && claimError.name === 'ConditionalCheckFailedException') {
        return undefined;
      }

      throw claimError;
    }
  }

  return {
    markSent: async (): Promise<void> => {
      await client.send(
        new UpdateCommand({
          TableName: config.TABLE_NAME,
          Key: key,
          UpdateExpression: 'SET #status = :sent, #updatedAt = :now',
          ConditionExpression: '#status = :sending AND #claimId = :claimId',
          ExpressionAttributeNames: {
            '#claimId': 'claimId',
            '#status': 'status',
            '#updatedAt': 'updatedAt',
          },
          ExpressionAttributeValues: {
            ':now': new Date().toISOString(),
            ':claimId': claimId,
            ':sending': 'sending',
            ':sent': 'sent',
          },
        }),
      );
    },
    release: async (): Promise<void> => {
      await client.send(
        new DeleteCommand({
          TableName: config.TABLE_NAME,
          Key: key,
          ConditionExpression: '#status = :sending AND #claimId = :claimId',
          ExpressionAttributeNames: { '#claimId': 'claimId', '#status': 'status' },
          ExpressionAttributeValues: { ':claimId': claimId, ':sending': 'sending' },
        }),
      );
    },
  };
};

const defaultDependencies: NotificationDependencies = {
  sendEmail,
  sendWhatsApp,
  getContact: resolveContact,
  acquireDedupe: acquireNotificationDedupe,
};

export const createNotificationProcessor = (
  dependencies: NotificationDependencies = defaultDependencies,
) => {
  readNotificationWorkerConfig();

  return async (payload: NotificationJobPayload): Promise<void> => {
    const contact = await dependencies.getContact(payload);

    const dedupeLock = await dependencies.acquireDedupe?.(payload);

    if (dependencies.acquireDedupe !== undefined && dedupeLock === undefined) {
      return;
    }

    try {
      if (payload.channel === 'email') {
        if (!contact.email) {
          throw new NonRetryableWorkerError(
            'EMAIL_CONTACT_MISSING',
            'Notification email address was not found.',
          );
        }

        await dependencies.sendEmail({
          to: contact.email,
          locale: contact.locale,
          payload,
          contact,
        });
      } else {
        if (!contact.phone) {
          throw new NonRetryableWorkerError(
            'PHONE_CONTACT_MISSING',
            'Notification phone number was not found.',
          );
        }

        await dependencies.sendWhatsApp({
          to: contact.phone,
          payload,
          contact,
        });
      }

    } catch (error) {
      if (dedupeLock) {
        try {
          await dedupeLock.release();
        } catch (releaseError) {
          throw new AggregateError(
            [error, releaseError],
            'Notification send failed and its deduplication lock could not be released.',
          );
        }
      }

      throw error;
    }

    await dedupeLock?.markSent();
  };
};
