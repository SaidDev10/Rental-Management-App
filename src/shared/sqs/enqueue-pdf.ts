import { createHash } from 'node:crypto';
import { SendMessageCommand } from '@aws-sdk/client-sqs';
import { GetCommand, PutCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { getDynamoDocumentClient, getSqsClient } from '../aws/clients';
import { readApiConfig } from '../config';
import { pk, sk } from '../db/keys';
import { AppError } from '../errors';
import type { PdfJobPayload } from '../../workers/payloads';

const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
const conditionalFailure = (error: unknown): boolean =>
  error instanceof Error && (error.name === 'ConditionalCheckFailedException' || error.name === 'TransactionCanceledException');

type QuittancePayload = Extract<PdfJobPayload, { documentType: 'QUITTANCE' }>;
type QuittanceJobInput = Omit<QuittancePayload, 'jobId'>;
type QueueClient = { send: (command: SendMessageCommand) => Promise<unknown> };
type EnqueueQuittanceOptions = {
  documentClient?: DynamoDBDocumentClient;
  queueClient?: QueueClient;
  tableName?: string;
  queueUrl?: string;
  now?: () => Date;
};

export const enqueueQuittancePdf = async (
  input: QuittanceJobInput,
  idempotencyKey: string,
  options: EnqueueQuittanceOptions = {},
): Promise<{ jobId: string }> => {
  const config = options.tableName && options.queueUrl ? undefined : readApiConfig();
  const tableName = options.tableName ?? config!.TABLE_NAME;
  const queueUrl = options.queueUrl ?? config!.PDF_QUEUE_URL;
  const documentClient = options.documentClient ?? getDynamoDocumentClient();
  const queueClient = options.queueClient ?? getSqsClient();
  const keyHash = hash(idempotencyKey);
  const requestHash = hash(JSON.stringify({ accountId: input.accountId, paymentId: input.paymentId, documentType: input.documentType }));
  const jobId = 'Q' + hash(input.accountId + '#' + keyHash).slice(0, 25).toUpperCase();
  const partitionKey = pk.account(input.accountId);
  const sortKey = sk.job(jobId);
  const now = (options.now ?? (() => new Date()))().toISOString();
  const payload = { ...input };

  try {
    await documentClient.send(new PutCommand({
      TableName: tableName,
      Item: {
        PK: partitionKey,
        SK: sortKey,
        entityType: 'Job',
        accountId: input.accountId,
        jobType: 'PDF_GENERATE',
        status: 'queued',
        payload,
        attempts: 0,
        schemaVersion: 1,
        version: 1,
        idempotencyKeyHash: keyHash,
        requestHash,
        createdAt: now,
        updatedAt: now,
      },
      ConditionExpression: 'attribute_not_exists(PK) AND attribute_not_exists(SK)',
    }));
  } catch (error) {
    if (!conditionalFailure(error)) throw error;
    const result = await documentClient.send(new GetCommand({
      TableName: tableName,
      Key: { PK: partitionKey, SK: sortKey },
      ConsistentRead: true,
    }));
    const existing = result.Item;
    if (existing?.idempotencyKeyHash !== keyHash || existing.requestHash !== requestHash) {
      throw new AppError('Idempotency key was already used for another request.', 409, 'IDEMPOTENCY_KEY_REUSED');
    }
    if (existing.status !== 'queued') return { jobId };
  }

  await queueClient.send(new SendMessageCommand({
    QueueUrl: queueUrl,
    MessageBody: JSON.stringify({ ...payload, jobId }),
  }));

  return { jobId };
};
