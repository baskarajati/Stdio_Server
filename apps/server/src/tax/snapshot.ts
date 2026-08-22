/**
 * Immutable `TaxSnapshot` construction (SOL-25 revision 24, section 7).
 *
 * The server writes one snapshot in the same transaction as document issue.
 * The payload is the complete mode-specific wire body (audit fields
 * included), stored verbatim in JSONB and emitted back without a projection
 * pass, so every money token is the canonical string the calculation
 * produced — never a float.
 *
 * The five closed modes: VERIFIED_RATIONAL, CUSTOM_RATIONAL, CUSTOM_FIXED,
 * CUSTOM_RECORDING_IDR, CUSTOM_RECORDING_NON_IDR. Verified snapshots carry
 * the seller PKP confirmation (`true` + timestamp) and copy the controlled
 * evidence and exclusions byte-for-byte; custom and recording snapshots carry
 * `sellerPkpStatusConfirmed: null` and never claim verified authority.
 *
 * The wire `entityVersion` is the SNAPSHOT's own entity version (the storage
 * row's), generated at write time — never the rule's.
 */

import { moneyOutput } from '@stdio/core';

import type { CalculationOutcome } from './calculate';
import { dateText, type TaxRuleRow } from './rules';

/** The audit base every snapshot carries (TaxSnapshotAuditBase). */
export type SnapshotAudit = {
  snapshotId: string;
  documentId: string;
  documentType: 'QUOTATION' | 'COMMERCIAL_INVOICE';
  documentVersion: string;
  documentIssueDate: string;
  documentStatus: string;
  taxType: 'PPN';
  jurisdiction: 'ID';
  includedLineIds: string[];
  excludedLineIds: string[];
  confirmedById: string;
  confirmedAt: string;
  acceptedConfirmationText: string;
  sellerId: string;
  buyerId: string;
};

export type SnapshotRecord = {
  mode:
    | 'VERIFIED_RATIONAL'
    | 'CUSTOM_RATIONAL'
    | 'CUSTOM_FIXED'
    | 'CUSTOM_RECORDING_IDR'
    | 'CUSTOM_RECORDING_NON_IDR';
  /** The complete wire body (audit fields included), stored verbatim. */
  payload: Record<string, unknown>;
};

function auditBase(audit: SnapshotAudit): Record<string, unknown> {
  return {
    snapshotId: audit.snapshotId,
    documentId: audit.documentId,
    documentType: audit.documentType,
    documentVersion: audit.documentVersion,
    documentIssueDate: audit.documentIssueDate,
    documentStatus: audit.documentStatus,
    taxType: audit.taxType,
    jurisdiction: audit.jurisdiction,
    includedLineIds: audit.includedLineIds,
    excludedLineIds: audit.excludedLineIds,
    confirmedById: audit.confirmedById,
    confirmedAt: audit.confirmedAt,
    acceptedConfirmationText: audit.acceptedConfirmationText,
  };
}

/** The verified snapshot; `effectiveDateMatched: true` and PKP confirmed. */
export function verifiedSnapshot(
  audit: SnapshotAudit,
  rule: TaxRuleRow,
  calc: CalculationOutcome,
  snapshotEntityVersion: string,
): SnapshotRecord {
  const payload = {
    ...auditBase(audit),
    documentCurrency: 'IDR',
    sellerId: audit.sellerId,
    buyerId: audit.buyerId,
    sellerPkpStatusConfirmed: true,
    sellerPkpStatusConfirmedAt: audit.confirmedAt,
    ruleId: rule.id,
    ruleVersion: rule.version,
    ruleOwnerType: 'CENTRAL',
    ruleStudioId: null,
    ruleCode: rule.code,
    ruleStatus: 'VERIFIED',
    calculationMode: 'RATIONAL_RATE',
    effectiveDateMatched: true,
    effectiveFrom: dateText(rule.effectiveFrom),
    effectiveTo: rule.effectiveTo === null ? null : dateText(rule.effectiveTo),
    verifiedAt: rule.verifiedAt === null ? null : dateText(rule.verifiedAt),
    disclaimerText: rule.disclaimerText,
    entityVersion: snapshotEntityVersion,
    applicabilityConfirmationText: rule.applicabilityConfirmationText ?? '',
    statutoryRateNumerator: rule.statutoryRateNumerator,
    statutoryRateDenominator: rule.statutoryRateDenominator,
    dppFactorNumerator: rule.dppFactorNumerator,
    dppFactorDenominator: rule.dppFactorDenominator,
    fixedAmount: null,
    roundDppBeforeTax: true,
    roundingStage: 'DPP_THEN_PPN',
    roundingMode: 'HALF_UP',
    roundingUnitMinor: 100,
    calculationScope: 'DOCUMENT_TAX_BUCKET',
    verifiedEvidence: rule.evidenceJson ?? [],
    exclusions: rule.exclusionsJson ?? [],
    considerationBeforeDiscount: calc.result.considerationBeforeDiscount,
    discount: calc.result.discount,
    taxableBase: calc.result.taxableBase,
    dppExactNumerator: calc.result.dppExactNumerator,
    dppExactDenominator: calc.result.dppExactDenominator,
    dppRounded: calc.result.dppRounded,
    ppnExactNumerator: calc.result.ppnExactNumerator,
    ppnExactDenominator: calc.result.ppnExactDenominator,
    ppnRounded: calc.result.ppnRounded,
    total: calc.result.total,
    manualOverride: null,
  };
  return { mode: 'VERIFIED_RATIONAL', payload };
}

/** The custom-rule snapshots (rational or fixed); no PKP confirmation. */
export function customSnapshot(
  audit: SnapshotAudit,
  rule: TaxRuleRow,
  calc: CalculationOutcome,
  snapshotEntityVersion: string,
): SnapshotRecord {
  const isFixed = rule.calculationMode === 'FIXED_AMOUNT';
  const payload = {
    ...auditBase(audit),
    documentCurrency: 'IDR',
    sellerId: audit.sellerId,
    buyerId: audit.buyerId,
    sellerPkpStatusConfirmed: null,
    sellerPkpStatusConfirmedAt: null,
    ruleId: rule.id,
    ruleVersion: rule.version,
    ruleOwnerType: 'STUDIO',
    ruleStudioId: rule.studioId,
    ruleCode: rule.code,
    ruleStatus: 'CUSTOM_UNVERIFIED',
    label: rule.label ?? '',
    calculationMode: rule.calculationMode,
    effectiveDateMatched: null,
    effectiveFrom: dateText(rule.effectiveFrom),
    effectiveTo: rule.effectiveTo === null ? null : dateText(rule.effectiveTo),
    verifiedAt: null,
    disclaimerText: rule.disclaimerText,
    entityVersion: snapshotEntityVersion,
    statutoryRateNumerator: isFixed ? null : rule.statutoryRateNumerator,
    statutoryRateDenominator: isFixed ? null : rule.statutoryRateDenominator,
    dppFactorNumerator: isFixed ? null : rule.dppFactorNumerator,
    dppFactorDenominator: isFixed ? null : rule.dppFactorDenominator,
    fixedAmount: isFixed ? rule.fixedAmount : null,
    roundDppBeforeTax: isFixed ? null : true,
    roundingStage: isFixed ? null : 'DPP_THEN_PPN',
    roundingMode: 'HALF_UP',
    roundingUnitMinor: 100,
    calculationScope: 'DOCUMENT_TAX_BUCKET',
    sources: rule.sourcesJson ?? [],
    considerationBeforeDiscount: calc.result.considerationBeforeDiscount,
    discount: calc.result.discount,
    taxableBase: calc.result.taxableBase,
    dppExactNumerator: calc.result.dppExactNumerator,
    dppExactDenominator: calc.result.dppExactDenominator,
    dppRounded: calc.result.dppRounded,
    ppnExactNumerator: calc.result.ppnExactNumerator,
    ppnExactDenominator: calc.result.ppnExactDenominator,
    ppnRounded: calc.result.ppnRounded,
    total: calc.result.total,
    manualOverride: null,
  };
  return { mode: isFixed ? 'CUSTOM_FIXED' : 'CUSTOM_RATIONAL', payload };
}

/** The recording snapshots; the override is stored verbatim with parsed money. */
export function recordingSnapshot(
  audit: SnapshotAudit,
  manualOverride: {
    label: string;
    amountMinor: bigint;
    taxAmountCurrency: string;
    documentCurrency: string;
    reason: string;
    source: string;
    lineIds: string[];
    exchangeRateEvidence: unknown;
  },
): SnapshotRecord {
  const isIdr = manualOverride.documentCurrency === 'IDR';
  const payload = {
    ...auditBase(audit),
    sellerId: audit.sellerId,
    buyerId: audit.buyerId,
    sellerPkpStatusConfirmed: null,
    sellerPkpStatusConfirmedAt: null,
    ruleId: null,
    ruleVersion: null,
    ruleCode: null,
    ruleStatus: 'CUSTOM_UNVERIFIED',
    calculationMode: null,
    effectiveDateMatched: null,
    verifiedAt: null,
    statutoryRateNumerator: null,
    statutoryRateDenominator: null,
    dppFactorNumerator: null,
    dppFactorDenominator: null,
    fixedAmount: null,
    roundDppBeforeTax: null,
    roundingStage: null,
    roundingMode: null,
    roundingUnitMinor: null,
    calculationScope: null,
    sources: null,
    considerationBeforeDiscount: null,
    discount: null,
    taxableBase: null,
    dppExactNumerator: null,
    dppExactDenominator: null,
    dppRounded: null,
    ppnExactNumerator: null,
    ppnExactDenominator: null,
    ppnRounded: null,
    total: null,
    manualOverride: {
      label: manualOverride.label,
      amount: moneyOutput(manualOverride.amountMinor),
      taxAmountCurrency: 'IDR',
      documentCurrency: manualOverride.documentCurrency,
      reason: manualOverride.reason,
      source: manualOverride.source,
      lineIds: manualOverride.lineIds,
      exchangeRateEvidence: isIdr ? null : manualOverride.exchangeRateEvidence,
    },
  };
  return { mode: isIdr ? 'CUSTOM_RECORDING_IDR' : 'CUSTOM_RECORDING_NON_IDR', payload };
}
