export type LeaseStatus = 'draft' | 'active' | 'terminated' | 'expired';
export type BillingFrequency = 'monthly' | 'quarterly';

export type LeaseIndexation = {
  enabled: boolean;
  ratePct?: number | undefined;
  effectiveFrom?: string | undefined;
};

export type Lease = {
  id: string;
  accountId: string;
  propertyId: string;
  tenantIds: string[];
  startDate: string;
  endDate: string;
  rentAmount: number;
  chargesAmount: number;
  depositAmount: number;
  paymentDayOfMonth: number;
  billingFrequency: BillingFrequency;
  indexation: LeaseIndexation;
  status: LeaseStatus;
  terminatedAt: string | null;
  terminationReason: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type CreateLeaseInput = Omit<
  Lease,
  'id' | 'accountId' | 'version' | 'createdAt' | 'updatedAt' | 'terminatedAt' | 'terminationReason'
>;

export type UpdateLeaseInput = {
  [Key in keyof Pick<
    Lease,
    | 'endDate'
    | 'rentAmount'
    | 'chargesAmount'
    | 'depositAmount'
    | 'paymentDayOfMonth'
    | 'billingFrequency'
    | 'indexation'
    | 'status'
  >]?: Pick<
    Lease,
    | 'endDate'
    | 'rentAmount'
    | 'chargesAmount'
    | 'depositAmount'
    | 'paymentDayOfMonth'
    | 'billingFrequency'
    | 'indexation'
    | 'status'
  >[Key] | undefined;
};

export type LeasePayment = {
  id: string;
  leaseId: string;
  propertyId: string;
  tenantId: string;
  periodStart: string;
  periodEnd: string;
  dueDate: string;
  amountDue: number;
  amountPaid: number;
  paymentMethod: 'cash' | 'bank_transfer' | 'cheque' | 'other' | null;
  paidAt: string | null;
  status: 'due' | 'partial' | 'paid' | 'late' | 'cancelled';
  quittanceNumber: number | null;
  quittanceDocId: string | null;
  version: number;
};

export type LeaseDetail = Lease & {
  property: {
    id: string;
    label: string;
    address: {
      line1: string;
      line2?: string | undefined;
      city: string;
      postalCode?: string | undefined;
      country: 'MA';
    };
  };
  tenants: Array<{
    id: string;
    firstName: string;
    lastName: string;
    email: string;
    phone: string;
  }>;
  nextPayment: LeasePayment | null;
};
