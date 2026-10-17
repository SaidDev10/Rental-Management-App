import type { AttributeValue, DynamoDBRecord, DynamoDBStreamEvent } from 'aws-lambda';
import {
  GetCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';

import { getDynamoDocumentClient } from '../../shared/aws/clients';
import { readStreamWorkerConfig } from '../../shared/config';
import { pk, sk } from '../../shared/db/keys';
import { baseLogger } from '../../shared/logger';

export type SummaryDelta = {
  totalIncome: number;
  totalExpenses: number;
  netYield: number;
  occupiedProperties: number;
  totalProperties: number;
  latePayments: number;
  paidPayments: number;
  openTickets: number;
};

type DomainImage = Record<string, unknown> & {
  PK?: string;
  SK?: string;
  accountId?: string;
  entityType?: string;
};

const metricNames: (keyof SummaryDelta)[] = [
  'totalIncome',
  'totalExpenses',
  'netYield',
  'occupiedProperties',
  'totalProperties',
  'latePayments',
  'paidPayments',
  'openTickets',
];

const emptyDelta = (): SummaryDelta => ({
  totalIncome: 0,
  totalExpenses: 0,
  netYield: 0,
  occupiedProperties: 0,
  totalProperties: 0,
  latePayments: 0,
  paidPayments: 0,
  openTickets: 0,
});

const imageOf = (image: Record<string, AttributeValue> | undefined): DomainImage | undefined => {
  if (!image) {
    return undefined;
  }

  return unmarshall(image as never) as DomainImage;
};

const monthFromImage = (image: DomainImage | undefined, record: DynamoDBRecord): string => {
  if (typeof image?.periodStart === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(image.periodStart)) {
    return image.periodStart.slice(0, 7);
  }

  const timestamp = record.dynamodb?.ApproximateCreationDateTime;

  if (typeof timestamp === 'number' && Number.isFinite(timestamp)) {
    return new Date(timestamp * 1000).toISOString().slice(0, 7);
  }

  if (typeof image?.updatedAt === 'string') {
    const month = image.updatedAt.slice(0, 7);

    if (/^\d{4}-\d{2}$/.test(month)) {
      return month;
    }
  }

  throw new Error('Stream record has no valid month attribution.');
};

const paymentDelta = (image: DomainImage | undefined): SummaryDelta => {
  const delta = emptyDelta();

  if (!image || image.deletedAt) {
    return delta;
  }

  const amountPaid = typeof image.amountPaid === 'number' && Number.isSafeInteger(image.amountPaid)
    ? image.amountPaid
    : 0;
  const status = image.status;

  delta.totalIncome = amountPaid;

  if (status === 'paid') {
    delta.paidPayments = 1;
  }

  if (status === 'late') {
    delta.latePayments = 1;
  }

  return delta;
};

const contribution = (entityType: string, image: DomainImage | undefined): SummaryDelta => {
  const delta = emptyDelta();

  if (!image || image.deletedAt) {
    return delta;
  }

  if (entityType === 'Payment') {
    return paymentDelta(image);
  }

  if (entityType === 'Property') {
    delta.totalProperties = 1;
  } else if (entityType === 'Lease' && image.status === 'active') {
    delta.occupiedProperties = 1;
  } else if (
    entityType === 'MaintenanceTicket' &&
    (image.status === 'open' || image.status === 'in_progress')
  ) {
    delta.openTickets = 1;
  }

  return delta;
};

const subtract = (left: SummaryDelta, right: SummaryDelta): SummaryDelta => {
  const result = emptyDelta();

  for (const metric of metricNames) {
    result[metric] = left[metric] - right[metric];
  }

  return result;
};

const isDuplicateEvent = async (
  accountId: string,
  eventId: string,
  tableName: string,
): Promise<boolean> => {
  const result = await getDynamoDocumentClient().send(
    new GetCommand({
      TableName: tableName,
      Key: { PK: pk.account(accountId), SK: sk.processed(eventId) },
      ConsistentRead: true,
      ProjectionExpression: 'PK',
    }),
  );

  return result.Item !== undefined;
};

export const applySummaryDeltas = async (
  accountId: string,
  eventId: string,
  deltasByMonth: Map<string, SummaryDelta>,
  tableName: string,
): Promise<void> => {
  const now = new Date().toISOString();
  const transactItems = [
    {
      Put: {
        TableName: tableName,
        Item: {
          PK: pk.account(accountId),
          SK: sk.processed(eventId),
          entityType: 'ProcessedEvent',
          accountId,
          eventId,
          ttl: Math.floor(Date.now() / 1000) + 86_400,
        },
        ConditionExpression: 'attribute_not_exists(PK) AND attribute_not_exists(SK)',
      },
    },
    ...[...deltasByMonth.entries()].map(([month, delta]) => ({
      Update: {
        TableName: tableName,
        Key: { PK: pk.account(accountId), SK: sk.summary(month) },
        UpdateExpression:
          'SET #entityType = if_not_exists(#entityType, :entityType), #accountId = :accountId, #updatedAt = :now, #schemaVersion = if_not_exists(#schemaVersion, :one) ADD #totalIncome :totalIncome, #totalExpenses :totalExpenses, #netYield :netYield, #occupiedProperties :occupiedProperties, #totalProperties :totalProperties, #latePayments :latePayments, #paidPayments :paidPayments, #openTickets :openTickets, #version :one',
        ExpressionAttributeNames: {
          '#accountId': 'accountId',
          '#entityType': 'entityType',
          '#latePayments': 'latePayments',
          '#netYield': 'netYield',
          '#occupiedProperties': 'occupiedProperties',
          '#openTickets': 'openTickets',
          '#paidPayments': 'paidPayments',
          '#schemaVersion': 'schemaVersion',
          '#totalExpenses': 'totalExpenses',
          '#totalIncome': 'totalIncome',
          '#totalProperties': 'totalProperties',
          '#updatedAt': 'updatedAt',
          '#version': 'version',
        },
        ExpressionAttributeValues: {
          ':accountId': accountId,
          ':entityType': 'Summary',
          ':latePayments': delta.latePayments,
          ':netYield': delta.netYield,
          ':now': now,
          ':occupiedProperties': delta.occupiedProperties,
          ':one': 1,
          ':openTickets': delta.openTickets,
          ':paidPayments': delta.paidPayments,
          ':totalExpenses': delta.totalExpenses,
          ':totalIncome': delta.totalIncome,
          ':totalProperties': delta.totalProperties,
        },
      },
    })),
  ];

  await getDynamoDocumentClient().send(
    new TransactWriteCommand({
      TransactItems: transactItems,
    }),
  );
};

export const createStreamRecordProcessor = (
  tableName: string,
  apply = applySummaryDeltas,
) => {
  return async (record: DynamoDBRecord): Promise<void> => {
    const eventId = record.eventID;

    if (!eventId) {
      throw new Error('DynamoDB stream event has no eventID.');
    }

    const oldImage = imageOf(record.dynamodb?.OldImage);
    const newImage = imageOf(record.dynamodb?.NewImage);
    const entityType = newImage?.entityType ?? oldImage?.entityType;
    const accountId = newImage?.accountId ?? oldImage?.accountId;

    if (
      entityType !== 'Payment' &&
      entityType !== 'Lease' &&
      entityType !== 'MaintenanceTicket' &&
      entityType !== 'Property'
    ) {
      return;
    }

    if (
      typeof accountId !== 'string' ||
      (newImage?.PK ?? oldImage?.PK) !== pk.account(accountId)
    ) {
      return;
    }

    const oldMonth = oldImage ? monthFromImage(oldImage, record) : undefined;
    const newMonth = newImage ? monthFromImage(newImage, record) : undefined;
    const oldDelta = contribution(entityType, oldImage);
    const newDelta = contribution(entityType, newImage);
    const deltasByMonth = new Map<string, SummaryDelta>();

    if (oldMonth && newMonth && oldMonth !== newMonth) {
      deltasByMonth.set(oldMonth, subtract(emptyDelta(), oldDelta));
      deltasByMonth.set(newMonth, newDelta);
    } else {
      const month = newMonth ?? oldMonth;

      if (!month) {
        throw new Error('Stream record has no month attribution.');
      }

      deltasByMonth.set(month, subtract(newDelta, oldDelta));
    }

    try {
      await apply(accountId, eventId, deltasByMonth, tableName);
    } catch (error) {
      if (
        error instanceof Error &&
        error.name === 'TransactionCanceledException' &&
        (await isDuplicateEvent(accountId, eventId, tableName))
      ) {
        baseLogger.info({ eventId, accountId }, 'Duplicate stream event already aggregated');

        return;
      }

      throw error;
    }
  };
};

export const createConfiguredStreamRecordProcessor = () => {
  const config = readStreamWorkerConfig();

  return createStreamRecordProcessor(config.TABLE_NAME);
};

export type { DynamoDBStreamEvent };
