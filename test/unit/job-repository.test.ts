import {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, describe, expect, it } from 'vitest';

import { createJobRepository } from '../../src/workers/job-repository';

const clientMock = mockClient(DynamoDBDocumentClient);
const accountId = '01JEXAMPLEACCOUNT00000000001';
const jobId = '01JEXAMPLEJOB000000000000001';
const tableName = 'rental-app-main';

afterEach(() => {
  clientMock.reset();
});

describe('job repository', () => {
  const repository = () =>
    createJobRepository({
      accountId,
      client: clientMock as unknown as DynamoDBDocumentClient,
      tableName,
    });

  it('reads jobs consistently from its account partition', async () => {
    clientMock.on(GetCommand).resolves({ Item: undefined });

    await repository().get(jobId);

    const command = clientMock.commandCalls(GetCommand)[0]?.args[0];
    expect(command?.input.Key).toEqual({
      PK: `ACCOUNT#${accountId}`,
      SK: `JOB#${jobId}`,
    });
    expect(command?.input.ConsistentRead).toBe(true);
  });

  it('rejects a job item returned from a different account', async () => {
    clientMock.on(GetCommand).resolves({
      Item: {
        PK: 'ACCOUNT#foreign',
        SK: `JOB#${jobId}`,
        accountId: 'foreign',
        entityType: 'Job',
      },
    });

    await expect(repository().get(jobId)).rejects.toThrow(/requested account/);
  });

  it('claims only queued or stale processing jobs and increments attempts atomically', async () => {
    clientMock.on(UpdateCommand).resolves({
      Attributes: {
        PK: `ACCOUNT#${accountId}`,
        SK: `JOB#${jobId}`,
        accountId,
        entityType: 'Job',
        jobType: 'PDF_GENERATE',
        status: 'processing',
        attempts: 1,
        startedAt: '2026-10-17T10:00:00.000Z',
      },
    });

    await repository().claim(jobId, '2026-10-17T10:00:00.000Z', '2026-10-17T09:58:00.000Z');

    const command = clientMock.commandCalls(UpdateCommand)[0]?.args[0];
    expect(command?.input.Key).toEqual({
      PK: `ACCOUNT#${accountId}`,
      SK: `JOB#${jobId}`,
    });
    expect(command?.input.ConditionExpression).toContain('#status = :queued');
    expect(command?.input.ConditionExpression).toContain('#startedAt < :staleBefore');
    expect(command?.input.UpdateExpression).toContain('ADD #attempts :one');
  });

  it('reports an occupied claim as not claimed', async () => {
    const error = new Error('The conditional request failed');
    error.name = 'ConditionalCheckFailedException';
    clientMock.on(UpdateCommand).rejects(error);

    await expect(
      repository().claim(jobId, '2026-10-17T10:00:00.000Z', '2026-10-17T09:58:00.000Z'),
    ).resolves.toBeUndefined();
  });

  it('requires processing state before marking a job succeeded', async () => {
    clientMock.on(UpdateCommand).resolves({});

    await expect(
      repository().markSucceeded(jobId, '2026-10-17T10:00:00.000Z', {
        resultDocumentId: '01JEXAMPLEDOC00000000000001',
      }),
    ).resolves.toBe(true);

    const command = clientMock.commandCalls(UpdateCommand)[0]?.args[0];
    expect(command?.input.ConditionExpression).toContain('#status = :processing');
    expect(command?.input.ExpressionAttributeValues).toMatchObject({
      ':accountId': accountId,
      ':succeeded': 'succeeded',
      ':resultDocumentId': '01JEXAMPLEDOC00000000000001',
    });
  });

  it('returns retryable failures to queued and records a safe failure summary', async () => {
    clientMock.on(UpdateCommand).resolves({});

    await repository().markRetryable(jobId, '2026-10-17T10:00:00.000Z', {
      code: 'WORKER_RETRYABLE_FAILURE',
      message: 'Processing failed; the job will be retried.',
    });

    const command = clientMock.commandCalls(UpdateCommand)[0]?.args[0];
    expect(command?.input.UpdateExpression).toContain('REMOVE #startedAt');
    expect(command?.input.ExpressionAttributeValues?.[':error']).toMatchObject({
      code: 'WORKER_RETRYABLE_FAILURE',
      message: 'Processing failed; the job will be retried.',
      at: '2026-10-17T10:00:00.000Z',
    });
  });

  it('marks non-retryable work failed only while processing', async () => {
    clientMock.on(UpdateCommand).resolves({});

    await expect(
      repository().markFailed(jobId, '2026-10-17T10:00:00.000Z', {
        code: 'INVALID_DOCUMENT',
        message: 'Document cannot be rendered.',
      }),
    ).resolves.toBe(true);

    const command = clientMock.commandCalls(UpdateCommand)[0]?.args[0];
    expect(command?.input.ConditionExpression).toBe(
      '#accountId = :accountId AND #status = :processing',
    );
    expect(command?.input.ExpressionAttributeValues?.[':failed']).toBe('failed');
  });
});
