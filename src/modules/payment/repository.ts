import { createHash } from 'node:crypto';

import {
  BatchGetCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';

import { AppError } from '../../shared/errors';
import { getDocumentClient } from '../../shared/db';
import { gsi1, gsi2, pk, sk } from '../../shared/db/keys';
import type { QueryPage } from '../../shared/db/pagination';
import { localPaymentStoreFor } from './local-store';
import type {
  CreatePaymentInput,
  Payment,
  PaymentListOptions,
  RecordPaymentInput,
  UpdatePaymentInput,
} from './types';

export type PaymentRecord = Payment & {
  PK: string;
  SK: string;
  accountId: string;
  entityType: 'Payment';
  schemaVersion: number;
  GSI1PK: string;
  GSI1SK: string;
  GSI2PK: string;
  GSI2SK: string;
  idempotencyKeyHash?: string;
  requestHash?: string;
};

type PaymentRepositoryOptions = {
  accountId: string;
  client?: DynamoDBDocumentClient;
  tableName?: string;
};

const isConditionalFailure = (error: unknown): boolean =>
  !!error &&
  typeof error === 'object' &&
  'name' in error &&
  (error.name === 'ConditionalCheckFailedException' || error.name === 'TransactionCanceledException');

const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
const isLocalMode = (): boolean => process.env.STAGE !== 'prod' && process.env.USE_DYNAMO_AUTH === 'false';
const toPaymentRecord = (item: Record<string, unknown>): PaymentRecord => ({ ...item } as PaymentRecord);
const localPaymentRequestHashes = new Map<string, Map<string, string>>();

const batchGet = async (
  client: DynamoDBDocumentClient,
  tableName: string,
  keys: Array<{ PK: string; SK: string }>,
): Promise<Record<string, unknown>[]> => {
  const items: Record<string, unknown>[] = [];
  for (let offset = 0; offset < keys.length; offset += 100) {
    let requestKeys = keys.slice(offset, offset + 100);
    for (let retry = 0; retry <= 4; retry += 1) {
      const response = await client.send(
        new BatchGetCommand({
          RequestItems: { [tableName]: { Keys: requestKeys, ConsistentRead: true } },
        }),
      );
      items.push(...((response.Responses?.[tableName] ?? []) as Record<string, unknown>[]));
      const unprocessedKeys = response.UnprocessedKeys?.[tableName]?.Keys;
      if (!unprocessedKeys?.length) {
        break;
      }
      if (retry === 4) {
        throw new Error('DynamoDB did not process all overdue payment lookup keys after retries.');
      }
      requestKeys = unprocessedKeys as Array<{ PK: string; SK: string }>;
      await new Promise((resolve) => setTimeout(resolve, 25 * 2 ** retry));
    }
  }

  return items;
};

export const createPaymentRepository = ({
  accountId,
  client = getDocumentClient(),
  tableName = process.env.TABLE_NAME,
}: PaymentRepositoryOptions) => {
  if (!isLocalMode() && !tableName) {
    throw new Error('TABLE_NAME must be configured before creating payment repositories.');
  }

  const partitionKey = pk.account(accountId);
  const localPayments = isLocalMode() ? localPaymentStoreFor(accountId) : undefined;
  let localRequests = localPaymentRequestHashes.get(accountId);
  if (localPayments && !localRequests) {
    localRequests = new Map();
    localPaymentRequestHashes.set(accountId, localRequests);
  }
  const buildRecord = (input: Payment): PaymentRecord => {
    const now = new Date().toISOString();

    return {
      ...input,
      createdAt: input.createdAt ?? now,
      updatedAt: input.updatedAt ?? now,
      PK: partitionKey,
      SK: sk.payment(input.id),
      accountId,
      entityType: 'Payment',
      schemaVersion: 1,
      GSI1PK: gsi1.lease(accountId, input.leaseId),
      GSI1SK: `PAYMENT#${input.dueDate}#${input.id}`,
      GSI2PK: gsi2.status(accountId, input.status),
      GSI2SK: `${input.dueDate}#${input.id}`,
    };
  };

  const listStatusBeforeDate = async (
    status: 'due' | 'late' | 'partial',
    date: string,
  ): Promise<Record<string, unknown>[]> => {
    const keys: Array<{ PK: string; SK: string }> = [];
    let exclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const result = await client.send(
        new QueryCommand({
          TableName: tableName,
          IndexName: 'GSI2',
          KeyConditionExpression: 'GSI2PK = :statusPk AND GSI2SK < :today',
          ExpressionAttributeValues: {
            ':statusPk': gsi2.status(accountId, status),
            ':today': date,
          },
          ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
          ConsistentRead: false,
        }),
      );
      keys.push(...(result.Items ?? []).map(({ PK, SK }) => ({ PK: String(PK), SK: String(SK) })));
      exclusiveStartKey = result.LastEvaluatedKey;
    } while (exclusiveStartKey);

    return batchGet(client, tableName!, keys);
  };

  return {
    async list(options: PaymentListOptions): Promise<QueryPage<PaymentRecord>> {
      const { limit, cursor, status, leaseId, from, to } = options;
      if (
        cursor &&
        (cursor.PK !== partitionKey || typeof cursor.SK !== 'string' || !cursor.SK.startsWith('PAYMENT#'))
      ) {
        throw new AppError('Invalid payment pagination cursor.', 400, 'VALIDATION_ERROR');
      }
      if (localPayments) {
        const all = [...localPayments.values()]
          .filter(
            (payment) =>
              (!status || payment.status === status) &&
              (!leaseId || payment.leaseId === leaseId) &&
              (!from || payment.dueDate >= from) &&
              (!to || payment.dueDate <= to),
          )
          .sort((left, right) => left.dueDate.localeCompare(right.dueDate) || left.id.localeCompare(right.id));
        const cursorIndex = cursor
          ? all.findIndex((payment) => payment.id === cursor.SK?.toString().slice('PAYMENT#'.length))
          : -1;
        if (cursor && cursorIndex < 0) {
          throw new AppError('Invalid payment pagination cursor.', 400, 'VALIDATION_ERROR');
        }
        const startIndex = cursorIndex + 1;
        const items = all.slice(startIndex, startIndex + limit).map((payment) =>
          buildRecord(payment),
        );
        const last = items.at(-1);

        return {
          items,
          nextCursor:
            last && startIndex + items.length < all.length ? { PK: partitionKey, SK: last.SK } : undefined,
        };
      }

      const filters = ['entityType = :entityType', 'accountId = :accountId'];
      const values: Record<string, unknown> = {
        ':pk': partitionKey,
        ':prefix': 'PAYMENT#',
        ':entityType': 'Payment',
        ':accountId': accountId,
      };
      if (status) {
        filters.push('#status = :status');
        values[':status'] = status;
      }
      if (leaseId) {
        filters.push('leaseId = :leaseId');
        values[':leaseId'] = leaseId;
      }
      if (from) {
        filters.push('dueDate >= :from');
        values[':from'] = from;
      }
      if (to) {
        filters.push('dueDate <= :to');
        values[':to'] = to;
      }
      const result = await client.send(
        new QueryCommand({
          TableName: tableName,
          KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
          FilterExpression: filters.join(' AND '),
          ExpressionAttributeNames: status ? { '#status': 'status' } : undefined,
          ExpressionAttributeValues: values,
          Limit: limit,
          ...(cursor ? { ExclusiveStartKey: cursor } : {}),
          ConsistentRead: true,
        }),
      );

      return {
        items: (result.Items ?? [])
          .filter((item) => item.PK === partitionKey && item.accountId === accountId && item.entityType === 'Payment')
          .map((item) => toPaymentRecord(item as Record<string, unknown>)),
        nextCursor: result.LastEvaluatedKey,
      };
    },

    async listOverdue(today: string): Promise<PaymentRecord[]> {
      if (localPayments) {
        return [...localPayments.values()]
          .filter(
            (payment) =>
              payment.dueDate < today && (payment.status === 'late' || payment.status === 'partial'),
          )
          .sort((left, right) => left.dueDate.localeCompare(right.dueDate)          )
          .map((payment) => buildRecord(payment));
      }

      const items = [
        ...(await listStatusBeforeDate('late', today)),
        ...(await listStatusBeforeDate('partial', today)),
      ];

      return items
        .filter(
          (item) =>
            item.PK === partitionKey &&
            item.accountId === accountId &&
            item.entityType === 'Payment' &&
            typeof item.dueDate === 'string' &&
            item.dueDate < today &&
            (item.status === 'late' || item.status === 'partial'),
        )
        .map((item) => toPaymentRecord(item))
        .sort((left, right) => left.dueDate.localeCompare(right.dueDate));
    },

    async markOverdue(today: string): Promise<number> {
      if (localPayments) {
        let updatedCount = 0;
        for (const payment of localPayments.values()) {
          if (
            payment.dueDate < today &&
            (payment.status === 'due' || payment.status === 'partial')
          ) {
            localPayments.set(payment.id, {
              ...payment,
              status: 'late',
              version: payment.version + 1,
              updatedAt: new Date().toISOString(),
            });
            updatedCount += 1;
          }
        }

        return updatedCount;
      }

      const candidates = [
        ...(await listStatusBeforeDate('due', today)),
        ...(await listStatusBeforeDate('partial', today)),
      ];
      let updatedCount = 0;
      for (const candidate of candidates) {
        if (
          candidate.accountId !== accountId ||
          candidate.PK !== partitionKey ||
          candidate.entityType !== 'Payment' ||
          typeof candidate.id !== 'string' ||
          (candidate.status !== 'due' && candidate.status !== 'partial') ||
          typeof candidate.version !== 'number'
        ) {
          continue;
        }
        try {
          await client.send(
            new UpdateCommand({
              TableName: tableName,
              Key: { PK: partitionKey, SK: sk.payment(String(candidate.id)) },
              UpdateExpression:
                'SET #status = :late, GSI2PK = :gsi2pk, updatedAt = :now, #version = :nextVersion',
              ConditionExpression:
                'accountId = :accountId AND #status = :expectedStatus AND #version = :version AND GSI2SK < :today',
              ExpressionAttributeNames: { '#status': 'status', '#version': 'version' },
              ExpressionAttributeValues: {
                ':accountId': accountId,
                ':expectedStatus': candidate.status,
                ':version': candidate.version,
                ':nextVersion': candidate.version + 1,
                ':late': 'late',
                ':gsi2pk': gsi2.status(accountId, 'late'),
                ':now': new Date().toISOString(),
                ':today': today,
              },
            }),
          );
          updatedCount += 1;
        } catch (error) {
          if (!isConditionalFailure(error)) {
            throw error;
          }
        }
      }

      return updatedCount;
    },

    async getById(paymentId: string): Promise<PaymentRecord | undefined> {
      if (localPayments) {
        const payment = localPayments.get(paymentId);

        return payment ? buildRecord(payment) : undefined;
      }
      const result = await client.send(
        new GetCommand({
          TableName: tableName,
          Key: { PK: partitionKey, SK: sk.payment(paymentId) },
          ConsistentRead: true,
        }),
      );
      const item = result.Item as Record<string, unknown> | undefined;
      if (!item || item.entityType !== 'Payment') {
        return undefined;
      }
      if (item.accountId !== accountId || item.PK !== partitionKey) {
        throw new Error('DynamoDB payment does not belong to the repository account.');
      }

      return toPaymentRecord(item);
    },

    async create(
      input: CreatePaymentInput,
      lease: { propertyId: string; tenantId: string },
      idempotencyKey: string,
      requestHash: string,
    ): Promise<PaymentRecord> {
      const id = `P${hash(`${accountId}#${idempotencyKey}`).slice(0, 25).toUpperCase()}`;
      const record = buildRecord({
        ...input,
        ...lease,
        id,
        amountPaid: 0,
        paymentMethod: null,
        paidAt: null,
        status: 'due',
        quittanceNumber: null,
        quittanceDocId: null,
        version: 1,
      });
      if (localPayments) {
        const existing = localPayments.get(id);
        if (existing) {
          if (localRequests?.get(id) !== requestHash) {
            throw new AppError('Idempotency key was already used for another request.', 409, 'IDEMPOTENCY_KEY_REUSED');
          }

          return buildRecord(existing);
        }
        localPayments.set(id, record);
        localRequests?.set(id, requestHash);

        return record;
      }
      try {
        await client.send(
          new PutCommand({
            TableName: tableName,
            Item: { ...record, idempotencyKeyHash: hash(idempotencyKey), requestHash },
            ConditionExpression: 'attribute_not_exists(PK) AND attribute_not_exists(SK)',
          }),
        );

        return record;
      } catch (error) {
        if (isConditionalFailure(error)) {
          const existing = await this.getById(id);
          if (
            existing?.idempotencyKeyHash === hash(idempotencyKey) &&
            existing.requestHash === requestHash
          ) {
            return existing;
          }
          if (existing) {
            throw new AppError('Idempotency key was already used for another request.', 409, 'IDEMPOTENCY_KEY_REUSED');
          }
        }

        throw error;
      }
    },

    async update(
      paymentId: string,
      expectedVersion: number,
      input: UpdatePaymentInput,
    ): Promise<PaymentRecord> {
      const current = await this.getById(paymentId);
      if (!current) {
        throw new AppError('Payment not found.', 404, 'NOT_FOUND');
      }
      if (localPayments) {
        if (current.version !== expectedVersion || current.status !== 'due' || current.amountPaid !== 0) {
          throw new AppError('Payment version does not match or payment cannot be updated.', 409, 'PAYMENT_STATE_CONFLICT');
        }
        const updates = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
        const updated = {
          ...current,
          ...updates,
          version: current.version + 1,
          updatedAt: new Date().toISOString(),
        };
        localPayments.set(paymentId, updated);

        return buildRecord(updated);
      }

      const names: Record<string, string> = {
        '#accountId': 'accountId',
        '#status': 'status',
        '#version': 'version',
      };
      const values: Record<string, unknown> = {
        ':accountId': accountId,
        ':due': 'due',
        ':expectedVersion': expectedVersion,
        ':zero': 0,
        ':nextVersion': expectedVersion + 1,
        ':now': new Date().toISOString(),
      };
      const assignments = ['updatedAt = :now', '#version = :nextVersion'];
      for (const [key, value] of Object.entries(input)) {
        if (value === undefined) {
          continue;
        }
        names[`#${key}`] = key;
        values[`:${key}`] = value;
        assignments.push(`#${key} = :${key}`);
      }
      const dueDate = input.dueDate ?? current.dueDate;
      assignments.push('GSI1SK = :gsi1sk', 'GSI2SK = :gsi2sk');
      values[':gsi1sk'] = `PAYMENT#${dueDate}#${paymentId}`;
      values[':gsi2sk'] = `${dueDate}#${paymentId}`;
      try {
        const result = await client.send(
          new UpdateCommand({
            TableName: tableName,
            Key: { PK: partitionKey, SK: sk.payment(paymentId) },
            UpdateExpression: `SET ${assignments.join(', ')}`,
            ConditionExpression:
              '#accountId = :accountId AND #status = :due AND amountPaid = :zero AND #version = :expectedVersion',
            ExpressionAttributeNames: names,
            ExpressionAttributeValues: values,
            ReturnValues: 'ALL_NEW',
          }),
        );

        return toPaymentRecord(result.Attributes as Record<string, unknown>);
      } catch (error) {
        if (isConditionalFailure(error)) {
          throw new AppError('Payment version does not match or payment cannot be updated.', 409, 'PAYMENT_STATE_CONFLICT');
        }

        throw error;
      }
    },

    async recordPaid(
      paymentId: string,
      expectedVersion: number,
      input: RecordPaymentInput,
      status: 'partial' | 'paid',
    ): Promise<PaymentRecord> {
      const current = await this.getById(paymentId);
      if (!current) {
        throw new AppError('Payment not found.', 404, 'NOT_FOUND');
      }
      if (localPayments) {
        if (
          current.version !== expectedVersion ||
          !['due', 'partial', 'late'].includes(current.status) ||
          input.amountPaid <= current.amountPaid ||
          input.amountPaid > current.amountDue
        ) {
          throw new AppError('Payment version does not match or payment cannot be recorded.', 409, 'PAYMENT_STATE_CONFLICT');
        }
        const updated = {
          ...current,
          amountPaid: input.amountPaid,
          paidAt: input.paidAt,
          paymentMethod: input.paymentMethod,
          status,
          version: current.version + 1,
          updatedAt: new Date().toISOString(),
        };
        localPayments.set(paymentId, updated);

        return buildRecord(updated);
      }
      try {
        const result = await client.send(
          new UpdateCommand({
            TableName: tableName,
            Key: { PK: partitionKey, SK: sk.payment(paymentId) },
            UpdateExpression:
              'SET amountPaid = :amountPaid, paidAt = :paidAt, paymentMethod = :paymentMethod, #status = :nextStatus, GSI2PK = :gsi2pk, updatedAt = :now, #version = :nextVersion',
            ConditionExpression:
              'accountId = :accountId AND #version = :expectedVersion AND amountPaid < :amountPaid AND amountPaid <= amountDue AND amountDue >= :amountPaid AND (#status = :due OR #status = :partial OR #status = :late)',
            ExpressionAttributeNames: { '#status': 'status', '#version': 'version' },
            ExpressionAttributeValues: {
              ':accountId': accountId,
              ':expectedVersion': expectedVersion,
              ':nextVersion': expectedVersion + 1,
              ':amountPaid': input.amountPaid,
              ':paidAt': input.paidAt,
              ':paymentMethod': input.paymentMethod,
              ':nextStatus': status,
              ':gsi2pk': gsi2.status(accountId, status),
              ':now': new Date().toISOString(),
              ':due': 'due',
              ':partial': 'partial',
              ':late': 'late',
            },
            ReturnValues: 'ALL_NEW',
          }),
        );

        return toPaymentRecord(result.Attributes as Record<string, unknown>);
      } catch (error) {
        if (isConditionalFailure(error)) {
          throw new AppError('Payment version does not match or payment cannot be recorded.', 409, 'PAYMENT_STATE_CONFLICT');
        }

        throw error;
      }
    },

    async cancel(paymentId: string, expectedVersion: number): Promise<PaymentRecord> {
      const current = await this.getById(paymentId);
      if (!current) {
        throw new AppError('Payment not found.', 404, 'NOT_FOUND');
      }
      if (current.status === 'paid') {
        throw new AppError('A paid payment cannot be cancelled.', 409, 'PAYMENT_ALREADY_PAID');
      }
      if (localPayments) {
        if (current.version !== expectedVersion || current.status === 'cancelled') {
          throw new AppError('Payment version does not match or payment cannot be cancelled.', 409, 'PAYMENT_STATE_CONFLICT');
        }
        const updated = {
          ...current,
          status: 'cancelled' as const,
          version: current.version + 1,
          updatedAt: new Date().toISOString(),
        };
        localPayments.set(paymentId, updated);

        return buildRecord(updated);
      }
      try {
        const result = await client.send(
          new UpdateCommand({
            TableName: tableName,
            Key: { PK: partitionKey, SK: sk.payment(paymentId) },
            UpdateExpression:
              'SET #status = :cancelled, GSI2PK = :gsi2pk, updatedAt = :now, #version = :nextVersion',
            ConditionExpression:
              'accountId = :accountId AND #version = :expectedVersion AND #status <> :paid AND #status <> :cancelled',
            ExpressionAttributeNames: { '#status': 'status', '#version': 'version' },
            ExpressionAttributeValues: {
              ':accountId': accountId,
              ':expectedVersion': expectedVersion,
              ':nextVersion': expectedVersion + 1,
              ':cancelled': 'cancelled',
              ':paid': 'paid',
              ':gsi2pk': gsi2.status(accountId, 'cancelled'),
              ':now': new Date().toISOString(),
            },
            ReturnValues: 'ALL_NEW',
          }),
        );

        return toPaymentRecord(result.Attributes as Record<string, unknown>);
      } catch (error) {
        if (isConditionalFailure(error)) {
          const latest = await this.getById(paymentId);
          if (latest?.status === 'paid') {
            throw new AppError('A paid payment cannot be cancelled.', 409, 'PAYMENT_ALREADY_PAID');
          }
          throw new AppError('Payment version does not match or payment cannot be cancelled.', 409, 'PAYMENT_STATE_CONFLICT');
        }

        throw error;
      }
    },
  };
};

export type PaymentRepository = ReturnType<typeof createPaymentRepository>;
