import { NotFoundError, ForbiddenError } from '../../shared/errors';
import { signImpersonationToken } from '../auth/tokens';
import { createAdminRepository, type AdminRepository, type AuditRecord } from './repository';

const getDefaultRepository = (): AdminRepository => createAdminRepository();

export type AdminActor = {
  userId: string;
  role: 'owner' | 'super_admin';
  email: string;
  sessionId: string;
  accountId: string;
  ip?: string;
  userAgent?: string;
  requestId?: string;
};

const auditRecord = (
  actor: AdminActor,
  values: Omit<AuditRecord, 'accountId' | 'actorUserId' | 'actorRole' | 'ip' | 'userAgent' | 'requestId'> & { accountId?: string },
): AuditRecord => ({
  ...values,
  accountId: values.accountId ?? actor.accountId,
  actorUserId: actor.userId,
  actorRole: 'super_admin',
  ...(actor.ip ? { ip: actor.ip } : {}),
  ...(actor.userAgent ? { userAgent: actor.userAgent } : {}),
  ...(actor.requestId ? { requestId: actor.requestId } : {}),
});

export const createAdminService = (
  { repository = getDefaultRepository() }: { repository?: AdminRepository } = {},
) => ({
  async listAccounts(limit: number, nextToken: string | undefined, actor: AdminActor) {
    const result = await repository.listAccounts(limit, nextToken);
    await repository.tryWriteAudit(auditRecord(actor, {
      action: 'ADMIN_LIST_ACCOUNTS', targetType: 'AccountCollection', targetId: 'all',
      outcome: 'success', metadata: { returned: result.items.length },
    }));

    return result;
  },

  async getAccount(accountId: string, actor: AdminActor) {
    const account = await repository.getAccount(accountId);
    if (!account) throw new NotFoundError('Account not found');
    await repository.tryWriteAudit(auditRecord(actor, {
      accountId, action: 'ADMIN_READ_ACCOUNT', targetType: 'Account', targetId: accountId,
      outcome: 'success',
    }));

    return account;
  },

  async impersonate(accountId: string, actor: AdminActor) {
    const account = await repository.getAccount(accountId);
    if (!account) {
      await repository.tryWriteAudit(auditRecord(actor, {
        accountId, action: 'ADMIN_IMPERSONATE', targetType: 'Account', targetId: accountId,
        outcome: 'failure', metadata: { reason: 'not_found' },
      }));
      throw new NotFoundError('Account not found');
    }
    if (account.status !== 'active') {
      await repository.tryWriteAudit(auditRecord(actor, {
        accountId, action: 'ADMIN_IMPERSONATE', targetType: 'Account', targetId: accountId,
        outcome: 'failure', metadata: { reason: 'account_disabled' },
      }));
      throw new ForbiddenError('Disabled accounts cannot be impersonated');
    }

    const accessToken = await signImpersonationToken({
      userId: actor.userId,
      accountId,
      email: actor.email,
      sessionId: actor.sessionId,
    });
    await repository.writeAudit(auditRecord(actor, {
      accountId,
      action: 'ADMIN_IMPERSONATE',
      targetType: 'Account',
      targetId: accountId,
      outcome: 'success',
      metadata: { expiresIn: 1800, readOnly: true },
    }));

    return { accessToken, tokenType: 'Bearer' as const, expiresIn: 1800, accountId, readOnly: true };
  },

  async listAudit(input: { accountId: string; from?: string; to?: string; action?: string; limit?: number; nextToken?: string }, actor: AdminActor) {
    const result = await repository.listAudit(input);
    await repository.tryWriteAudit(auditRecord(actor, {
      accountId: input.accountId,
      action: 'ADMIN_READ_AUDIT',
      targetType: 'AuditLog',
      targetId: input.accountId,
      outcome: 'success',
      metadata: { returned: result.items.length },
    }));

    return result;
  },

  async health() {
    return repository.health();
  },

  async disableAccount(accountId: string, actor: AdminActor) {
    const account = await repository.disableAccount(accountId);
    if (!account) {
      await repository.tryWriteAudit(auditRecord(actor, {
        accountId, action: 'ADMIN_DISABLE_ACCOUNT', targetType: 'Account', targetId: accountId,
        outcome: 'failure', metadata: { reason: 'not_found' },
      }));
      throw new NotFoundError('Account not found');
    }
    await repository.tryWriteAudit(auditRecord(actor, {
      accountId,
      action: 'ADMIN_DISABLE_ACCOUNT',
      targetType: 'Account',
      targetId: accountId,
      outcome: 'success',
      metadata: { sessionsRevoked: true },
    }));

    return account;
  },
});

export const adminService = createAdminService();