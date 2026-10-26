import { ulid } from 'ulid';

import { AppError, NotFoundError } from '../../shared/errors';
import { decodeCursor } from '../../shared/db/pagination';
import { propertyService } from '../property';
import { tenantService } from '../tenant';
import { createLeaseRepository, type LeaseListOptions, type LeaseRecord, type LeaseRepository } from './repository';
import { addLeaseDays, addLeaseMonths, generatePaymentSchedule, validateLeaseInput } from './validators';
import type { CreateLeaseInput, Lease, LeaseDetail, LeasePayment, UpdateLeaseInput } from './types';

const localLeases = new Map<string, Map<string, LeaseRecord>>();
const localPayments = new Map<string, Map<string, LeasePayment>>();
const localIdempotency = new Map<string, Map<string, { requestHash: string; leaseId: string }>>();

const localMode = (): boolean =>
  process.env.STAGE !== 'prod' && process.env.USE_DYNAMO_AUTH === 'false';

const requestHashFor = (input: CreateLeaseInput): string => JSON.stringify(input);

const localRepositoryFor = (accountId: string): LeaseRepository => {
  const leases = localLeases.get(accountId) ?? new Map<string, LeaseRecord>();
  const payments = localPayments.get(accountId) ?? new Map<string, LeasePayment>();
  const idempotency = localIdempotency.get(accountId) ?? new Map<string, { requestHash: string; leaseId: string }>();
  localLeases.set(accountId, leases);
  localPayments.set(accountId, payments);
  localIdempotency.set(accountId, idempotency);

  const generateRecord = (input: CreateLeaseInput, id: string, idempotencyKey: string): LeaseRecord => {
    const now = new Date().toISOString();

    return {
      ...input,
      id,
      accountId,
      PK: `ACCOUNT#${accountId}`,
      SK: `LEASE#${id}`,
      entityType: 'Lease',
      schemaVersion: 1,
      GSI1PK: `ACCOUNT#${accountId}#PROPERTY#${input.propertyId}`,
      GSI1SK: `LEASE#${input.startDate}#${id}`,
      GSI2PK: `ACCOUNT#${accountId}#STATUS#${input.status}`,
      GSI2SK: `${input.startDate}#${id}`,
      idempotencyKeyHash: idempotencyKey,
      requestHash: requestHashFor(input),
      terminatedAt: null,
      terminationReason: null,
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
  };

  const ensureSchedule = async (lease: LeaseRecord): Promise<LeasePayment[]> => {
    const schedule = generatePaymentSchedule(lease);
    for (const payment of schedule) {
      if (!payments.has(payment.id)) {
        payments.set(payment.id, payment);
      }
    }

    return schedule;
  };

  return {
    async list({ limit, cursor, status, propertyId, tenantId }: LeaseListOptions) {
      const all = [...leases.values()]
        .filter(
          (lease) =>
            (!status || lease.status === status) &&
            (!propertyId || lease.propertyId === propertyId) &&
            (!tenantId || lease.tenantIds.includes(tenantId)),
        )
        .sort((left, right) => left.GSI1SK.localeCompare(right.GSI1SK));
      let cursorIndex = -1;
      if (cursor) {
        cursorIndex = all.findIndex((lease) => lease.PK === cursor.PK && lease.SK === cursor.SK);
        if (
          cursor.PK !== `ACCOUNT#${accountId}` ||
          typeof cursor.SK !== 'string' ||
          !cursor.SK.startsWith('LEASE#') ||
          cursorIndex < 0
        ) {
          throw new AppError('Invalid lease pagination cursor.', 400, 'VALIDATION_ERROR');
        }
      }
      const startIndex = cursorIndex + 1;
      const items = all.slice(startIndex, startIndex + limit);
      const last = items.at(-1);

      return {
        items,
        nextCursor:
          last && startIndex + items.length < all.length
            ? { PK: last.PK, SK: last.SK }
            : undefined,
      };
    },
    async getById(leaseId) {
      const lease = leases.get(leaseId);

      return lease?.accountId === accountId ? lease : undefined;
    },
    async create(input, idempotencyKey) {
      const existing = idempotency.get(idempotencyKey);
      if (existing) {
        if (existing.requestHash !== requestHashFor(input)) {
          throw new AppError('Idempotency key was already used for another request.', 409, 'IDEMPOTENCY_KEY_REUSED');
        }
        const existingLease = leases.get(existing.leaseId);
        if (existingLease) {
          await ensureSchedule(existingLease);

          return existingLease;
        }
      }
      const id = ulid();
      const lease = generateRecord(input, id, idempotencyKey);
      leases.set(id, lease);
      idempotency.set(idempotencyKey, { requestHash: requestHashFor(input), leaseId: id });
      await ensureSchedule(lease);

      return lease;
    },
    async renew({ leaseId, expectedVersion, input, idempotencyKey }) {
      const current = leases.get(leaseId);
      if (!current) {
        throw new NotFoundError('Lease not found');
      }
      const requestHash = requestHashFor(input);
      const existing = idempotency.get(idempotencyKey);
      if (existing) {
        if (existing.requestHash !== requestHash) {
          throw new AppError('Idempotency key was already used for another request.', 409, 'IDEMPOTENCY_KEY_REUSED');
        }
        const successor = leases.get(existing.leaseId);
        if (successor) {
          if (current.status === 'active' && current.version === expectedVersion) {
            leases.set(leaseId, {
              ...current,
              status: 'expired',
              GSI2PK: `ACCOUNT#${accountId}#STATUS#expired`,
              version: current.version + 1,
              updatedAt: new Date().toISOString(),
            });
            tenantService.updateLocalLeaseStatus(accountId, leaseId, 'expired');
            propertyService.updateLocalLeaseStatus(accountId, leaseId, 'expired');
          }
          tenantService.recordLocalLeaseLinks(accountId, successor);
          propertyService.recordLocalLeaseLink(accountId, successor);
          await ensureSchedule(successor);

          return successor;
        }
      }
      if (current.status !== 'active' || current.version !== expectedVersion) {
        throw new AppError('Lease version does not match or lease cannot be renewed.', 409, 'LEASE_STATE_CONFLICT');
      }
      if (input.tenantIds.length > 98) {
        throw new AppError('A renewal can include at most 98 tenants.', 400, 'VALIDATION_ERROR');
      }
      const successor = generateRecord(input, ulid(), idempotencyKey);
      leases.set(leaseId, {
        ...current,
        status: 'expired',
        GSI2PK: `ACCOUNT#${accountId}#STATUS#expired`,
        version: current.version + 1,
        updatedAt: new Date().toISOString(),
      });
      tenantService.updateLocalLeaseStatus(accountId, leaseId, 'expired');
      propertyService.updateLocalLeaseStatus(accountId, leaseId, 'expired');
      leases.set(successor.id, successor);
      tenantService.recordLocalLeaseLinks(accountId, successor);
      propertyService.recordLocalLeaseLink(accountId, successor);
      idempotency.set(idempotencyKey, { requestHash, leaseId: successor.id });
      await ensureSchedule(successor);

      return successor;
    },
    ensurePaymentSchedule: ensureSchedule,
    async getPayments(leaseId) {
      return [...payments.values()]
        .filter((payment) => payment.leaseId === leaseId)
        .sort((left, right) => left.dueDate.localeCompare(right.dueDate));
    },
    async update(leaseId, expectedVersion, input) {
      const current = leases.get(leaseId);
      if (!current || current.version !== expectedVersion) {
        throw new AppError('Lease version does not match or lease is unavailable.', 409, 'CONFLICT_VERSION_MISMATCH');
      }
      const updated = {
        ...current,
        ...input,
        GSI1SK: `LEASE#${current.startDate}#${leaseId}`,
        GSI2PK: `ACCOUNT#${accountId}#STATUS#${input.status ?? current.status}`,
        GSI2SK: `${current.startDate}#${leaseId}`,
        version: current.version + 1,
        updatedAt: new Date().toISOString(),
      } as LeaseRecord;
      leases.set(leaseId, updated);
      if (input.status !== undefined) {
        tenantService.updateLocalLeaseStatus(accountId, leaseId, input.status);
        propertyService.updateLocalLeaseStatus(accountId, leaseId, input.status);
      }

      const expectedPayments = generatePaymentSchedule(updated);
      const expectedIds = new Set(expectedPayments.map((payment) => payment.id));
      const currentPayments = await this.getPayments(leaseId);
      for (const expected of expectedPayments) {
        const currentPayment = payments.get(expected.id);
        if (!currentPayment) {
          payments.set(expected.id, expected);
        } else if (currentPayment.status === 'due') {
          payments.set(expected.id, {
            ...currentPayment,
            amountDue: expected.amountDue,
            dueDate: expected.dueDate,
            periodEnd: expected.periodEnd,
            version: currentPayment.version + 1,
          });
        }
      }
      for (const payment of currentPayments) {
        if (payment.status === 'due' && !expectedIds.has(payment.id)) {
          payments.set(payment.id, { ...payment, status: 'cancelled', version: payment.version + 1 });
        }
      }

      return updated;
    },
    async terminate(leaseId, expectedVersion, terminatedAt, reason) {
      const current = leases.get(leaseId);
      if (
        current?.status === 'terminated' &&
        current.version === expectedVersion + 1 &&
        current.terminatedAt === terminatedAt &&
        current.terminationReason === reason
      ) {
        for (const payment of await this.getPayments(leaseId)) {
          if (payment.status === 'due' && payment.dueDate > terminatedAt.slice(0, 10)) {
            payments.set(payment.id, { ...payment, status: 'cancelled', version: payment.version + 1 });
          }
        }
        tenantService.updateLocalLeaseStatus(accountId, leaseId, 'terminated');
        propertyService.updateLocalLeaseStatus(accountId, leaseId, 'terminated');

        return current;
      }
      if (!current || current.version !== expectedVersion || !['active', 'draft'].includes(current.status)) {
        throw new AppError('Lease version does not match or lease cannot be terminated.', 409, 'LEASE_STATE_CONFLICT');
      }
      const updated: LeaseRecord = {
        ...current,
        status: 'terminated',
        GSI2PK: `ACCOUNT#${accountId}#STATUS#terminated`,
        terminatedAt,
        terminationReason: reason,
        version: current.version + 1,
        updatedAt: new Date().toISOString(),
      };
      leases.set(leaseId, updated);
      tenantService.updateLocalLeaseStatus(accountId, leaseId, 'terminated');
      propertyService.updateLocalLeaseStatus(accountId, leaseId, 'terminated');
      for (const payment of await this.getPayments(leaseId)) {
        if (payment.status === 'due' && payment.dueDate > terminatedAt.slice(0, 10)) {
          payments.set(payment.id, { ...payment, status: 'cancelled', version: payment.version + 1 });
        }
      }

      return updated;
    },
  };
};

const repositoryFor = (accountId: string): LeaseRepository =>
  localMode() ? localRepositoryFor(accountId) : createLeaseRepository({ accountId });

const toLease = (record: LeaseRecord): Lease => {
  return {
    id: record.id,
    accountId: record.accountId,
    propertyId: record.propertyId,
    tenantIds: record.tenantIds,
    startDate: record.startDate,
    endDate: record.endDate,
    rentAmount: record.rentAmount,
    chargesAmount: record.chargesAmount,
    depositAmount: record.depositAmount,
    paymentDayOfMonth: record.paymentDayOfMonth,
    billingFrequency: record.billingFrequency,
    indexation: record.indexation,
    status: record.status,
    terminatedAt: record.terminatedAt,
    terminationReason: record.terminationReason,
    version: record.version,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
};

export const leaseService = {
  async list(
    accountId: string,
    options: LeaseListOptions,
    repository = repositoryFor(accountId),
  ): Promise<{ items: Lease[]; nextCursor?: Record<string, unknown> | undefined }> {
    const page = await repository.list(options);

    return { items: page.items.map(toLease), ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
  },

  async get(
    accountId: string,
    leaseId: string,
    repository = repositoryFor(accountId),
  ): Promise<LeaseDetail> {
    const record = await repository.getById(leaseId);
    if (!record) {
      throw new NotFoundError('Lease not found');
    }

    const [property, tenants, payments] = await Promise.all([
      propertyService.get(accountId, record.propertyId),
      tenantService.getManyById(accountId, record.tenantIds),
      repository.getPayments(leaseId),
    ]);
    const nextPayment =
      payments.find((payment) => payment.status === 'due' || payment.status === 'partial') ?? null;

    return {
      ...toLease(record),
      property: {
        id: property.id,
        label: property.label,
        address: property.address,
      },
      tenants: tenants.map(({ id, firstName, lastName, email, phone }) => ({
        id,
        firstName,
        lastName,
        email,
        phone,
      })),
      nextPayment,
    };
  },

  async create(
    accountId: string,
    input: CreateLeaseInput,
    idempotencyKey: string,
    repository = repositoryFor(accountId),
  ): Promise<Lease> {
    validateLeaseInput(input);
    const property = await propertyService.get(accountId, input.propertyId);
    if (property.status !== 'active') {
      throw new AppError('Cannot create a lease for an inactive property.', 409, 'PROPERTY_INACTIVE');
    }
    await tenantService.getManyById(accountId, input.tenantIds);

    const lease = await repository.create(input, idempotencyKey);
    tenantService.recordLocalLeaseLinks(accountId, lease);
    propertyService.recordLocalLeaseLink(accountId, lease);

    return toLease(lease);
  },

  async update(
    accountId: string,
    leaseId: string,
    expectedVersion: number,
    input: UpdateLeaseInput,
    repository = repositoryFor(accountId),
  ): Promise<Lease> {
    const current = await repository.getById(leaseId);
    if (!current) {
      throw new NotFoundError('Lease not found');
    }
    if (current.status === 'terminated' || current.status === 'expired') {
      throw new AppError('A completed lease cannot be updated.', 409, 'LEASE_STATE_CONFLICT');
    }
    if (input.endDate) {
      const candidate = { ...current, ...input } as CreateLeaseInput;
      validateLeaseInput(candidate);
    }
    if (input.status && input.status !== current.status && !(current.status === 'draft' && input.status === 'active')) {
      throw new AppError('Invalid lease status transition.', 409, 'LEASE_STATE_CONFLICT');
    }

    return toLease(await repository.update(leaseId, expectedVersion, input));
  },

  async terminate(
    accountId: string,
    leaseId: string,
    expectedVersion: number,
    terminatedAt: string,
    reason: string,
    repository = repositoryFor(accountId),
  ): Promise<Lease> {
    const current = await repository.getById(leaseId);
    if (!current) {
      throw new NotFoundError('Lease not found');
    }
    if (terminatedAt < current.startDate || terminatedAt > current.endDate) {
      throw new AppError('Termination date must fall within the lease term.', 400, 'VALIDATION_ERROR');
    }

    return toLease(await repository.terminate(leaseId, expectedVersion, terminatedAt, reason));
  },

  async schedule(
    accountId: string,
    leaseId: string,
    repository = repositoryFor(accountId),
  ): Promise<LeasePayment[]> {
    const lease = await repository.getById(leaseId);
    if (!lease) {
      throw new NotFoundError('Lease not found');
    }

    return repository.getPayments(leaseId);
  },

  async renew(
    accountId: string,
    leaseId: string,
    expectedVersion: number,
    input: { startDate?: string | undefined; endDate?: string | undefined },
    idempotencyKey: string,
    repository = repositoryFor(accountId),
  ): Promise<Lease> {
    const current = await repository.getById(leaseId);
    if (!current) {
      throw new NotFoundError('Lease not found');
    }
    const completedRenewalRetry = current.status === 'expired' && current.version === expectedVersion + 1;
    if (
      (!completedRenewalRetry && current.status !== 'active') ||
      (current.version !== expectedVersion && !completedRenewalRetry)
    ) {
      throw new AppError('Only the current active lease version can be renewed.', 409, 'LEASE_STATE_CONFLICT');
    }
    const startDate = input.startDate ?? addLeaseDays(current.endDate, 1);
    const endDate = input.endDate ?? addLeaseMonths(startDate, 12);
    if (startDate <= current.endDate) {
      throw new AppError('A renewal must begin after the current lease ends.', 400, 'LEASE_RENEWAL_DATE_INVALID');
    }
    const nextInput: CreateLeaseInput = {
      propertyId: current.propertyId,
      tenantIds: current.tenantIds,
      startDate,
      endDate,
      rentAmount: current.rentAmount,
      chargesAmount: current.chargesAmount,
      depositAmount: current.depositAmount,
      paymentDayOfMonth: current.paymentDayOfMonth,
      billingFrequency: current.billingFrequency,
      indexation: current.indexation,
      status: 'active',
    };
    validateLeaseInput(nextInput);
    await tenantService.getManyById(accountId, nextInput.tenantIds);
    const successor = await repository.renew({
      leaseId,
      expectedVersion,
      input: nextInput,
      idempotencyKey,
    });
    tenantService.recordLocalLeaseLinks(accountId, successor);
    tenantService.updateLocalLeaseStatus(accountId, leaseId, 'expired');
    propertyService.recordLocalLeaseLink(accountId, successor);
    propertyService.updateLocalLeaseStatus(accountId, leaseId, 'expired');

    return toLease(successor);
  },
};

export { decodeCursor };
