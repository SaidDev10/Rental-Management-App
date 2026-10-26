export type QueryPage<T> = {
  items: T[];
  nextCursor: Record<string, unknown> | undefined;
};

export const encodeCursor = (lastEvaluatedKey?: Record<string, unknown>): string | null =>
  lastEvaluatedKey
    ? Buffer.from(JSON.stringify(lastEvaluatedKey)).toString('base64url')
    : null;

export const decodeCursor = (cursor?: string): Record<string, unknown> | undefined => {
  if (!cursor) {
    return undefined;
  }

  const decoded: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString());
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
    throw new TypeError('Pagination cursor must encode a DynamoDB key object.');
  }

  return decoded as Record<string, unknown>;
};
