const requireValue = (label: string, value: string): string => {
  if (!value.trim() || value.includes('#')) {
    throw new Error(`${label} must be a non-empty value without "#".`);
  }

  return value;
};

export const pk = {
  account: (accountId: string): string => `ACCOUNT#${requireValue('accountId', accountId)}`,
  audit: (accountId: string): string => `AUDIT#${requireValue('accountId', accountId)}`,
  session: (userId: string): string => `SESSION#${requireValue('userId', userId)}`,
  otp: (userId: string): string => `OTP#${requireValue('userId', userId)}`,
  system: (): string => 'SYSTEM',
};

export const sk = {
  meta: (): string => 'META',
  user: (id: string): string => `USER#${requireValue('userId', id)}`,
  property: (id: string): string => `PROPERTY#${requireValue('propertyId', id)}`,
  tenant: (id: string): string => `TENANT#${requireValue('tenantId', id)}`,
  lease: (id: string): string => `LEASE#${requireValue('leaseId', id)}`,
  payment: (id: string): string => `PAYMENT#${requireValue('paymentId', id)}`,
  document: (id: string): string => `DOC#${requireValue('documentId', id)}`,
  ticket: (id: string): string => `TICKET#${requireValue('ticketId', id)}`,
  job: (id: string): string => `JOB#${requireValue('jobId', id)}`,
  summary: (yyyyMm: string): string => `SUMMARY#${requireValue('yyyyMm', yyyyMm)}`,
  counterQuittance: (): string => 'COUNTER#quittance',
  counterWhatsapp: (yyyyMm: string): string => `COUNTER#whatsapp#${requireValue('yyyyMm', yyyyMm)}`,
  tenantLeaseLink: (tenantId: string, leaseId: string): string =>
    `LINK#TENANT#${requireValue('tenantId', tenantId)}#LEASE#${requireValue('leaseId', leaseId)}`,
  idempotency: (key: string): string => `IDEMPOTENCY#${requireValue('idempotencyKey', key)}`,
  processed: (eventId: string): string => `PROCESSED#${requireValue('eventId', eventId)}`,
  active: (): string => 'ACTIVE',
  usedRefreshToken: (tokenHash: string): string => `USED#${requireValue('tokenHash', tokenHash)}`,
  otpPurpose: (purpose: string): string => requireValue('purpose', purpose),
  auditEntry: (iso: string, id: string): string =>
    `${requireValue('timestamp', iso)}#${requireValue('auditId', id)}`,
};

export const gsi1 = {
  property: (accountId: string, propertyId: string): string =>
    `${pk.account(accountId)}#PROPERTY#${requireValue('propertyId', propertyId)}`,
  lease: (accountId: string, leaseId: string): string =>
    `${pk.account(accountId)}#LEASE#${requireValue('leaseId', leaseId)}`,
  tenant: (accountId: string, tenantId: string): string =>
    `${pk.account(accountId)}#TENANT#${requireValue('tenantId', tenantId)}`,
  tenantDirectory: (accountId: string): string => `${pk.account(accountId)}#ACCOUNT#${requireValue('accountId', accountId)}`,
};

export const gsi2 = {
  status: (accountId: string, status: string): string =>
    `${pk.account(accountId)}#STATUS#${requireValue('status', status)}`,
  email: (accountId: string, email: string): string =>
    `${pk.account(accountId)}#EMAIL#${requireValue('email', email.trim().toLowerCase())}`,
};
