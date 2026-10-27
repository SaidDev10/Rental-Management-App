import { describe, expect, it } from 'vitest';

import { sk } from '../../src/shared/db/keys';
import type { WorkerEntity } from '../../src/shared/db/worker-data';
import type { PdfJobPayload } from '../../src/workers/payloads';
import { buildPdfContext, renderPdfHtml } from '../../src/workers/processors/pdf-documents';

const accountId = 'account-1';
const now = new Date('2026-10-27T10:00:00.000Z');
const records: WorkerEntity[] = [
  { PK: 'ACCOUNT#account-1', SK: 'META', accountId, entityType: 'Account', locale: 'fr' },
  { PK: 'ACCOUNT#account-1', SK: sk.lease('lease-1'), accountId, entityType: 'Lease', id: 'lease-1', propertyId: 'property-1', tenantIds: ['tenant-1'], startDate: '2026-01-01', endDate: '2026-12-31', rentAmount: 125000, chargesAmount: 12500, depositAmount: 250000, paymentDayOfMonth: 5, billingFrequency: 'monthly', indexation: { enabled: true, ratePct: 3, effectiveFrom: '2027-01-01' }, status: 'active' },
  { PK: 'ACCOUNT#account-1', SK: sk.property('property-1'), accountId, entityType: 'Property', label: 'Appartement Centre', address: { line1: '10 rue Test', line2: 'Appt 2', city: 'Rabat', postalCode: '10000', country: 'MA' }, propertyType: 'apartment', areaSqm: 82, rooms: 3 },
  { PK: 'ACCOUNT#account-1', SK: sk.payment('payment-1'), accountId, entityType: 'Payment', leaseId: 'lease-1', propertyId: 'property-1', tenantId: 'tenant-1', periodStart: '2026-10-01', periodEnd: '2026-10-31', amountDue: 137500, amountPaid: 137500, status: 'paid' },
  { PK: 'ACCOUNT#account-1', SK: sk.tenant('tenant-1'), accountId, entityType: 'Tenant', firstName: 'Amina', lastName: '<script>alert(1)</script>', email: 'amina@example.test', phone: '+212600000000', dateOfBirth: '1990-04-02', address: { line1: '2 rue Test', city: 'Rabat', country: 'MA' }, idDocumentType: 'CIN', idDocumentLast4: '1234' },
];
const load = async (_account: string, key: string): Promise<WorkerEntity | undefined> => records.find((item) => item.SK === key);
const base = { jobId: 'job-1', accountId };
const payload = <T extends PdfJobPayload>(value: T): T => value;
const render = (documentType: 'LEASE' | 'FICHE_POLICE' | 'ETAT_DES_LIEUX', extra: { kind?: 'entree' | 'sortie' } = {}) =>
  buildPdfContext(payload({ ...base, documentType, leaseId: 'lease-1', ...extra } as PdfJobPayload), now, load);

const allText = (context: Awaited<ReturnType<typeof buildPdfContext>>): string =>
  context.sections.flatMap((section) => [section.title, ...section.values.flatMap((entry) => [entry.label, entry.value])]).join(' ');

describe('PDF document payloads and rendered HTML', () => {
  it('builds a lease agreement from lease, property, and tenant data', async () => {
    const context = await render('LEASE');
    const output = allText(context);
    expect(context.title).toBe('Contrat de bail');
    expect(output).toContain('Appartement Centre');
    expect(output).toContain('10 rue Test, Appt 2, Rabat, 10000, MA');
    expect(output).toContain('Amina <script>alert(1)</script>');
    expect(output).toContain('1250.00 MAD');
    expect(output).toContain('125.00 MAD');
    expect(output).toContain('2500.00 MAD');
    expect(output).toContain('3% / 2027-01-01');
    const html = renderPdfHtml(context);
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>alert(1)</script>');
  });

  it('builds the police sheet from available tenant identity data without exposing a full ID', async () => {
    const context = await render('FICHE_POLICE');
    const output = allText(context);
    expect(output).toContain('1990-04-02');
    expect(output).toContain('CIN');
    expect(output).toContain('1234');
    expect(output).toContain('2 rue Test, Rabat, MA');
  });

  it('builds distinct entry and exit condition reports with printable checklist and signatures', async () => {
    const entry = await render('ETAT_DES_LIEUX', { kind: 'entree' });
    const exit = await render('ETAT_DES_LIEUX', { kind: 'sortie' });
    expect(entry.title).toContain('entr\u00e9e');
    expect(exit.title).toContain('sortie');
    expect(allText(entry)).toContain('Porte d\u2019entr\u00e9e: ____________________');
    expect(allText(exit)).toContain('Signatures');
    expect(renderPdfHtml(exit)).toContain('Appartement Centre');
  });

  it('keeps the existing quittance payload backed by payment, lease, property, and tenant data', async () => {
    const context = await buildPdfContext(payload({ ...base, documentType: 'QUITTANCE', paymentId: 'payment-1' } as PdfJobPayload), now, load);
    const output = allText(context);
    expect(context.title).toBe('Quittance de loyer');
    expect(output).toContain('Amina <script>alert(1)</script>');
    expect(output).toContain('Appartement Centre');
    expect(output).toContain('1375.00 MAD');
    expect(output).toContain('2026-10-01 – 2026-10-31');
  });});
