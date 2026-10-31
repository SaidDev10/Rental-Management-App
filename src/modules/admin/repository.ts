import { GetMetricStatisticsCommand } from '@aws-sdk/client-cloudwatch';
import { DescribeTableCommand } from '@aws-sdk/client-dynamodb';
import {
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { GetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import { ulid } from 'ulid';

import { baseLogger } from '../../shared/logger';
import { getCloudWatchClient, getDynamoClient, getDynamoDocumentClient, getSqsClient } from '../../shared/aws/clients';
import { pk, sk } from '../../shared/db/keys';

export type AdminAccount = {
  id: string;
  name: string;
  ownerEmail?: string;
  ownerName?: string;
  locale?: 'fr' | 'en';
  status: string;
  createdAt?: string;
  updatedAt?: string;
};

export type AuditRecord = {
  accountId: string;
  actorUserId: string;
  actorRole: 'super_admin';
  action: string;
  targetType: string;
  targetId: string;
  ip?: string;
  userAgent?: string;
  requestId?: string;
  outcome: 'success' | 'failure';
  metadata?: Record<string, unknown>;
};

export type AdminRepository = ReturnType<typeof createAdminRepository>;

type AdminRepositoryOptions = {
  client?: DynamoDBDocumentClient;
  tableName?: string;
  dynamo?: Pick<ReturnType<typeof getDynamoClient>, 'send'>;
  sqs?: Pick<ReturnType<typeof getSqsClient>, 'send'>;
  cloudWatch?: Pick<ReturnType<typeof getCloudWatchClient>, 'send'>;
};

const MAX_PAGE_SIZE = 100;
const encodeKey = (key: Record<string, unknown>): string => Buffer.from(JSON.stringify(key)).toString('base64url');
const decodeKey = (token: string | undefined, expectedPk?: string): Record<string, unknown> | undefined => {
  if (!token) return undefined;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const key = parsed as Record<string, unknown>;
    if (typeof key.PK !== 'string' || typeof key.SK !== 'string' || (expectedPk && key.PK !== expectedPk)) return undefined;

    return key;
  } catch {
    return undefined;
  }
};
const pageLimit = (limit: number): number => Math.max(1, Math.min(MAX_PAGE_SIZE, Math.floor(limit)));
const toAccount = (item: Record<string, unknown>): AdminAccount => ({
  id: String(item.accountId ?? ''),
  name: String(item.name ?? ''),
  ...(typeof item.ownerEmail === 'string' ? { ownerEmail: item.ownerEmail } : {}),
  ...(typeof item.ownerName === 'string' ? { ownerName: item.ownerName } : {}),
  ...(item.locale === 'fr' || item.locale === 'en' ? { locale: item.locale } : {}),
  status: typeof item.status === 'string' ? item.status : 'active',
  ...(typeof item.createdAt === 'string' ? { createdAt: item.createdAt } : {}),
  ...(typeof item.updatedAt === 'string' ? { updatedAt: item.updatedAt } : {}),
});

export const createAdminRepository = ({
  client = getDynamoDocumentClient(),
  tableName = process.env.TABLE_NAME,
  dynamo = getDynamoClient(),
  sqs = getSqsClient(),
  cloudWatch = getCloudWatchClient(),
}: AdminRepositoryOptions = {}) => {
  if (!tableName) throw new Error('TABLE_NAME must be configured for admin operations.');

  const queryAudit = async (input: {
    accountId: string;
    from?: string;
    to?: string;
    action?: string;
    limit: number;
    nextToken?: string;
  }) => {
    const partition = pk.audit(input.accountId);
    const values: Record<string, string> = { ':partition': partition };
    let keyCondition = '#pk = :partition';
    if (input.from && input.to) {
      keyCondition += ' AND #sk BETWEEN :from AND :to';
      values[':from'] = `${input.from}#`;
      values[':to'] = `${input.to}#~`;
    } else if (input.from) {
      keyCondition += ' AND #sk >= :from';
      values[':from'] = `${input.from}#`;
    } else if (input.to) {
      keyCondition += ' AND #sk <= :to';
      values[':to'] = `${input.to}#~`;
    }
    const startKey = decodeKey(input.nextToken, partition);
    if (input.nextToken && !startKey) throw new Error('Invalid audit pagination token.');

    const result = await client.send(new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: keyCondition,
      ...(input.action ? { FilterExpression: '#action = :action' } : {}),
      ExpressionAttributeNames: { '#pk': 'PK', '#sk': 'SK', ...(input.action ? { '#action': 'action' } : {}) },
      ExpressionAttributeValues: { ...values, ...(input.action ? { ':action': input.action } : {}) },
      Limit: pageLimit(input.limit),
      ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      ScanIndexForward: false,
    }));

    return {
      items: (result.Items ?? []).map((item) => ({
        id: String(item.SK ?? ''),
        accountId: input.accountId,
        actorUserId: String(item.actorUserId ?? ''),
        actorRole: item.actorRole,
        action: String(item.action ?? ''),
        targetType: String(item.targetType ?? ''),
        targetId: String(item.targetId ?? ''),
        outcome: item.outcome,
        createdAt: String(item.createdAt ?? ''),
        ...(item.ip ? { ip: String(item.ip) } : {}),
        ...(item.userAgent ? { userAgent: String(item.userAgent) } : {}),
        ...(item.requestId ? { requestId: String(item.requestId) } : {}),
        ...(item.metadata && typeof item.metadata === 'object' ? { metadata: item.metadata } : {}),
      })),
      ...(result.LastEvaluatedKey ? { nextToken: encodeKey(result.LastEvaluatedKey) } : {}),
    };
  };

  return {
    async listAccounts(limit = 50, nextToken?: string) {
      const startKey = decodeKey(nextToken);
      if (nextToken && !startKey) throw new Error('Invalid accounts pagination token.');
      const result = await client.send(new ScanCommand({
        TableName: tableName,
        FilterExpression: '#entityType = :account',
        ExpressionAttributeNames: { '#entityType': 'entityType' },
        ExpressionAttributeValues: { ':account': 'Account' },
        Limit: pageLimit(limit),
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      }));
      const items = (result.Items ?? []).filter((item) => typeof item.accountId === 'string').map(toAccount);

      return { items, ...(result.LastEvaluatedKey ? { nextToken: encodeKey(result.LastEvaluatedKey) } : {}) };
    },

    async getAccount(accountId: string): Promise<AdminAccount | undefined> {
      const result = await client.send(new GetCommand({
        TableName: tableName,
        Key: { PK: pk.account(accountId), SK: sk.meta() },
        ConsistentRead: true,
      }));
      if (!result.Item || result.Item.entityType !== 'Account' || result.Item.accountId !== accountId) return undefined;

      return toAccount(result.Item);
    },

    async writeAudit(record: AuditRecord): Promise<void> {
      const now = new Date().toISOString();
      await client.send(new PutCommand({
        TableName: tableName,
        Item: {
          PK: pk.audit(record.accountId),
          SK: sk.auditEntry(now, ulid()),
          entityType: 'AuditLog',
          ...record,
          createdAt: now,
        },
        ConditionExpression: 'attribute_not_exists(PK) AND attribute_not_exists(SK)',
      }));
    },

    async listAudit(input: { accountId: string; from?: string; to?: string; action?: string; limit?: number; nextToken?: string }) {
      return queryAudit({ ...input, limit: input.limit ?? 50 });
    },

    async disableAccount(accountId: string): Promise<AdminAccount | undefined> {
      const now = new Date().toISOString();
      try {
        await client.send(new UpdateCommand({
          TableName: tableName,
          Key: { PK: pk.account(accountId), SK: sk.meta() },
          UpdateExpression: 'SET #status = :disabled, #updatedAt = :now',
          ConditionExpression: 'attribute_exists(PK) AND #entityType = :account',
          ExpressionAttributeNames: { '#status': 'status', '#updatedAt': 'updatedAt', '#entityType': 'entityType' },
          ExpressionAttributeValues: { ':disabled': 'disabled', ':now': now, ':account': 'Account' },
        }));
      } catch (error) {
        const name = typeof error === 'object' && error !== null && 'name' in error ? String(error.name) : '';
        if (name === 'ConditionalCheckFailedException') return undefined;
        throw error;
      }

      let exclusiveStartKey: Record<string, unknown> | undefined;
      do {
        const result = await client.send(new ScanCommand({
          TableName: tableName,
          FilterExpression: '#entityType = :session AND #accountId = :accountId AND #active = :active',
          ExpressionAttributeNames: { '#entityType': 'entityType', '#accountId': 'accountId', '#active': 'active' },
          ExpressionAttributeValues: { ':session': 'Session', ':accountId': accountId, ':active': true },
          ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
        }));
        for (const session of result.Items ?? []) {
          if (typeof session.userId !== 'string' || typeof session.sessionId !== 'string') continue;
          await client.send(new UpdateCommand({
            TableName: tableName,
            Key: { PK: pk.session(session.userId), SK: sk.active() },
            UpdateExpression: 'SET #active = :false, #revokedAt = :now, #updatedAt = :now',
            ConditionExpression: '#sessionId = :sessionId AND #active = :true',
            ExpressionAttributeNames: { '#active': 'active', '#revokedAt': 'revokedAt', '#updatedAt': 'updatedAt', '#sessionId': 'sessionId' },
            ExpressionAttributeValues: { ':false': false, ':true': true, ':now': now, ':sessionId': session.sessionId },
          })).catch((error: unknown) => {
            const name = typeof error === 'object' && error !== null && 'name' in error ? String(error.name) : '';
            if (name !== 'ConditionalCheckFailedException') throw error;
          });
        }
        exclusiveStartKey = result.LastEvaluatedKey;
      } while (exclusiveStartKey);

      return this.getAccount(accountId);
    },

    async health() {
      const tableResult = await dynamo.send(new DescribeTableCommand({ TableName: tableName }));
      const queueNames = ['PDF', 'REPORT', 'NOTIFICATION'];
      const queues = await Promise.all(queueNames.map(async (name) => {
        const queueUrl = process.env[`${name}_QUEUE_URL`];
        const dlqUrl = process.env[`${name}_DLQ_URL`];
        const readCount = async (url: string | undefined) => {
          if (!url) return null;
          const response = await sqs.send(new GetQueueAttributesCommand({
            QueueUrl: url,
            AttributeNames: ['ApproximateNumberOfMessages'],
          }));

          return Number(response.Attributes?.ApproximateNumberOfMessages ?? 0);
        };

        return {
          name: name.toLowerCase(),
          depth: await readCount(queueUrl),
          dlqDepth: await readCount(dlqUrl),
        };
      }));
      const functions = (process.env.ADMIN_LAMBDA_FUNCTIONS ?? '').split(',').map((name) => name.trim()).filter(Boolean);
      const endTime = new Date();
      const startTime = new Date(endTime.getTime() - 5 * 60 * 1000);
      const lambdaErrors = await Promise.all(functions.map(async (functionName) => {
        const result = await cloudWatch.send(new GetMetricStatisticsCommand({
          Namespace: 'AWS/Lambda',
          MetricName: 'Errors',
          Dimensions: [{ Name: 'FunctionName', Value: functionName }],
          StartTime: startTime,
          EndTime: endTime,
          Period: 300,
          Statistics: ['Sum'],
        }));
        const errors = (result.Datapoints ?? []).reduce((total, point) => total + (point.Sum ?? 0), 0);

        return { functionName, errorsLast5Minutes: errors };
      }));

      return {
        table: { name: tableName, status: tableResult.Table?.TableStatus ?? 'UNKNOWN' },
        queues,
        lambdaErrors,
        generatedAt: endTime.toISOString(),
      };
    },

    async tryWriteAudit(record: AuditRecord): Promise<void> {
      try {
        await this.writeAudit(record);
      } catch (error) {
        baseLogger.error({ error, action: record.action, targetId: record.targetId }, 'Admin audit write failed');
      }
    },
  };
};