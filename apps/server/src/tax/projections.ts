/**
 * Shared money projection helpers for the tax surface. SOL-25 revision 24.
 *
 * Every amount is integer minor units; the wire forms are canonical 2dp
 * strings (`MoneyOutput`) built by `packages/core` integer arithmetic —
 * never a float, never a rounded `Number`.
 */

import { moneyFromDecimal, moneyToDecimal } from '@stdio/core';

import { moneyWire, RawDecimal } from '../money';

/** Canonical 2dp money text from integer minor units. */
export function moneyText(minor: bigint): string {
  return moneyToDecimal({ amount: minor, currency: 'IDR' });
}

/** Integer minor units from a numeric(20,2) column string. */
export function minorFromDecimal(value: string): bigint {
  return moneyFromDecimal(value, 'IDR').amount;
}

/** RawDecimal for a NUMBER-form wire money field, or null. */
export function wireNumber(value: string | null | undefined): RawDecimal | null {
  if (value === null || value === undefined) {
    return null;
  }
  return new RawDecimal(moneyWire(value, 'IDR') ?? '0.00', 'IDR');
}

/** The wire `SupplierTaxRecording` union (section 4). */
export type SupplierTaxRecordingWire = {
  id: string;
  studioId: string;
  purchaseOrderId: string;
  supplierId: string;
  status: 'CUSTOM_UNVERIFIED';
  supplierDocumentReference: string;
  label: string;
  documentCurrency: string;
  dppAmount: string;
  taxAmount: string;
  exchangeRateEvidence: unknown;
  source: unknown;
  acceptedConfirmationText: string;
  recordedById: string;
  recordedAt: string;
  entityVersion: string;
};

/** Projects one `supplier_tax_recordings` row into the wire shape. */
export function supplierRecordingWire(row: {
  id: string;
  studioId: string;
  purchaseOrderId: string;
  supplierId: string;
  status: string;
  supplierDocumentReference: string;
  label: string;
  documentCurrency: string;
  dppAmount: string;
  taxAmount: string;
  exchangeRateEvidence: unknown;
  source: unknown;
  acceptedConfirmationText: string;
  recordedById: string;
  recordedAt: Date;
  entityVersion: string;
}): SupplierTaxRecordingWire {
  return {
    id: row.id,
    studioId: row.studioId,
    purchaseOrderId: row.purchaseOrderId,
    supplierId: row.supplierId,
    status: 'CUSTOM_UNVERIFIED',
    supplierDocumentReference: row.supplierDocumentReference,
    label: row.label,
    documentCurrency: row.documentCurrency,
    dppAmount: moneyWire(row.dppAmount, 'IDR') as string,
    taxAmount: moneyWire(row.taxAmount, 'IDR') as string,
    exchangeRateEvidence: row.exchangeRateEvidence,
    source: row.source,
    acceptedConfirmationText: row.acceptedConfirmationText,
    recordedById: row.recordedById,
    recordedAt: row.recordedAt.toISOString(),
    entityVersion: row.entityVersion,
  };
}
