export type TenantAddress = {
  line1: string;
  line2?: string | undefined;
  city: string;
  postalCode?: string | undefined;
  country: 'MA';
};

export type TenantIdDocumentType = 'CIN' | 'passport';

export type TenantIdDocument = {
  type: TenantIdDocumentType;
  numberEnc: string;
  last4: string;
  issuedAt?: string | undefined;
  expiresAt?: string | undefined;
  fileKey?: string | undefined;
};

export type Tenant = {
  id: string;
  accountId: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  dateOfBirth: string | null;
  address: TenantAddress | null;
  idDocumentType: TenantIdDocumentType | null;
  idDocumentLast4: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type TenantLeaseSummary = {
  id: string;
  propertyId: string;
  startDate: string;
  endDate: string;
  status: 'draft' | 'active' | 'terminated' | 'expired';
};

export type TenantDetail = Tenant & {
  activeLeases: TenantLeaseSummary[];
};

export type TenantIdDocumentInput = {
  type: TenantIdDocumentType;
  number: string;
  issuedAt?: string | undefined;
  expiresAt?: string | undefined;
  fileKey?: string | undefined;
};

export type CreateTenantInput = {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  dateOfBirth: string | null;
  address: TenantAddress | null;
};

export type UpdateTenantInput = {
  [Key in keyof CreateTenantInput]?: CreateTenantInput[Key] | undefined;
};