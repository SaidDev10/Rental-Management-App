import { sk } from '../../shared/db/keys';
import { getWorkerData, type WorkerEntity } from '../../shared/db/worker-data';
import type { PdfJobPayload } from '../payloads';
import { NonRetryableWorkerError } from '../job-processor';
import Handlebars from 'handlebars';

export type RenderContext = {
  title: string;
  locale: 'fr' | 'en';
  documentType: string;
  generatedAt: string;
  sections: Array<{ title: string; values: Array<{ label: string; value: string }> }>;
};
type LabelKey = 'QUITTANCE' | 'LEASE' | 'FICHE_POLICE' | 'ETAT_DES_LIEUX' | 'generated' | 'property' | 'tenant' | 'lease' | 'payment' | 'address' | 'propertyType' | 'area' | 'rooms' | 'period' | 'rent' | 'charges' | 'deposit' | 'paymentDay' | 'frequency' | 'indexation' | 'status' | 'email' | 'phone' | 'birthDate' | 'identity' | 'due' | 'paid' | 'inspection' | 'condition' | 'notes' | 'signature';
type Loader = (accountId: string, key: string) => Promise<WorkerEntity | undefined>;
type Row = { label: string; value: string };
const labels: Record<'fr' | 'en', Record<LabelKey, string>> = {
  fr: {
    QUITTANCE: 'Quittance de loyer', LEASE: 'Contrat de bail', FICHE_POLICE: 'Fiche de police',
    ETAT_DES_LIEUX: '\u00c9tat des lieux', generated: 'G\u00e9n\u00e9r\u00e9 le', property: 'Bien', tenant: 'Locataire',
    lease: 'Bail', payment: 'Paiement', address: 'Adresse', propertyType: 'Type de bien', area: 'Surface (m\u00b2)',
    rooms: 'Nombre de pi\u00e8ces', period: 'P\u00e9riode', rent: 'Loyer mensuel', charges: 'Charges',
    deposit: 'D\u00e9p\u00f4t de garantie', paymentDay: 'Jour de paiement', frequency: 'Fr\u00e9quence de paiement',
    indexation: 'Indexation', status: 'Statut', email: 'E-mail', phone: 'T\u00e9l\u00e9phone',
    birthDate: 'Date de naissance', identity: 'Pi\u00e8ce d\u2019identit\u00e9 (4 derniers caract\u00e8res)',
    due: 'Montant d\u00fb', paid: 'Montant pay\u00e9', inspection: 'Points de contr\u00f4le',
    condition: '\u00c9tat constat\u00e9', notes: 'Observations', signature: 'Signatures',
  },
  en: {
    QUITTANCE: 'Rent receipt', LEASE: 'Lease agreement', FICHE_POLICE: 'Police information sheet',
    ETAT_DES_LIEUX: 'Property condition report', generated: 'Generated on', property: 'Property',
    tenant: 'Tenant', lease: 'Lease', payment: 'Payment', address: 'Address', propertyType: 'Property type',
    area: 'Area (m\u00b2)', rooms: 'Number of rooms', period: 'Period', rent: 'Monthly rent', charges: 'Charges',
    deposit: 'Security deposit', paymentDay: 'Payment day', frequency: 'Payment frequency', indexation: 'Indexation',
    status: 'Status', email: 'Email', phone: 'Phone', birthDate: 'Date of birth',
    identity: 'Identity document (last four characters)', due: 'Amount due', paid: 'Amount paid',
    inspection: 'Inspection checklist', condition: 'Condition observed', notes: 'Observations', signature: 'Signatures',
  },
};
const htmlTemplate = Handlebars.compile(`<!doctype html><html lang="{{locale}}"><head><meta charset="utf-8"><style>
@page { size: A4; margin: 22mm 18mm; } body { color:#202a35; font:12px Arial,sans-serif; }
h1 { border-bottom:2px solid #2563eb; padding-bottom:12px; } h2 { color:#334155; font-size:14px; margin-top:24px; }
.meta { color:#64748b; font-size:10px; } .row { display:flex; border-bottom:1px solid #e2e8f0; padding:7px 0; break-inside:avoid; }
.label { color:#64748b; width:38%; } .value { font-weight:600; }
</style></head><body><h1>{{title}}</h1><p class="meta">{{generatedLabel}}: {{generatedAt}}</p>
{{#each sections}}<h2>{{title}}</h2>{{#each values}}<div class="row"><span class="label">{{label}}</span><span class="value">{{value}}</span></div>{{/each}}{{/each}}
</body></html>`);
const text = (value: unknown): string => typeof value === 'string' || typeof value === 'number' ? String(value) : '\u2014';
export const formatMoney = (value: unknown): string => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) return '\u2014';
  const amount = Math.abs(value);

  return `${value < 0 ? '-' : ''}${Math.floor(amount / 100)}.${String(amount % 100).padStart(2, '0')} MAD`;
};
const row = (label: string, value: unknown): Row => ({ label, value: text(value) });
const moneyRow = (label: string, value: unknown): Row => ({ label, value: formatMoney(value) });
const address = (value: unknown): string => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '\u2014';
  const parts = value as Record<string, unknown>;

  return [parts.line1, parts.line2, parts.city, parts.postalCode, parts.country]
    .filter((part) => typeof part === 'string' && part.trim()).join(', ') || '\u2014';
};
const tenantName = (tenant: WorkerEntity): string => `${text(tenant.firstName)} ${text(tenant.lastName)}`;
const defaultLoader: Loader = async (accountId, key) => getWorkerData(accountId).get(key);

export const buildPdfContext = async (payload: PdfJobPayload, now: Date, load: Loader = defaultLoader): Promise<RenderContext> => {
  const account = await load(payload.accountId, sk.meta());
  const locale = account?.locale === 'en' ? 'en' : 'fr';
  const l = labels[locale];
  const sections: RenderContext['sections'] = [];
  const kind = 'kind' in payload ? payload.kind : undefined;
  if (payload.documentType === 'QUITTANCE') {
    const payment = await load(payload.accountId, sk.payment(payload.paymentId));
    if (!payment) throw new NonRetryableWorkerError('PAYMENT_NOT_FOUND', 'Payment record was not found.');
    const lease = await load(payload.accountId, sk.lease(text(payment.leaseId)));
    const tenant = await load(payload.accountId, sk.tenant(text(payment.tenantId)));
    const property = await load(payload.accountId, sk.property(text(payment.propertyId)));
    sections.push({ title: l.payment, values: [row(l.tenant, tenant ? tenantName(tenant) : '\u2014'),
      row(l.property, property?.label), row(l.lease, lease?.id ?? payment.leaseId),
      row(l.period, `${text(payment.periodStart)} \u2013 ${text(payment.periodEnd)}`),
      moneyRow(l.due, payment.amountDue), moneyRow(l.paid, payment.amountPaid), row(l.status, payment.status)] });
  } else {
    const leaseId = text(payload.leaseId);
    const lease = await load(payload.accountId, sk.lease(leaseId));
    if (!lease) throw new NonRetryableWorkerError('LEASE_NOT_FOUND', 'Lease record was not found.');
    const property = await load(payload.accountId, sk.property(text(lease.propertyId)));
    const tenantIds = Array.isArray(lease.tenantIds) ? lease.tenantIds : [];
    const tenants = (await Promise.all(tenantIds.map((id) => load(payload.accountId, sk.tenant(text(id)))))
      ).filter((tenant): tenant is WorkerEntity => tenant !== undefined);
    const propertyRows = [row(l.property, property?.label), row(l.address, address(property?.address)),
      row(l.propertyType, property?.propertyType), row(l.area, property?.areaSqm), row(l.rooms, property?.rooms)];
    const period = `${text(lease.startDate)} \u2013 ${text(lease.endDate)}`;
    const indexation = lease.indexation && typeof lease.indexation === 'object' ? lease.indexation as Record<string, unknown> : {};
    const leaseRows = [row(l.period, period), moneyRow(l.rent, lease.rentAmount), moneyRow(l.charges, lease.chargesAmount),
      moneyRow(l.deposit, lease.depositAmount), row(l.paymentDay, lease.paymentDayOfMonth), row(l.frequency, lease.billingFrequency),
      row(l.indexation, indexation.enabled === true ? `${text(indexation.ratePct)}% / ${text(indexation.effectiveFrom)}` : '\u2014'),
      row(l.status, lease.status)];
    if (payload.documentType === 'LEASE') {
      sections.push({ title: l.property, values: propertyRows });
      sections.push({ title: l.tenant, values: tenants.flatMap((tenant) => [row(l.tenant, tenantName(tenant)), row(l.email, tenant.email), row(l.phone, tenant.phone)]) });
      sections.push({ title: l.lease, values: leaseRows });
    } else if (payload.documentType === 'FICHE_POLICE') {
      sections.push({ title: l.property, values: propertyRows.slice(0, 2) });
      sections.push({ title: l.tenant, values: tenants.flatMap((tenant) => [row(l.tenant, tenantName(tenant)),
        row(l.birthDate, tenant.dateOfBirth), row(l.address, address(tenant.address)), row(l.phone, tenant.phone),
        row(l.email, tenant.email), row(l.identity, tenant.idDocumentLast4 ? `${text(tenant.idDocumentType)} \u2022\u2022\u2022\u2022${text(tenant.idDocumentLast4)}` : '\u2014')]) });
      sections.push({ title: l.lease, values: [row(l.period, period)] });
    } else {
      const checklist = locale === 'fr'
        ? ['Porte d\u2019entr\u00e9e', 'Murs et plafonds', 'Sols', 'Fen\u00eatres et vitrages', 'Installations \u00e9lectriques', 'Plomberie', '\u00c9quipements et mobilier']
        : ['Entrance door', 'Walls and ceilings', 'Floors', 'Windows and glazing', 'Electrical installations', 'Plumbing', 'Fixtures and furniture'];
      const inspectionRows = checklist.flatMap((item) => [row(l.condition, `${item}: ____________________`), row(l.notes, '________________________________________')]);
      sections.push({ title: l.property, values: propertyRows });
      sections.push({ title: l.tenant, values: tenants.map((tenant) => row(l.tenant, tenantName(tenant))) });
      sections.push({ title: l.lease, values: [row(l.period, period), row(l.status, kind === 'entree'
        ? (locale === 'fr' ? 'Entr\u00e9e' : 'Check-in') : (locale === 'fr' ? 'Sortie' : 'Check-out'))] });
      sections.push({ title: l.inspection, values: inspectionRows });
      sections.push({ title: l.signature, values: [row(l.tenant, '____________________'), row(l.signature, '____________________')] });
    }
  }
  const title = payload.documentType === 'ETAT_DES_LIEUX'
    ? `${l.ETAT_DES_LIEUX} \u2014 ${kind === 'entree' ? (locale === 'fr' ? 'entr\u00e9e' : 'check-in') : (locale === 'fr' ? 'sortie' : 'check-out')}`
    : text(l[payload.documentType]);

  return { title, locale, documentType: payload.documentType, generatedAt: now.toISOString(), sections };
};

export const renderPdfHtml = (context: RenderContext): string => htmlTemplate({
  ...context, generatedLabel: labels[context.locale].generated,
});
