import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { SendMessageCommand } from '@aws-sdk/client-sqs';
import { describe, expect, it, vi } from 'vitest';

import { enqueueQuittancePdf } from '../../src/shared/sqs/enqueue-pdf';

const input = { accountId: 'account-1', paymentId: 'payment-1', documentType: 'QUITTANCE' as const };
const options = { tableName: 'rental-test', queueUrl: 'https://sqs.example.test/pdf' };
const resolveSend = async (command: unknown): Promise<Record<string, never>> => {
  expect(command).toBeDefined();

  return {};
};

describe('quittance PDF producer', () => {
  it('persists a PDF_GENERATE job and sends the worker contract payload', async () => {
    const dynamoSend = vi.fn(resolveSend);
    const sqsSend = vi.fn(resolveSend);
    const { jobId } = await enqueueQuittancePdf(input, 'quittance-idempotency-key-001', {
      ...options,
      documentClient: { send: dynamoSend } as never,
      queueClient: { send: sqsSend },
      now: () => new Date('2026-10-27T12:00:00.000Z'),
    });

    expect(dynamoSend).toHaveBeenCalledTimes(1);
    const put = dynamoSend.mock.calls[0]?.[0] as PutCommand;
    expect(put.input.Item).toMatchObject({
      accountId: input.accountId,
      jobType: 'PDF_GENERATE',
      status: 'queued',
      payload: input,
    });
    const send = sqsSend.mock.calls[0]?.[0] as SendMessageCommand;
    expect(send.input.QueueUrl).toBe(options.queueUrl);
    expect(JSON.parse(send.input.MessageBody!)).toEqual({ ...input, jobId });
  });

  it('deduplicates retries and rejects an idempotency key reused for a different payment', async () => {
    const originalJob = {
      idempotencyKeyHash: 'invalid-placeholder',
      requestHash: 'invalid-placeholder',
      status: 'queued',
    };
    const initialPut = await enqueueQuittancePdf(input, 'same-idempotency-key-0001', {
      ...options,
      documentClient: { send: vi.fn(async () => ({})) } as never,
      queueClient: { send: vi.fn(resolveSend) },
    });
    const getResponse = { Item: originalJob };
    const dynamoSend = vi.fn(async (command: unknown) => {
      if (command instanceof PutCommand) throw Object.assign(new Error('exists'), { name: 'ConditionalCheckFailedException' });
      if (command instanceof GetCommand) return getResponse;

      return {};
    });
    const sqsSend = vi.fn(resolveSend);
    const key = 'same-idempotency-key-0001';
    const expectedHash = (await import('node:crypto')).createHash('sha256').update(key).digest('hex');
    const requestHash = (await import('node:crypto')).createHash('sha256').update(JSON.stringify(input)).digest('hex');
    originalJob.idempotencyKeyHash = expectedHash;
    originalJob.requestHash = requestHash;
    const duplicate = await enqueueQuittancePdf(input, key, {
      ...options,
      documentClient: { send: dynamoSend } as never,
      queueClient: { send: sqsSend },
    });
    expect(duplicate).toEqual(initialPut);
    expect(sqsSend).toHaveBeenCalledTimes(1);

    originalJob.status = 'processing';
    const completedSqsSend = vi.fn(resolveSend);
    await enqueueQuittancePdf(input, key, {
      ...options,
      documentClient: { send: dynamoSend } as never,
      queueClient: { send: completedSqsSend },
    });
    expect(completedSqsSend).not.toHaveBeenCalled();

    await expect(enqueueQuittancePdf({ ...input, paymentId: 'payment-2' }, key, {
      ...options,
      documentClient: { send: dynamoSend } as never,
      queueClient: { send: vi.fn(async () => ({})) },
    })).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED', status: 409 });
  });
});
