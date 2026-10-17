import {
  GetCommand,
  TransactWriteCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';

import { pk, sk } from '../shared/db/keys';

export type JobStatus = 'queued' | 'processing' | 'succeeded' | 'failed';

export type JobRecord = {
  PK: string;
  SK: string;
  accountId: string;
  entityType: 'Job';
  jobType: string;
  status: JobStatus;
  attempts: number;
  startedAt?: string;
  finishedAt?: string;
  updatedAt: string;
  resultS3Key?: string | null;
  resultDocumentId?: string | null;
  error?: { code: string; message: string; at: string } | null;
};

export type JobCompletion = {
  resultS3Key?: string;
  resultDocumentId?: string;
  document?: {
    PK: string;
    SK: string;
    accountId: string;
    entityType: 'Document';
    [attribute: string]: unknown;
  };
};

type JobRepositoryOptions = {
  accountId: string;
  client: DynamoDBDocumentClient;
  tableName: string;
};

const isConditionalFailure = (error: unknown): boolean => {
  return error instanceof Error && error.name === 'ConditionalCheckFailedException';
};

const assertJob = (accountId: string, job: JobRecord | undefined): JobRecord | undefined => {
  if (
    job !== undefined &&
    (job.PK !== pk.account(accountId) || job.accountId !== accountId || job.entityType !== 'Job')
  ) {
    throw new Error('Job does not belong to the requested account.');
  }

  return job;
};

export const createJobRepository = ({ accountId, client, tableName }: JobRepositoryOptions) => {
  const partitionKey = pk.account(accountId);

  return {
    async get(jobId: string): Promise<JobRecord | undefined> {
      const result = await client.send(
        new GetCommand({
          TableName: tableName,
          Key: { PK: partitionKey, SK: sk.job(jobId) },
          ConsistentRead: true,
        }),
      );

      return assertJob(accountId, result.Item as JobRecord | undefined);
    },

    async claim(jobId: string, now: string, staleBefore: string): Promise<JobRecord | undefined> {
      try {
        const result = await client.send(
          new UpdateCommand({
            TableName: tableName,
            Key: { PK: partitionKey, SK: sk.job(jobId) },
            UpdateExpression:
              'SET #status = :processing, #startedAt = :now, #updatedAt = :now REMOVE #error ADD #attempts :one',
            ConditionExpression:
              '#accountId = :accountId AND (#status = :queued OR (#status = :processing AND #startedAt < :staleBefore))',
            ExpressionAttributeNames: {
              '#accountId': 'accountId',
              '#attempts': 'attempts',
              '#startedAt': 'startedAt',
              '#status': 'status',
              '#updatedAt': 'updatedAt',
            },
            ExpressionAttributeValues: {
              ':accountId': accountId,
              ':now': now,
              ':one': 1,
              ':processing': 'processing',
              ':queued': 'queued',
              ':staleBefore': staleBefore,
            },
            ReturnValues: 'ALL_NEW',
          }),
        );

        return assertJob(accountId, result.Attributes as JobRecord | undefined);
      } catch (error) {
        if (isConditionalFailure(error)) {
          return undefined;
        }

        throw error;
      }
    },

    async markSucceeded(
      jobId: string,
      now: string,
      result: JobCompletion = {},
    ): Promise<boolean> {
      const setExpressions = ['#status = :succeeded', '#finishedAt = :now', '#updatedAt = :now'];
      const names: Record<string, string> = {
        '#accountId': 'accountId',
        '#finishedAt': 'finishedAt',
        '#status': 'status',
        '#updatedAt': 'updatedAt',
      };
      const values: Record<string, unknown> = {
        ':accountId': accountId,
        ':now': now,
        ':processing': 'processing',
        ':succeeded': 'succeeded',
      };

      if (result.resultS3Key !== undefined) {
        names['#resultS3Key'] = 'resultS3Key';
        values[':resultS3Key'] = result.resultS3Key;
        setExpressions.push('#resultS3Key = :resultS3Key');
      }

      if (result.resultDocumentId !== undefined) {
        names['#resultDocumentId'] = 'resultDocumentId';
        values[':resultDocumentId'] = result.resultDocumentId;
        setExpressions.push('#resultDocumentId = :resultDocumentId');
      }

      try {
        if (result.document !== undefined) {
          if (
            result.document.PK !== partitionKey ||
            result.document.accountId !== accountId ||
            result.document.entityType !== 'Document'
          ) {
            throw new Error('Generated document must belong to the job account.');
          }

          await client.send(
            new TransactWriteCommand({
              TransactItems: [
                {
                  Update: {
                    TableName: tableName,
                    Key: { PK: partitionKey, SK: sk.job(jobId) },
                    UpdateExpression: `SET ${setExpressions.join(', ')} REMOVE #error`,
                    ConditionExpression: '#accountId = :accountId AND #status = :processing',
                    ExpressionAttributeNames: { ...names, '#error': 'error' },
                    ExpressionAttributeValues: values,
                  },
                },
                {
                  Put: {
                    TableName: tableName,
                    Item: result.document,
                    ConditionExpression: 'attribute_not_exists(PK) AND attribute_not_exists(SK)',
                  },
                },
              ],
            }),
          );

          return true;
        }

        await client.send(
          new UpdateCommand({
            TableName: tableName,
            Key: { PK: partitionKey, SK: sk.job(jobId) },
            UpdateExpression: `SET ${setExpressions.join(', ')} REMOVE #error`,
            ConditionExpression: '#accountId = :accountId AND #status = :processing',
            ExpressionAttributeNames: { ...names, '#error': 'error' },
            ExpressionAttributeValues: values,
          }),
        );

        return true;
      } catch (error) {
        if (
          isConditionalFailure(error) ||
          (error instanceof Error && error.name === 'TransactionCanceledException')
        ) {
          return false;
        }

        throw error;
      }
    },

    async markRetryable(
      jobId: string,
      now: string,
      error: { code: string; message: string },
    ): Promise<boolean> {
      try {
        await client.send(
          new UpdateCommand({
            TableName: tableName,
            Key: { PK: partitionKey, SK: sk.job(jobId) },
            UpdateExpression:
              'SET #status = :queued, #updatedAt = :now, #error = :error REMOVE #startedAt',
            ConditionExpression: '#accountId = :accountId AND #status = :processing',
            ExpressionAttributeNames: {
              '#accountId': 'accountId',
              '#error': 'error',
              '#startedAt': 'startedAt',
              '#status': 'status',
              '#updatedAt': 'updatedAt',
            },
            ExpressionAttributeValues: {
              ':accountId': accountId,
              ':now': now,
              ':processing': 'processing',
              ':queued': 'queued',
              ':error': { ...error, at: now },
            },
          }),
        );

        return true;
      } catch (error) {
        if (isConditionalFailure(error)) {
          return false;
        }

        throw error;
      }
    },

    async markFailed(
      jobId: string,
      now: string,
      error: { code: string; message: string },
    ): Promise<boolean> {
      try {
        await client.send(
          new UpdateCommand({
            TableName: tableName,
            Key: { PK: partitionKey, SK: sk.job(jobId) },
            UpdateExpression:
              'SET #status = :failed, #finishedAt = :now, #updatedAt = :now, #error = :error',
            ConditionExpression: '#accountId = :accountId AND #status = :processing',
            ExpressionAttributeNames: {
              '#accountId': 'accountId',
              '#error': 'error',
              '#finishedAt': 'finishedAt',
              '#status': 'status',
              '#updatedAt': 'updatedAt',
            },
            ExpressionAttributeValues: {
              ':accountId': accountId,
              ':error': { ...error, at: now },
              ':failed': 'failed',
              ':now': now,
              ':processing': 'processing',
            },
          }),
        );

        return true;
      } catch (cause) {
        if (isConditionalFailure(cause)) {
          return false;
        }

        throw cause;
      }
    },
  };
};

export type JobRepository = ReturnType<typeof createJobRepository>;
