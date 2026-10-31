import { SendMessageCommand } from '@aws-sdk/client-sqs';
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';

import { getDynamoDocumentClient } from '../aws/clients';
import { getSqsClient } from '../aws/clients';
import { pk, sk } from '../db/keys';
import type { NotificationJobPayload } from '../../workers/payloads';

type NotificationInput = NotificationJobPayload extends infer Payload
  ? Payload extends { jobId: string }
    ? Omit<Payload, 'jobId'>
    : never
  : never;

const conditionalFailure = (error: unknown): boolean => {
  return error instanceof Error && error.name === 'ConditionalCheckFailedException';
};

export const enqueueNotification = async (
  sourceJobId: string,
  notification: NotificationInput,
): Promise<void> => {
  const TABLE_NAME = process.env.TABLE_NAME;
  const NOTIFICATION_QUEUE_URL = process.env.NOTIFICATION_QUEUE_URL;
  if (!TABLE_NAME || !NOTIFICATION_QUEUE_URL) {
    throw new Error('TABLE_NAME and NOTIFICATION_QUEUE_URL must be configured for notification enqueue.');
  }
  const client = getDynamoDocumentClient();
  const queueClient = getSqsClient();
  const accountId = notification.accountId;
  const notificationJobId = `${sourceJobId}-notification`;
  const partitionKey = pk.account(accountId);
  const sortKey = sk.job(notificationJobId);
  const now = new Date().toISOString();
  try {
    await client.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          PK: partitionKey,
          SK: sortKey,
          entityType: 'Job',
          accountId,
          jobType: 'NOTIFY',
          status: 'queued',
          payload: notification,
          attempts: 0,
          schemaVersion: 1,
          version: 1,
          createdAt: now,
          updatedAt: now,
        },
        ConditionExpression: 'attribute_not_exists(PK) AND attribute_not_exists(SK)',
      }),
    );
  } catch (error) {
    if (!conditionalFailure(error)) {
      throw error;
    }

    const result = await client.send(
      new GetCommand({
        TableName: TABLE_NAME,
        Key: { PK: partitionKey, SK: sortKey },
        ConsistentRead: true,
      }),
    );
    const existingJob = result.Item;

    if (existingJob?.status !== 'queued') {
      return;
    }
  }

  await queueClient.send(
    new SendMessageCommand({
      QueueUrl: NOTIFICATION_QUEUE_URL,
      MessageBody: JSON.stringify({ ...notification, jobId: notificationJobId }),
    }),
  );
};
