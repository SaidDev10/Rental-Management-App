export const documentTypes = [
  'lease',
  'quittance',
  'fiche_police',
  'etat_des_lieux',
  'invoice',
  'id_document',
  'other',
] as const;

export const linkedEntityTypes = ['Lease', 'Payment', 'Tenant', 'Property', 'MaintenanceTicket'] as const;

export type DocumentType = (typeof documentTypes)[number];
export type LinkedEntityType = (typeof linkedEntityTypes)[number];
export type DocumentContentType = 'image/jpeg' | 'image/png' | 'image/webp';

export type Document = {
  id: string;
  accountId: string;
  documentType: DocumentType;
  s3Bucket: string;
  s3Key: string;
  mimeType: DocumentContentType;
  sizeBytes: number;
  checksumSha256: string | null;
  linkedEntityType: LinkedEntityType;
  linkedEntityId: string;
  generatedBy: 'upload';
  retentionClass: 'standard';
  createdAt: string;
  updatedAt: string;
};

export type CreateDocumentInput = Pick<
  Document,
  'id' | 'documentType' | 's3Bucket' | 's3Key' | 'mimeType' | 'sizeBytes' |
  'checksumSha256' | 'linkedEntityType' | 'linkedEntityId'
>;
