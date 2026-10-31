import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  BatchGetCommand,
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { Hono } from 'hono';
import { release } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';

import type { AuthEnv } from '../../src/modules/auth/types';
import { createDashboardRoutes } from '../../src/modules/dashboard/routes';
import { createDashboardRepository } from '../../src/modules/dashboard/repository';
import { dashboardService } from '../../src/modules/dashboard/service';

const warmupCount = 50;
const sampleCount = 500;
const accountId = 'p5-t3-benchmark-account';
const tableName = 'p5-t3-dashboard-benchmark';
const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({
  region: 'eu-west-1',
  credentials: { accessKeyId: 'local-test', secretAccessKey: 'local-test' },
}));
const dynamoMock = mockClient(documentClient);

afterEach(() => {
  dynamoMock.reset();
  documentClient.destroy();
});

describe('dashboard warm-path benchmark (mocked DynamoDB)', () => {
  it('measures a p95 over repeated authenticated route requests', async () => {
    dynamoMock.on(GetCommand).callsFake(async ({ Key }) => ({
      Item: {
        PK: `ACCOUNT#${accountId}`,
        SK: Key?.SK,
        accountId,
        entityType: 'Summary',
        totalIncome: 125_000,
        totalExpenses: 20_000,
        netYield: 105_000,
        occupiedProperties: 4,
        totalProperties: 5,
        latePayments: 1,
        paidPayments: 4,
        openTickets: 2,
      },
    }));
    dynamoMock.on(QueryCommand).resolves({ Items: [], Count: 0 });
    dynamoMock.on(BatchGetCommand).resolves({ Responses: { [tableName]: [] } });

    const repository = createDashboardRepository({
      accountId,
      client: documentClient,
      tableName,
    });
    const service = {
      ...dashboardService,
      dashboard: (verifiedAccountId: string) =>
        dashboardService.dashboard(
          verifiedAccountId,
          new Date('2026-10-31T12:00:00.000Z'),
          repository,
        ),
    };
    const app = new Hono<AuthEnv>();
    app.use('*', async (context, next) => {
      context.set('accountId', accountId);
      context.set('userId', 'benchmark-owner');
      context.set('role', 'owner');
      context.set('email', 'owner@example.test');
      context.set('sessionId', 'benchmark-session');
      await next();
    });
    app.route('/dashboard', createDashboardRoutes({ service }));

    for (let index = 0; index < warmupCount; index += 1) {
      const response = await app.request('/dashboard');
      expect(response.status).toBe(200);
      await response.arrayBuffer();
    }

    const latenciesMs: number[] = [];
    for (let index = 0; index < sampleCount; index += 1) {
      const startedAt = performance.now();
      const response = await app.request('/dashboard');
      expect(response.status).toBe(200);
      await response.arrayBuffer();
      latenciesMs.push(performance.now() - startedAt);
    }

    latenciesMs.sort((left, right) => left - right);
    const p95Index = Math.ceil(0.95 * sampleCount) - 1;
    const p95Ms = latenciesMs[p95Index];
    expect(p95Ms).toBeTypeOf('number');

    process.stdout.write(
      `P5-T3 dashboard warm-path benchmark ${JSON.stringify({
        environment: 'Node.js in-process Hono + repository; AWS SDK DynamoDB commands mocked; no network/database/Lambda/API Gateway',
        nodeVersion: process.version,
        platform: `${process.platform} ${process.arch}`,
        osRelease: release(),
        warmupRequests: warmupCount,
        measuredRequests: sampleCount,
        percentile: 'nearest-rank',
        p95Ms: Number(p95Ms?.toFixed(3)),
        specTargetMs: 250,
        qualifiesAsEndToEnd: false,
      })}\n`,
    );
  });
});
