import { createHash } from 'node:crypto';

import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { Context, MiddlewareHandler } from 'hono';

import { getDocumentClient } from '../db';
import { AppError } from '../errors';

type Counter = { count: number; expiresAt: number };
const localCounters = new Map<string, Counter>();

const isLocalAuthMode = (): boolean =>
  process.env.STAGE !== 'prod' && process.env.USE_DYNAMO_AUTH === 'false';

const hash = (value: string): string => createHash('sha256').update(value).digest('hex');

export const enforceRateLimit = async (
  scope: string,
  identity: string,
  limit: number,
  windowSeconds: number,
  now = Date.now(),
): Promise<void> => {
  const window = Math.floor(now / (windowSeconds * 1000));
  const subjectKey = hash(scope + ':' + identity);
  const key = subjectKey + ':' + window;
  const expiresAt = (window + 1) * windowSeconds;

  if (isLocalAuthMode()) {
    const existing = localCounters.get(key);
    if (existing && existing.count >= limit) {
      throw new AppError('Too many requests', 429, 'RATE_LIMITED');
    }
    localCounters.set(key, { count: (existing?.count ?? 0) + 1, expiresAt: expiresAt * 1000 });
    if (localCounters.size > 10_000) {
      for (const [counterKey, counter] of localCounters) {
        if (counter.expiresAt <= now) localCounters.delete(counterKey);
      }
    }

    return;
  }

  const tableName = process.env.TABLE_NAME;
  if (!tableName) throw new Error('TABLE_NAME must be configured for rate limiting.');

  try {
    await getDocumentClient().send(new UpdateCommand({
      TableName: tableName,
      Key: { PK: 'RATE#' + subjectKey, SK: 'WINDOW#' + window },
      UpdateExpression: 'SET #ttl = if_not_exists(#ttl, :expiresAt) ADD #count :one',
      ConditionExpression: 'attribute_not_exists(#count) OR #count < :limit',
      ExpressionAttributeNames: { '#ttl': 'ttl', '#count': 'count' },
      ExpressionAttributeValues: { ':expiresAt': expiresAt, ':one': 1, ':limit': limit },
    }));
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException ||
        (error instanceof Error && error.name === 'ConditionalCheckFailedException')) {
      throw new AppError('Too many requests', 429, 'RATE_LIMITED');
    }
    throw error;
  }
};

export const getClientIp = (context: Context): string => {
  const requestContext = (context.env as {
    requestContext?: {
      identity?: { sourceIp?: string };
      http?: { sourceIp?: string };
      elb?: unknown;
    };
  } | undefined)?.requestContext;
  const gatewayIp = requestContext?.http?.sourceIp ?? requestContext?.identity?.sourceIp;
  if (gatewayIp) return gatewayIp;

  // For ALB events the adapter cannot expose sourceIp; use the final proxy-added address.
  const forwardedFor = context.req.header('x-forwarded-for');
  if (requestContext?.elb && forwardedFor) {
    const addresses = forwardedFor.split(',').map((address) => address.trim()).filter(Boolean);

    return addresses.at(-1) ?? 'unknown';
  }

  // Direct local requests have no API Gateway event; production never trusts a bare header.
  return process.env.STAGE === 'prod' ? 'unknown' : forwardedFor?.split(',').map((address) => address.trim()).filter(Boolean).at(-1) ?? 'unknown';
};

export const rateLimitMiddleware = (options: {
  scope: string;
  limit: number;
  windowSeconds: number;
  identity: (context: Context) => string;
}): MiddlewareHandler => async (context, next) => {
  const identity = options.identity(context);
  // Local app requests have no network peer; preserve test/dev usability. Production
  // treats a missing forwarded address as one shared bucket rather than bypassing limits.
  if (identity === 'unknown' && process.env.STAGE !== 'prod') {
    await next();

    return;
  }
  await enforceRateLimit(options.scope, identity, options.limit, options.windowSeconds);
  await next();
};
