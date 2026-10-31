import {
  BatchGetCommand,
  GetCommand,
  QueryCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';

import { getDocumentClient } from '../../shared/db';
import { gsi2, pk, sk } from '../../shared/db/keys';
import type { Payment } from '../payment/types';

type DashboardRepositoryOptions = {
  accountId: string;
  client?: DynamoDBDocumentClient;
  tableName?: string;
};

export type MonthlySummary = {
  month: string;
  totalIncome: number;
  totalExpenses: number;
  netYield: number;
  occupiedProperties: number;
  totalProperties: number;
  latePayments: number;
  paidPayments: number;
  openTickets: number;
  updatedAt?: string;
};

type StoredSummary = Partial<MonthlySummary> & {
  PK?: string;
  SK?: string;
  accountId?: string;
  entityType?: string;
};

const emptySummary = (month: string): MonthlySummary => ({
  month,
  totalIncome: 0,
  totalExpenses: 0,
  netYield: 0,
  occupiedProperties: 0,
  totalProperties: 0,
  latePayments: 0,
  paidPayments: 0,
  openTickets: 0,
});

const toPublicPayment = (item: Record<string, unknown>): Payment => ({
  id: String(item.id),
  leaseId: String(item.leaseId),
  propertyId: String(item.propertyId),
  tenantId: String(item.tenantId),
  periodStart: String(item.periodStart),
  periodEnd: String(item.periodEnd),
  dueDate: String(item.dueDate),
  amountDue: Number(item.amountDue),
  amountPaid: Number(item.amountPaid),
  paymentMethod: (item.paymentMethod ?? null) as Payment['paymentMethod'],
  paidAt: (item.paidAt ?? null) as Payment['paidAt'],
  status: item.status as Payment['status'],
  quittanceNumber: (item.quittanceNumber ?? null) as Payment['quittanceNumber'],
  quittanceDocId: (item.quittanceDocId ?? null) as Payment['quittanceDocId'],
  version: Number(item.version),
  ...(typeof item.notes === 'string' || item.notes === null ? { notes: item.notes } : {}),
  ...(typeof item.createdAt === 'string' ? { createdAt: item.createdAt } : {}),
  ...(typeof item.updatedAt === 'string' ? { updatedAt: item.updatedAt } : {}),
});

const addDays = (date: string, days: number): string => {
  const result = new Date(`${date}T00:00:00.000Z`);
  result.setUTCDate(result.getUTCDate() + days);

  return result.toISOString().slice(0, 10);
};

export const createDashboardRepository = ({
  accountId,
  client = getDocumentClient(),
  tableName = process.env.TABLE_NAME,
}: DashboardRepositoryOptions) => {
  if (!tableName) {
    throw new Error('TABLE_NAME must be configured before creating dashboard repositories.');
  }

  const partitionKey = pk.account(accountId);

  const readSummary = async (month: string): Promise<MonthlySummary> => {
    const result = await client.send(
      new GetCommand({
        TableName: tableName,
        Key: { PK: partitionKey, SK: sk.summary(month) },
        ConsistentRead: true,
      }),
    );
    const item = result.Item as StoredSummary | undefined;
    if (
      !item ||
      item.PK !== partitionKey ||
      item.accountId !== accountId ||
      item.SK !== sk.summary(month)
    ) {
      return emptySummary(month);
    }

    return {
      ...emptySummary(month),
      totalIncome: item.totalIncome ?? 0,
      totalExpenses: item.totalExpenses ?? 0,
      netYield: item.netYield ?? 0,
      occupiedProperties: item.occupiedProperties ?? 0,
      totalProperties: item.totalProperties ?? 0,
      latePayments: item.latePayments ?? 0,
      paidPayments: item.paidPayments ?? 0,
      openTickets: item.openTickets ?? 0,
      ...(item.updatedAt ? { updatedAt: item.updatedAt } : {}),
    };
  };

  const getKeysForStatus = async (
    status: string,
    fromDate?: string,
    toDate?: string,
    limit?: number,
  ): Promise<Array<{ PK: string; SK: string }>> => {
    const keys: Array<{ PK: string; SK: string }> = [];
    let exclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const response = await client.send(
        new QueryCommand({
          TableName: tableName,
          IndexName: 'GSI2',
          KeyConditionExpression: fromDate && toDate
            ? 'GSI2PK = :statusPk AND GSI2SK BETWEEN :from AND :to'
            : 'GSI2PK = :statusPk',
          ExpressionAttributeValues: {
            ':statusPk': gsi2.status(accountId, status),
            ...(fromDate && toDate
              ? { ':from': `${fromDate}#`, ':to': `${toDate}#\uffff` }
              : {}),
          },
          ...(limit === undefined ? {} : { Limit: limit }),
          ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
          ConsistentRead: false,
        }),
      );
      keys.push(
        ...(response.Items ?? []).map((item) => ({
          PK: String(item.PK),
          SK: String(item.SK),
        })),
      );
      exclusiveStartKey = response.LastEvaluatedKey;
    } while (exclusiveStartKey && (limit === undefined || keys.length < limit));

    return keys;
  };

  const batchGet = async (keys: Array<{ PK: string; SK: string }>): Promise<Record<string, unknown>[]> => {
    if (!keys.length) {
      return [];
    }
    let pending = keys;
    const items: Record<string, unknown>[] = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const result = await client.send(
        new BatchGetCommand({
          RequestItems: { [tableName!]: { Keys: pending, ConsistentRead: true } },
        }),
      );
      items.push(...((result.Responses?.[tableName!] ?? []) as Record<string, unknown>[]));
      const unprocessed = result.UnprocessedKeys?.[tableName!]?.Keys;
      if (!unprocessed?.length) {
        return items;
      }
      pending = unprocessed as Array<{ PK: string; SK: string }>;
    }

    throw new Error('DynamoDB did not process all dashboard lookup keys after retries.');
  };

  return {
    getSummary: readSummary,

    async getSummaries(months: string[]): Promise<MonthlySummary[]> {
      return Promise.all(months.map(readSummary));
    },

    async listDueNext30Days(limit = 10, today = new Date().toISOString().slice(0, 10)) {
      const toDate = addDays(today, 30);
      const statusKeys = await Promise.all([
        getKeysForStatus('due', today, toDate, limit),
        getKeysForStatus('partial', today, toDate, limit),
      ]);
      const keys = [...statusKeys[0], ...statusKeys[1]];
      const payments = (await batchGet(keys))
        .filter(
          (item) =>
            item.PK === partitionKey &&
            item.accountId === accountId &&
            item.entityType === 'Payment' &&
            (item.status === 'due' || item.status === 'partial') &&
            typeof item.dueDate === 'string' &&
            item.dueDate >= today &&
            item.dueDate <= toDate,
        )
        .sort(
          (left, right) =>
            String(left.dueDate).localeCompare(String(right.dueDate)) ||
            String(left.id).localeCompare(String(right.id)),
        )
        .slice(0, limit);

      return payments.map(toPublicPayment);
    },

    async countOpenTickets(): Promise<number> {
      const counts = await Promise.all(['open', 'in_progress'].map(async (status) => {
        let count = 0;
        let exclusiveStartKey: Record<string, unknown> | undefined;
        do {
          const response = await client.send(
            new QueryCommand({
              TableName: tableName,
              IndexName: 'GSI2',
              KeyConditionExpression: 'GSI2PK = :statusPk',
              ExpressionAttributeValues: { ':statusPk': gsi2.status(accountId, status) },
              Select: 'COUNT',
              ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
              ConsistentRead: false,
            }),
          );
          count += response.Count ?? 0;
          exclusiveStartKey = response.LastEvaluatedKey;
        } while (exclusiveStartKey);

        return count;
      }));

      return counts.reduce((total, count) => total + count, 0);
    },
  };
};
