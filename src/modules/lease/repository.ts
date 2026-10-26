import { createHash } from 'node:crypto';

import {
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';

import { AppError } from '../../shared/errors';
import { getDocumentClient } from '../../shared/db';
import { gsi1, pk, sk } from '../../shared/db/keys';
import type { QueryPage } from '../../shared/db/pagination';
import { generatePaymentSchedule } from './validators';
import type { CreateLeaseInput, Lease, LeasePayment, LeaseStatus, UpdateLeaseInput } from './types';

export type LeaseRecord = Lease & {
  PK: string;
  SK: string;
  entityType: 'Lease';
  schemaVersion: number;
  GSI1PK: string;
  GSI1SK: string;
  GSI2PK: string;
  GSI2SK: string;
  idempotencyKeyHash?: string;
  requestHash?: string;
};

export type LeaseListOptions = {
  limit: number;
  cursor?: Record<string, unknown> | undefined;
  status?: LeaseStatus | undefined;
  propertyId?: string | undefined;
  tenantId?: string | undefined;
};

export type LeaseRenewalInput = {
  leaseId: string;
  expectedVersion: number;
  input: CreateLeaseInput;
  idempotencyKey: string;
};

type LeaseRepositoryOptions = {
  accountId: string;
  client?: DynamoDBDocumentClient;
  tableName?: string;
};

const isConditionalFailure = (error: unknown): boolean =>
  !!error &&
  typeof error === 'object' &&
  'name' in error &&
  (error.name === 'ConditionalCheckFailedException' || error.name === 'TransactionCanceledException');

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }

  return value;
};

const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
const toLeaseRecord = (item: Record<string, unknown>): LeaseRecord => ({ ...item } as LeaseRecord);

export const createLeaseRepository = ({
  accountId,
  client = getDocumentClient(),
  tableName = process.env.TABLE_NAME,
}: LeaseRepositoryOptions) => {
  if (!tableName) {
    throw new Error('TABLE_NAME must be configured before creating lease repositories.');
  }

  const partitionKey = pk.account(accountId);

  const getPayments = async (leaseId: string): Promise<LeasePayment[]> => {
    let exclusiveStartKey: Record<string, unknown> | undefined;
    const payments: LeasePayment[] = [];
    do {
      const result = await client.send(
        new QueryCommand({
          TableName: tableName,
          IndexName: 'GSI1',
          KeyConditionExpression: 'GSI1PK = :gsi1pk AND begins_with(GSI1SK, :prefix)',
          ExpressionAttributeValues: {
            ':gsi1pk': gsi1.lease(accountId, leaseId),
            ':prefix': 'PAYMENT#',
          },
          ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
          ConsistentRead: false,
        }),
      );
      for (const item of result.Items ?? []) {
        if (
          item.entityType === 'Payment' &&
          item.accountId === accountId &&
          item.PK === partitionKey &&
          item.leaseId === leaseId
        ) {
          payments.push(item as unknown as LeasePayment);
        }
      }
      exclusiveStartKey = result.LastEvaluatedKey;
    } while (exclusiveStartKey);

    return payments.sort((left, right) => left.dueDate.localeCompare(right.dueDate));
  };

  const setPaymentStatus = async (
    payment: LeasePayment & { PK?: string; accountId?: string; version?: number },
    status: 'cancelled',
  ): Promise<void> => {
    try {
      await client.send(
        new UpdateCommand({
          TableName: tableName,
          Key: { PK: partitionKey, SK: sk.payment(payment.id) },
          UpdateExpression: 'SET #status = :nextStatus, GSI2PK = :gsi2pk, updatedAt = :now, #version = :nextVersion',
          ConditionExpression: 'accountId = :accountId AND #status = :currentStatus',
          ExpressionAttributeNames: { '#status': 'status', '#version': 'version' },
          ExpressionAttributeValues: {
            ':accountId': accountId,
            ':currentStatus': 'due',
            ':nextStatus': status,
            ':gsi2pk': `${partitionKey}#STATUS#${status}`,
            ':now': new Date().toISOString(),
            ':nextVersion': (payment.version ?? 1) + 1,
          },
        }),
      );
    } catch (error) {
      if (isConditionalFailure(error)) {
        return;
      }

      throw error;
    }
  };

  const ensurePaymentSchedule = async (lease: LeaseRecord): Promise<LeasePayment[]> => {
    const payments = generatePaymentSchedule(lease);
    for (const payment of payments) {
      const item = {
        ...payment,
        PK: partitionKey,
        SK: sk.payment(payment.id),
        accountId,
        entityType: 'Payment',
        GSI1PK: gsi1.lease(accountId, lease.id),
        GSI1SK: `PAYMENT#${payment.dueDate}#${payment.id}`,
        GSI2PK: `${partitionKey}#STATUS#${payment.status}`,
        GSI2SK: `${payment.dueDate}#${payment.id}`,
        schemaVersion: 1,
        createdAt: lease.createdAt,
        updatedAt: lease.updatedAt,
      };
      try {
        await client.send(
          new PutCommand({
            TableName: tableName,
            Item: item,
            ConditionExpression: 'attribute_not_exists(PK) AND attribute_not_exists(SK)',
          }),
        );
      } catch (error) {
        if (!isConditionalFailure(error)) {
          throw error;
        }
      }
    }

    return payments;
  };

  const syncPaymentSchedule = async (lease: LeaseRecord): Promise<void> => {
    const expectedPayments = generatePaymentSchedule(lease);
    await ensurePaymentSchedule(lease);
    const expectedById = new Map(expectedPayments.map((payment) => [payment.id, payment]));
    const existingPayments = await getPayments(lease.id);

    for (const existing of existingPayments) {
      if (existing.status !== 'due') {
        continue;
      }
      const expected = expectedById.get(existing.id);
      if (!expected) {
        await setPaymentStatus(existing, 'cancelled');
        continue;
      }
      if (existing.amountDue === expected.amountDue && existing.dueDate === expected.dueDate) {
        continue;
      }

      try {
        await client.send(
          new UpdateCommand({
            TableName: tableName,
            Key: { PK: partitionKey, SK: sk.payment(existing.id) },
            UpdateExpression:
              'SET amountDue = :amountDue, dueDate = :dueDate, GSI1SK = :gsi1sk, GSI2SK = :gsi2sk, updatedAt = :now, #version = :nextVersion',
            ConditionExpression: 'accountId = :accountId AND #status = :due AND #version = :version',
            ExpressionAttributeNames: { '#status': 'status', '#version': 'version' },
            ExpressionAttributeValues: {
              ':accountId': accountId,
              ':due': 'due',
              ':version': existing.version,
              ':nextVersion': existing.version + 1,
              ':amountDue': expected.amountDue,
              ':dueDate': expected.dueDate,
              ':gsi1sk': `PAYMENT#${expected.dueDate}#${existing.id}`,
              ':gsi2sk': `${expected.dueDate}#${existing.id}`,
              ':now': new Date().toISOString(),
            },
          }),
        );
      } catch (error) {
        if (!isConditionalFailure(error)) {
          throw error;
        }
      }
    }
  };

  return {
    async list({ limit, cursor, status, propertyId, tenantId }: LeaseListOptions): Promise<QueryPage<LeaseRecord>> {
      if (
        cursor &&
        (cursor.PK !== partitionKey || typeof cursor.SK !== 'string' || !cursor.SK.startsWith('LEASE#'))
      ) {
        throw new AppError('Invalid lease pagination cursor.', 400, 'VALIDATION_ERROR');
      }

      const filters: string[] = [];
      const values: Record<string, unknown> = { ':pk': partitionKey, ':leasePrefix': 'LEASE#' };
      if (status) {
        filters.push('#status = :status');
        values[':status'] = status;
      }
      if (propertyId) {
        filters.push('propertyId = :propertyId');
        values[':propertyId'] = propertyId;
      }
      if (tenantId) {
        filters.push('contains(tenantIds, :tenantId)');
        values[':tenantId'] = tenantId;
      }

      const result = await client.send(
        new QueryCommand({
          TableName: tableName,
          KeyConditionExpression: 'PK = :pk AND begins_with(SK, :leasePrefix)',
          ...(filters.length ? { FilterExpression: filters.join(' AND ') } : {}),
          ...(status ? { ExpressionAttributeNames: { '#status': 'status' } } : {}),
          ExpressionAttributeValues: values,
          Limit: limit,
          ...(cursor ? { ExclusiveStartKey: cursor } : {}),
          ConsistentRead: true,
        }),
      );

      return {
        items: (result.Items ?? [])
          .filter(
            (item) => item.entityType === 'Lease' && item.accountId === accountId && item.PK === partitionKey,
          )
          .map((item) => toLeaseRecord(item as Record<string, unknown>)),
        nextCursor: result.LastEvaluatedKey,
      };
    },

    async getById(leaseId: string): Promise<LeaseRecord | undefined> {
      const result = await client.send(
        new GetCommand({
          TableName: tableName,
          Key: { PK: partitionKey, SK: sk.lease(leaseId) },
          ConsistentRead: true,
        }),
      );
      const item = result.Item as Record<string, unknown> | undefined;
      if (!item || item.entityType !== 'Lease') {
        return undefined;
      }
      if (item.accountId !== accountId || item.PK !== partitionKey) {
        throw new Error('DynamoDB lease does not belong to the repository account.');
      }

      return toLeaseRecord(item);
    },

    async create(input: CreateLeaseInput, idempotencyKey: string): Promise<LeaseRecord> {
      const requestHash = hash(JSON.stringify(canonicalize(input)));
      const idempotencyKeyHash = hash(idempotencyKey);
      const id = `L${hash(`${accountId}#${idempotencyKey}`).slice(0, 25).toUpperCase()}`;
      const now = new Date().toISOString();
      const status = input.status;
      const lease: LeaseRecord = {
        ...input,
        id,
        accountId,
        PK: partitionKey,
        SK: sk.lease(id),
        entityType: 'Lease',
        GSI1PK: gsi1.property(accountId, input.propertyId),
        GSI1SK: `LEASE#${input.startDate}#${id}`,
        GSI2PK: `${partitionKey}#STATUS#${status}`,
        GSI2SK: `${input.startDate}#${id}`,
        terminatedAt: null,
        terminationReason: null,
        idempotencyKeyHash,
        requestHash,
        schemaVersion: 1,
        version: 1,
        createdAt: now,
        updatedAt: now,
      };
      const linkItems = input.tenantIds.map((tenantId) => ({
        PK: partitionKey,
        SK: sk.tenantLeaseLink(tenantId, id),
        entityType: 'TenantLeaseLink',
        accountId,
        tenantId,
        leaseId: id,
        createdAt: now,
      }));
      try {
        await client.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                Put: {
                  TableName: tableName,
                  Item: lease,
                  ConditionExpression: 'attribute_not_exists(PK) AND attribute_not_exists(SK)',
                },
              },
              ...linkItems.map((Item) => ({
                Put: {
                  TableName: tableName,
                  Item,
                  ConditionExpression: 'attribute_not_exists(PK) AND attribute_not_exists(SK)',
                },
              })),
            ],
          }),
        );
      } catch (error) {
        if (isConditionalFailure(error)) {
          const existing = await this.getById(id);
          if (existing?.idempotencyKeyHash === idempotencyKeyHash && existing.requestHash === requestHash) {
            await ensurePaymentSchedule(existing);

            return existing;
          }
          if (existing?.idempotencyKeyHash) {
            throw new AppError('Idempotency key was already used for another request.', 409, 'IDEMPOTENCY_KEY_REUSED');
          }
        }

        throw error;
      }

      await this.ensurePaymentSchedule(lease);

      return lease;
    },

    async renew({ leaseId, expectedVersion, input, idempotencyKey }: LeaseRenewalInput): Promise<LeaseRecord> {
      const requestHash = hash(JSON.stringify(canonicalize(input)));
      const idempotencyKeyHash = hash(idempotencyKey);
      const successorId = `L${hash(`${accountId}#${idempotencyKey}`).slice(0, 25).toUpperCase()}`;
      const now = new Date().toISOString();
      const successor: LeaseRecord = {
        ...input,
        id: successorId,
        accountId,
        PK: partitionKey,
        SK: sk.lease(successorId),
        entityType: 'Lease',
        GSI1PK: gsi1.property(accountId, input.propertyId),
        GSI1SK: `LEASE#${input.startDate}#${successorId}`,
        GSI2PK: `${partitionKey}#STATUS#${input.status}`,
        GSI2SK: `${input.startDate}#${successorId}`,
        terminatedAt: null,
        terminationReason: null,
        idempotencyKeyHash,
        requestHash,
        schemaVersion: 1,
        version: 1,
        createdAt: now,
        updatedAt: now,
      };
      const linkItems = input.tenantIds.map((tenantId) => ({
        PK: partitionKey,
        SK: sk.tenantLeaseLink(tenantId, successorId),
        entityType: 'TenantLeaseLink',
        accountId,
        tenantId,
        leaseId: successorId,
        createdAt: now,
      }));
      if (linkItems.length > 98) {
        throw new AppError('A renewal can include at most 98 tenants.', 400, 'VALIDATION_ERROR');
      }

      try {
        await client.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                Update: {
                  TableName: tableName,
                  Key: { PK: partitionKey, SK: sk.lease(leaseId) },
                  UpdateExpression:
                    'SET #status = :expired, GSI2PK = :expiredGsi, updatedAt = :now, #version = :nextVersion',
                  ConditionExpression: 'accountId = :accountId AND #version = :expectedVersion AND #status = :active',
                  ExpressionAttributeNames: { '#status': 'status', '#version': 'version' },
                  ExpressionAttributeValues: {
                    ':accountId': accountId,
                    ':expectedVersion': expectedVersion,
                    ':nextVersion': expectedVersion + 1,
                    ':active': 'active',
                    ':expired': 'expired',
                    ':expiredGsi': `${partitionKey}#STATUS#expired`,
                    ':now': now,
                  },
                },
              },
              {
                Put: {
                  TableName: tableName,
                  Item: successor,
                  ConditionExpression: 'attribute_not_exists(PK) AND attribute_not_exists(SK)',
                },
              },
              ...linkItems.map((Item) => ({
                Put: {
                  TableName: tableName,
                  Item,
                  ConditionExpression: 'attribute_not_exists(PK) AND attribute_not_exists(SK)',
                },
              })),
            ],
          }),
        );
      } catch (error) {
        if (isConditionalFailure(error)) {
          const existing = await this.getById(successorId);
          if (existing?.idempotencyKeyHash === idempotencyKeyHash && existing.requestHash === requestHash) {
            await ensurePaymentSchedule(existing);

            return existing;
          }
          if (existing?.idempotencyKeyHash) {
            throw new AppError('Idempotency key was already used for another request.', 409, 'IDEMPOTENCY_KEY_REUSED');
          }
          throw new AppError('Lease version does not match or lease cannot be renewed.', 409, 'LEASE_STATE_CONFLICT');
        }
        throw error;
      }

      await ensurePaymentSchedule(successor);

      return successor;
    },

    ensurePaymentSchedule,

    getPayments,

    async update(
      leaseId: string,
      expectedVersion: number,
      input: UpdateLeaseInput,
    ): Promise<LeaseRecord> {
      const current = await this.getById(leaseId);
      if (!current) {
        throw new AppError('Lease version does not match or lease is unavailable.', 409, 'CONFLICT_VERSION_MISMATCH');
      }
      const names: Record<string, string> = {
        '#accountId': 'accountId',
        '#updatedAt': 'updatedAt',
        '#version': 'version',
      };
      const values: Record<string, unknown> = {
        ':accountId': accountId,
        ':expectedVersion': expectedVersion,
        ':nextVersion': expectedVersion + 1,
        ':now': new Date().toISOString(),
      };
      const assignments = ['#updatedAt = :now', '#version = :nextVersion'];
      for (const [key, value] of Object.entries(input)) {
        if (value === undefined) {
          continue;
        }
        names[`#${key}`] = key;
        values[`:${key}`] = value;
        assignments.push(`#${key} = :${key}`);
      }
      if (input.status !== undefined) {
        assignments.push('GSI2PK = :gsi2pk');
        values[':gsi2pk'] = `${partitionKey}#STATUS#${input.status}`;
      }
      try {
        const result = await client.send(
          new UpdateCommand({
            TableName: tableName,
            Key: { PK: partitionKey, SK: sk.lease(leaseId) },
            UpdateExpression: `SET ${assignments.join(', ')}`,
            ConditionExpression: '#accountId = :accountId AND #version = :expectedVersion',
            ExpressionAttributeNames: names,
            ExpressionAttributeValues: values,
            ReturnValues: 'ALL_NEW',
          }),
        );

        const updated = toLeaseRecord(result.Attributes as Record<string, unknown>);
        await syncPaymentSchedule(updated);

        return updated;
      } catch (error) {
        if (isConditionalFailure(error)) {
          const latest = await this.getById(leaseId);
          const alreadyApplied =
            latest?.version === expectedVersion + 1 &&
            Object.entries(input).every(([key, value]) => latest[key as keyof LeaseRecord] === value);
          if (latest && alreadyApplied) {
            await syncPaymentSchedule(latest);

            return latest;
          }
          throw new AppError('Lease version does not match or lease is unavailable.', 409, 'CONFLICT_VERSION_MISMATCH');
        }

        throw error;
      }
    },

    async terminate(
      leaseId: string,
      expectedVersion: number,
      terminatedAt: string,
      reason: string,
    ): Promise<LeaseRecord> {
      let lease: LeaseRecord;
      const current = await this.getById(leaseId);
      if (
        current?.status === 'terminated' &&
        current.version === expectedVersion + 1 &&
        current.terminatedAt === terminatedAt &&
        current.terminationReason === reason
      ) {
        lease = current;
      } else {
        try {
          const result = await client.send(
            new UpdateCommand({
              TableName: tableName,
              Key: { PK: partitionKey, SK: sk.lease(leaseId) },
              UpdateExpression:
                'SET #status = :terminated, GSI2PK = :gsi2pk, terminatedAt = :terminatedAt, terminationReason = :reason, updatedAt = :now, #version = :nextVersion',
              ConditionExpression: 'accountId = :accountId AND #version = :expectedVersion AND #status IN (:active, :draft)',
              ExpressionAttributeNames: { '#status': 'status', '#version': 'version' },
              ExpressionAttributeValues: {
                ':accountId': accountId,
                ':expectedVersion': expectedVersion,
                ':nextVersion': expectedVersion + 1,
                ':active': 'active',
                ':draft': 'draft',
                ':terminated': 'terminated',
                ':gsi2pk': `${partitionKey}#STATUS#terminated`,
                ':terminatedAt': terminatedAt,
                ':reason': reason,
                ':now': new Date().toISOString(),
              },
              ReturnValues: 'ALL_NEW',
            }),
          );
          lease = toLeaseRecord(result.Attributes as Record<string, unknown>);
        } catch (error) {
          if (isConditionalFailure(error)) {
            throw new AppError('Lease version does not match or lease cannot be terminated.', 409, 'LEASE_STATE_CONFLICT');
          }

          throw error;
        }
      }

      const futurePayments = (await getPayments(leaseId)).filter(
        (payment) => payment.status === 'due' && payment.dueDate > terminatedAt.slice(0, 10),
      );
      for (const payment of futurePayments) {
        await setPaymentStatus(payment, 'cancelled');
      }

      return lease;
    },
  };
};

export type LeaseRepository = ReturnType<typeof createLeaseRepository>;
