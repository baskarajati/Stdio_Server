/**
 * Document wire projections for the three issue operations. SOL-25 revision
 * 24 requires the issue-only envelopes (`ProjectQuotationIssueResponse`,
 * `ProjectFinanceInvoiceIssueResponse`) with the full document object.
 *
 * Money fields are NUMBER-form on these documents, so every amount is a
 * `RawDecimal` emitted verbatim by `serializeJson` — never a JS `Number`.
 * `ProjectFinanceInvoice` money fields are non-nullable numbers; the finance
 * gate is the route capability (403), not field masking. The quotation wire
 * does carry the finance lens (D-007) with nullable money fields.
 */

import { moneyNumber, moneyWire, RawDecimal } from '../money';
import { dateLabel, moneyLabel, receivableComponentLabel, statusLabel } from '../projections';
import { minorFromDecimal, moneyText, wireNumber } from './projections';

/** The quotation rows the send operation reads. */
export type QuotationRow = {
  id: string;
  quotationNumber: string;
  title: string;
  clientId: string;
  projectId: string | null;
  engagementId: string | null;
  version: string;
  status: string;
  feeModel: string | null;
  currency: string;
  subtotalAmount: string | null;
  discountPercent: string | null;
  discountAmount: string | null;
  defaultRatePerSqm: string | null;
  totalAmount: string | null;
  lastAcceptedAt: Date | null;
  lastDeclinedAt: Date | null;
  entityVersion: string;
  updatedAt: Date;
};

export type QuotationItemRow = {
  id: string;
  lineType: string | null;
  description: string;
  quantity: string | null;
  unitRate: string | null;
  lineSubtotal: string | null;
  lineTotal: string | null;
};

export type QuotationMilestoneRow = {
  id: string;
  sortOrder: string;
  name: string;
  description: string | null;
  dueTrigger: string | null;
  percentage: string | null;
  amount: string | null;
};

export type QuotationSiblingRow = {
  id: string;
  quotationNumber: string;
  status: string;
  version: string;
};

/** The wire `ProjectQuotation`. */
export type QuotationWire = {
  canReadFinance: boolean;
  entityVersion: string;
  engagementId: string | null;
  defaultRatePerSqm: RawDecimal | null;
  defaultRatePerSqmLabel: string | null;
  discountAmount: RawDecimal | null;
  discountAmountLabel: string | null;
  discountPercent: number | null;
  feeItems: Array<Record<string, unknown>>;
  feeModel: string | null;
  id: string;
  projectId: string | null;
  items: Array<Record<string, unknown>>;
  paymentMilestones: Array<Record<string, unknown>>;
  quotationNumber: string;
  revision: {
    next: Array<Record<string, unknown>>;
    previous: Record<string, unknown> | null;
    version: number;
  };
  reviewState: {
    hasActiveLink: boolean;
    lastAcceptedAt: string | null;
    lastDeclinedAt: string | null;
  };
  status: string;
  sortKey: string;
  subtotalAmount: RawDecimal | null;
  subtotalAmountLabel: string | null;
  terms: unknown[];
  title: string;
  totalAmount: RawDecimal | null;
  totalAmountLabel: string | null;
  updatedAt: string;
};

/** The version-sort key: zero-padded version, updatedAt ISO, id. */
function quotationSortKey(row: QuotationRow): string {
  const padded = row.version.padStart(10, '0');
  return `${padded}|${row.updatedAt.toISOString()}|${row.id}`;
}

/** Projects one quotation plus its items, milestones and lineage. */
export function quotationWire(
  row: QuotationRow,
  items: QuotationItemRow[],
  milestones: QuotationMilestoneRow[],
  siblings: QuotationSiblingRow[],
  canReadFinance: boolean,
): QuotationWire {
  const currency = row.currency || 'IDR';
  const numberValue = (value: string | null | undefined): RawDecimal | null =>
    canReadFinance ? moneyNumber(value ?? null, currency) : null;
  const labelValue = (value: string | null | undefined): string | null =>
    canReadFinance ? moneyLabel(value ?? null, currency) : null;
  const plainNumber = (value: string | null | undefined): number | null => {
    if (value === null || value === undefined || value === '') {
      return null;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const isoOrNull = (value: Date | null): string | null => (value ? value.toISOString() : null);

  const currentVersion = Number(row.version);
  const revisionItems = siblings
    .map((sibling) => ({
      id: sibling.id,
      quotationNumber: sibling.quotationNumber,
      status: sibling.status,
      version: Number(sibling.version),
    }))
    .sort((a, b) => a.version - b.version);
  const next = revisionItems.filter((item) => item.version > currentVersion);
  const previousCandidates = revisionItems.filter((item) => item.version < currentVersion);
  const previous =
    previousCandidates.length > 0
      ? (previousCandidates[previousCandidates.length - 1] ?? null)
      : null;

  return {
    canReadFinance,
    entityVersion: row.entityVersion,
    engagementId: row.engagementId,
    defaultRatePerSqm: numberValue(row.defaultRatePerSqm),
    defaultRatePerSqmLabel: labelValue(row.defaultRatePerSqm),
    discountAmount: numberValue(row.discountAmount),
    discountAmountLabel: labelValue(row.discountAmount),
    discountPercent: plainNumber(row.discountPercent),
    feeItems: items
      .filter((item) => item.lineType === 'FEE')
      .map((item) => ({
        area: plainNumber(item.quantity),
        id: item.id,
        label: item.description,
        lineTotal: numberValue(item.lineTotal),
        lineTotalLabel: labelValue(item.lineTotal),
        ratePerSqm: numberValue(item.unitRate),
        ratePerSqmLabel: labelValue(item.unitRate),
      })),
    feeModel: row.feeModel,
    id: row.id,
    projectId: row.projectId,
    items: items.map((item) => ({
      description: item.description,
      id: item.id,
      lineTotal: numberValue(item.lineTotal),
      lineTotalLabel: labelValue(item.lineTotal),
      quantity: plainNumber(item.quantity) ?? 0,
      unitPrice: numberValue(item.unitRate),
      unitPriceLabel: labelValue(item.unitRate),
    })),
    paymentMilestones: milestones
      .map((milestone) => ({
        amount: numberValue(milestone.amount),
        amountLabel: labelValue(milestone.amount),
        description: milestone.description,
        dueTrigger: milestone.dueTrigger,
        id: milestone.id,
        name: milestone.name,
        percentage: plainNumber(milestone.percentage),
        sortOrder: plainNumber(milestone.sortOrder) ?? 0,
      }))
      .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0)),
    quotationNumber: row.quotationNumber,
    revision: { next, previous, version: currentVersion },
    reviewState: {
      hasActiveLink: false,
      lastAcceptedAt: isoOrNull(row.lastAcceptedAt),
      lastDeclinedAt: isoOrNull(row.lastDeclinedAt),
    },
    status: row.status,
    sortKey: quotationSortKey(row),
    subtotalAmount: numberValue(row.subtotalAmount),
    subtotalAmountLabel: labelValue(row.subtotalAmount),
    terms: [],
    title: row.title,
    totalAmount: numberValue(row.totalAmount),
    totalAmountLabel: labelValue(row.totalAmount),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The invoice rows the issue operation reads. */
export type InvoiceRow = {
  id: string;
  invoiceNumber: string;
  displayNumber: string | null;
  clientId: string;
  projectId: string | null;
  engagementId: string | null;
  milestoneId: string | null;
  progressCertificateId: string | null;
  status: string;
  currency: string;
  issueDate: Date | null;
  dueDate: Date | null;
  issuedAt: Date | null;
  totalAmount: string | null;
  taxAmount: string | null;
  collectionStatus: string | null;
  collectionNote: string | null;
  collectionOwnerId: string | null;
  collectionReminderDate: string | null;
  entityVersion: string;
  updatedAt: Date;
};

export type InvoicePaymentRow = {
  id: string;
  amount: string;
  paidAt: Date;
  method: string;
};

export type InvoiceComponentRow = {
  id: string;
  kind: string;
  amount: string;
  settledAmount: string;
};

/** The wire `ProjectFinanceInvoice`. */
export type InvoiceWire = {
  collectionNote: string | null;
  collectionOwner: { id: string; name: string } | null;
  collectionReminderDate: string | null;
  collectionReminderDateLabel: string | null;
  collectionStatus: string;
  collectionStatusLabel: string;
  dueDate: string;
  dueDateLabel: string | null;
  displayNumber: string | null;
  numberingLifecycle: string | null;
  entityVersion: string;
  id: string;
  invoiceNumber: string;
  issueDate: string;
  issueDateLabel: string | null;
  issuedAt: string | null;
  milestoneId: string | null;
  progressCertificateId: string | null;
  outstandingAmount: RawDecimal;
  outstandingAmountLabel: string;
  paidAmount: RawDecimal;
  paidAmountLabel: string;
  receivableComponents: Array<Record<string, unknown>>;
  payments: Array<Record<string, unknown>>;
  status: string;
  statusLabel: string;
  totalAmount: RawDecimal;
  totalAmountLabel: string;
  withholding: {
    label: null;
    expectedAmountLabel: null;
    evidencedAmountLabel: null;
    settledAmountLabel: null;
    outstandingAmountLabel: null;
  };
};

function isoDate(value: Date | null): string {
  return value ? value.toISOString().slice(0, 10) : '';
}

function rawOf(minor: bigint, currency: string): RawDecimal {
  return new RawDecimal(moneyText(minor), currency);
}

/** Projects one invoice plus its payments, components and owner. */
export function invoiceWire(
  row: InvoiceRow,
  payments: InvoicePaymentRow[],
  components: InvoiceComponentRow[],
  owner: { id: string; name: string } | null,
): InvoiceWire {
  const currency = row.currency || 'IDR';
  const totalMinor = row.totalAmount === null ? 0n : minorFromDecimal(row.totalAmount);
  const paidMinor = payments.reduce((sum, payment) => sum + minorFromDecimal(payment.amount), 0n);
  const outstandingMinor = totalMinor - paidMinor;

  return {
    collectionNote: row.collectionNote,
    collectionOwner: owner,
    collectionReminderDate: row.collectionReminderDate,
    collectionReminderDateLabel: row.collectionReminderDate
      ? dateLabel(row.collectionReminderDate)
      : null,
    collectionStatus: row.collectionStatus ?? 'NONE',
    collectionStatusLabel: statusLabel(row.collectionStatus ?? 'NONE') ?? '',
    dueDate: isoDate(row.dueDate),
    dueDateLabel: dateLabel(row.dueDate),
    displayNumber: row.displayNumber,
    numberingLifecycle: null,
    entityVersion: row.entityVersion,
    id: row.id,
    invoiceNumber: row.invoiceNumber,
    issueDate: isoDate(row.issueDate),
    issueDateLabel: dateLabel(row.issueDate),
    issuedAt: row.issuedAt ? row.issuedAt.toISOString() : null,
    milestoneId: row.milestoneId,
    progressCertificateId: row.progressCertificateId,
    outstandingAmount: rawOf(outstandingMinor, currency),
    outstandingAmountLabel: moneyLabel(moneyText(outstandingMinor), currency) ?? '',
    paidAmount: rawOf(paidMinor, currency),
    paidAmountLabel: moneyLabel(moneyText(paidMinor), currency) ?? '',
    receivableComponents: components.map((component) => {
      const componentAmount = minorFromDecimal(component.amount);
      const settled = minorFromDecimal(component.settledAmount);
      return {
        amount: wireNumber(component.amount),
        amountLabel: moneyLabel(component.amount, currency),
        kind: component.kind,
        // SOL-149 R5 (option b): components render as planned draft structure.
        // The label says which; live balances are invoice-level and cash-derived.
        label: receivableComponentLabel(component.kind),
        outstandingAmount: rawOf(componentAmount - settled, currency),
        outstandingAmountLabel: moneyLabel(moneyText(componentAmount - settled), currency),
        settledAmount: wireNumber(component.settledAmount),
        settledAmountLabel: moneyLabel(component.settledAmount, currency),
      };
    }),
    payments: payments.map((payment) => ({
      amount: moneyNumber(payment.amount, currency),
      amountLabel: moneyLabel(payment.amount, currency),
      date: isoDate(payment.paidAt),
      dateLabel: dateLabel(payment.paidAt),
      id: payment.id,
      methodLabel: statusLabel(payment.method) ?? '',
    })),
    status: row.status,
    statusLabel: statusLabel(row.status) ?? '',
    totalAmount: rawOf(totalMinor, currency),
    totalAmountLabel: moneyLabel(moneyText(totalMinor), currency) ?? '',
    withholding: {
      label: null,
      expectedAmountLabel: null,
      evidencedAmountLabel: null,
      settledAmountLabel: null,
      outstandingAmountLabel: null,
    },
  };
}

/** Canonical 2dp decimal text from a numeric(20,2) column string. */
export function canonicalDecimal(value: string): string {
  return moneyWire(value, 'IDR') ?? '0.00';
}
