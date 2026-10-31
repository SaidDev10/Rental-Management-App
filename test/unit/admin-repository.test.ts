import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it } from 'vitest';

import { createAdminRepository } from '../../src/modules/admin/repository';

describe('admin repository', () => {
  it('scans account metadata only for the super-admin account index', async () => {
    let captured: ScanCommand | undefined;
    const repository = createAdminRepository({
      tableName: 'test-table',
      client: { send: async (command: unknown) => {
        if (command instanceof ScanCommand) captured = command;

        return { Items: [{ PK: 'ACCOUNT#a', SK: 'META', entityType: 'Account', accountId: 'a', name: 'A', ownerEmail: 'owner@example.test' }] };
      } } as unknown as DynamoDBDocumentClient,
    });
    const result = await repository.listAccounts(10);
    expect(result.items).toEqual([{ id: 'a', name: 'A', ownerEmail: 'owner@example.test', status: 'active' }]);
    expect(captured?.input.FilterExpression).toContain('#entityType = :account');
    expect(captured?.input.Limit).toBe(10);
  });

  it('writes audit rows under the account AUDIT partition and queries only that partition', async () => {
    const commands: unknown[] = [];
    const repository = createAdminRepository({
      tableName: 'test-table',
      client: { send: async (command: unknown) => {
        commands.push(command);
        if (command instanceof QueryCommand) return { Items: [] };

        return {};
      } } as unknown as DynamoDBDocumentClient,
    });
    await repository.writeAudit({
      accountId: 'target', actorUserId: 'admin', actorRole: 'super_admin', action: 'ADMIN_IMPERSONATE',
      targetType: 'Account', targetId: 'target', outcome: 'success',
    });
    await repository.listAudit({ accountId: 'target', from: '2026-01-01T00:00:00.000Z', action: 'ADMIN_IMPERSONATE' });

    const put = commands.find((command) => command instanceof PutCommand) as PutCommand;
    const query = commands.find((command) => command instanceof QueryCommand) as QueryCommand;
    expect(put.input.Item).toMatchObject({ PK: 'AUDIT#target', entityType: 'AuditLog', action: 'ADMIN_IMPERSONATE' });
    expect(query.input.KeyConditionExpression).toContain('#pk = :partition');
    expect(query.input.ExpressionAttributeValues).toMatchObject({ ':partition': 'AUDIT#target', ':action': 'ADMIN_IMPERSONATE' });
  });

  it('marks accounts disabled and revokes each active account session', async () => {
    const commands: unknown[] = [];
    const repository = createAdminRepository({
      tableName: 'test-table',
      client: { send: async (command: unknown) => {
        commands.push(command);
        if (command instanceof ScanCommand) {
          return { Items: [{ entityType: 'Session', userId: 'owner', sessionId: 'session', accountId: 'account', active: true }] };
        }
        if (command instanceof GetCommand) {
          return { Item: { entityType: 'Account', accountId: 'account', name: 'Rentals', status: 'disabled' } };
        }

        return {};
      } } as unknown as DynamoDBDocumentClient,
    });

    await expect(repository.disableAccount('account')).resolves.toMatchObject({ id: 'account', status: 'disabled' });
    const updates = commands.filter((command) => command instanceof UpdateCommand) as UpdateCommand[];
    expect(updates).toHaveLength(2);
    expect(updates[0]?.input.Key).toEqual({ PK: 'ACCOUNT#account', SK: 'META' });
    expect(updates[1]?.input.Key).toEqual({ PK: 'SESSION#owner', SK: 'ACTIVE' });
  });
});