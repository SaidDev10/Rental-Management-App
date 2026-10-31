import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { SendMessageCommand } from '@aws-sdk/client-sqs';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { dynamoSend, sqsSend } = vi.hoisted(() => ({
  dynamoSend: vi.fn(),
  sqsSend: vi.fn(),
}));

vi.mock('../../src/shared/aws/clients', () => ({
  getDynamoDocumentClient: () => ({ send: dynamoSend }),
  getSqsClient: () => ({ send: sqsSend }),
}));

import { enqueueNotification } from '../../src/shared/sqs/enqueue-notification';

afterEach(() => {
  vi.clearAllMocks();
  delete process.env.TABLE_NAME;
  delete process.env.NOTIFICATION_QUEUE_URL;
});

describe('enqueueNotification', () => {
  it('queues password-reset delivery without requiring PDF-worker configuration', async () => {
    process.env.TABLE_NAME = 'auth-notification-test';
    process.env.NOTIFICATION_QUEUE_URL = 'https://sqs.eu-west-1.amazonaws.com/123456789012/notifications';

    await enqueueNotification('reset-job', {
      accountId: 'account-reset',
      kind: 'PASSWORD_RESET',
      userId: 'user-reset',
      code: '123456',
      channel: 'email',
    });

    expect(dynamoSend).toHaveBeenCalledOnce();
    const putCommand = dynamoSend.mock.calls[0]?.[0] as PutCommand;
    expect(putCommand).toBeInstanceOf(PutCommand);
    expect(putCommand.input).toMatchObject({
      TableName: 'auth-notification-test',
      Item: {
        PK: 'ACCOUNT#account-reset',
        SK: 'JOB#reset-job-notification',
        jobType: 'NOTIFY',
        status: 'queued',
        payload: {
          kind: 'PASSWORD_RESET',
          userId: 'user-reset',
          code: '123456',
          channel: 'email',
        },
      },
    });
    expect(putCommand.input.ConditionExpression).toContain('attribute_not_exists(PK)');

    expect(sqsSend).toHaveBeenCalledOnce();
    const sendCommand = sqsSend.mock.calls[0]?.[0] as SendMessageCommand;
    expect(sendCommand).toBeInstanceOf(SendMessageCommand);
    expect(sendCommand.input.QueueUrl).toBe(process.env.NOTIFICATION_QUEUE_URL);
    expect(JSON.parse(sendCommand.input.MessageBody ?? '{}')).toMatchObject({
      jobId: 'reset-job-notification',
      kind: 'PASSWORD_RESET',
      code: '123456',
    });

  });
});
