/**
 * The exact tax-surface `Problem.code` values and their emitters.
 *
 * SOL-25 revision 24 names each rejection code in section 8 (preview and
 * issue), section 9.2 (custom rules), section 9.3 (supplier recordings),
 * section 9.7 (required-header table), section 9.8 (catalog precondition) and
 * section 9.9 (the 426 payload). The money categories come from
 * `packages/core/src/tax/money-input.ts`.
 *
 * `TaxWriteRejection` is the throw-based rejection used INSIDE a
 * `guardedWrite` handler. Throwing rolls back the tenant transaction —
 * including the idempotency row — so a rejected write never consumes the
 * Idempotency-Key (CEO ruling condition 3). The route catches it and maps it
 * to the identical `Problem` the direct helpers below emit.
 */

import type { Context } from 'hono';

import { problem } from '../http';

export type TaxProblemSpec = {
  status: number;
  code: string;
  title: string;
  detail: string;
  details?: Record<string, unknown>;
};

/** Thrown inside a guarded-write handler; rolls back the transaction. */
export class TaxWriteRejection extends Error {
  readonly status: number;
  readonly code: string;
  readonly title: string;
  readonly detail: string;
  readonly details: Record<string, unknown> | undefined;

  constructor(spec: TaxProblemSpec) {
    super(`${spec.code}: ${spec.detail}`);
    this.name = 'TaxWriteRejection';
    this.status = spec.status;
    this.code = spec.code;
    this.title = spec.title;
    this.detail = spec.detail;
    this.details = spec.details;
  }
}

/** Emits a tax-surface Problem response. */
export function taxProblem(c: Context, spec: TaxProblemSpec): Response {
  return problem(c, {
    status: spec.status,
    code: spec.code,
    title: spec.title,
    detail: spec.detail,
    requestId: c.get('requestId'),
    ...(spec.details ? { details: spec.details } : {}),
  });
}

/** A rejected write inside a guarded handler (rolls back; no key consumed). */
export function reject(spec: TaxProblemSpec): never {
  throw new TaxWriteRejection(spec);
}

/** 404 — unknown or cross-studio rule id; deliberately identical for both. */
export const taxRuleNotFound = (): TaxProblemSpec => ({
  status: 404,
  code: 'TAX_RULE_NOT_FOUND',
  title: 'Tax rule not found',
  detail: 'The tax rule does not exist or is not visible to this studio.',
});

/** 409 — stale or foreign catalog tag; the body is identical for both. */
export const taxCatalogConflict = (): TaxProblemSpec => ({
  status: 409,
  code: 'TAX_RULE_CATALOG_CONFLICT',
  title: 'Tax rule catalog conflict',
  detail:
    'The x-stdio-tax-catalog-tag does not match the current catalog for this studio. Rediscover and retry.',
});

/** 422 — the central rule is not effective on the issue/preview date. */
export const taxRuleDateMismatch = (): TaxProblemSpec => ({
  status: 422,
  code: 'TAX_RULE_DATE_MISMATCH',
  title: 'Tax rule date mismatch',
  detail: 'The verified rule is not effective on the document issue date.',
});

/** 422 — the submitted verified version is not the version the date resolves. */
export const taxRuleVersionStale = (): TaxProblemSpec => ({
  status: 422,
  code: 'TAX_RULE_VERSION_STALE',
  title: 'Tax rule version stale',
  detail:
    'The submitted rule version is no longer the resolved version for this date. Rediscover and retry.',
});

/** 422 — the exact (ruleId, ruleVersion) pair does not exist. */
export const taxRuleVersionNotFound = (): TaxProblemSpec => ({
  status: 422,
  code: 'TAX_RULE_VERSION_NOT_FOUND',
  title: 'Tax rule version not found',
  detail: 'The submitted rule version does not exist for the rule.',
});

/** 422 — the input branch does not match the resolved rule kind. */
export const taxRuleModeConflict = (): TaxProblemSpec => ({
  status: 422,
  code: 'TAX_RULE_MODE_CONFLICT',
  title: 'Tax rule mode conflict',
  detail: 'The tax application branch does not match the resolved tax rule.',
});

/** 422 — every line selection is false. */
export const taxLineSelectionEmpty = (): TaxProblemSpec => ({
  status: 422,
  code: 'TAX_LINE_SELECTION_EMPTY',
  title: 'Tax line selection empty',
  detail: 'At least one document line must be selected for tax.',
});

/** 422 — duplicate, conflicting, unknown or non-exhaustive line selections. */
export const taxLineSelectionInvalid = (): TaxProblemSpec => ({
  status: 422,
  code: 'TAX_LINE_SELECTION_INVALID',
  title: 'Tax line selection invalid',
  detail: 'The line selection is duplicate, conflicting, unknown, or not exhaustive.',
});

/** 422 — recording override line ids differ from the selected set. */
export const taxOverrideLineInvalid = (): TaxProblemSpec => ({
  status: 422,
  code: 'TAX_OVERRIDE_LINE_INVALID',
  title: 'Tax override line invalid',
  detail: 'The manual override line ids must equal the selected line ids.',
});

/** 422 — request currency differs from the application currency. */
export const taxCurrencyMismatch = (): TaxProblemSpec => ({
  status: 422,
  code: 'TAX_CURRENCY_MISMATCH',
  title: 'Tax currency mismatch',
  detail: 'The document currency and the tax application currency differ.',
});

/** 422 — discount outside [0, consideration]. */
export const taxAmountInvalid = (): TaxProblemSpec => ({
  status: 422,
  code: 'TAX_AMOUNT_INVALID',
  title: 'Tax amount invalid',
  detail:
    'The discount must be non-negative and no greater than the consideration before discount.',
});

/** 422 — verified confirmation booleans or accepted text mismatch.
 *
 * SOL-133 (review SOL-138 condition C1): when this code is emitted with
 * status 422, `details` carries the four recovery correlates — the current
 * applicability text (byte-equal to the resolve response), the rule id, the
 * rule version and the rule entity version. The client re-renders the text
 * and re-issues with a fresh Idempotency-Key; reusing the failed key with a
 * corrected body yields 409 IDEMPOTENCY_KEY_REUSED (condition C2).
 */
export const taxApplicabilityConfirmationInvalid = (correlates: {
  ruleId: string;
  ruleVersion: number;
  entityVersion: string;
  text: string;
}): TaxProblemSpec => ({
  status: 422,
  code: 'TAX_APPLICABILITY_CONFIRMATION_INVALID',
  title: 'Tax applicability confirmation invalid',
  detail:
    'The applicability confirmation is missing, false, or its text differs from the resolved rule.',
  details: {
    applicabilityConfirmationText: correlates.text,
    applicabilityConfirmationRuleId: correlates.ruleId,
    applicabilityConfirmationRuleVersion: correlates.ruleVersion,
    applicabilityConfirmationEntityVersion: correlates.entityVersion,
  },
});

/** 422 — a required acknowledgment is missing or not accepted. */
export const taxAcknowledgmentMissing = (): TaxProblemSpec => ({
  status: 422,
  code: 'TAX_ACKNOWLEDGMENT_MISSING',
  title: 'Tax acknowledgment missing',
  detail: 'The required acknowledgment is missing or not accepted.',
});

/** 422 — a custom rule code collides with a central preset code. */
export const taxRuleCodeReserved = (): TaxProblemSpec => ({
  status: 422,
  code: 'TAX_RULE_CODE_RESERVED',
  title: 'Tax rule code reserved',
  detail: 'A custom rule may not use a central preset code such as PPN_STANDARD_2025.',
});

/** 422 — a legacy request field (taxRate / taxEvidence) is present. */
export const taxRuleUnavailable = (): TaxProblemSpec => ({
  status: 422,
  code: 'TAX_RULE_UNAVAILABLE',
  title: 'Tax rule unavailable',
  detail:
    'The legacy tax rate or tax evidence field is no longer accepted. Send taxApplication instead.',
});

/** 422 — IDR recording carries evidence, or non-IDR recording omits it. */
export const taxRecordingEvidenceInvalid = (): TaxProblemSpec => ({
  status: 422,
  code: 'TAX_RECORDING_EVIDENCE_INVALID',
  title: 'Tax recording evidence invalid',
  detail: 'A non-IDR recording requires exchange-rate evidence; an IDR recording must carry none.',
});

/** 422 — issue operation with taxApplication but no catalog tag. */
export const taxCatalogTagRequired = (): TaxProblemSpec => ({
  status: 422,
  code: 'TAX_CATALOG_TAG_REQUIRED',
  title: 'Tax catalog tag required',
  detail: 'A non-null taxApplication requires the x-stdio-tax-catalog-tag header.',
});

/** 422 — issue operation with a catalog tag but no taxApplication. */
export const taxCatalogTagUnexpected = (): TaxProblemSpec => ({
  status: 422,
  code: 'TAX_CATALOG_TAG_UNEXPECTED',
  title: 'Tax catalog tag unexpected',
  detail:
    'The x-stdio-tax-catalog-tag header must be absent when taxApplication is null or omitted.',
});

/** 409 — duplicate supplier tax recording for the same supplier reference. */
export const supplierTaxRecordingConflict = (): TaxProblemSpec => ({
  status: 409,
  code: 'SUPPLIER_TAX_RECORDING_CONFLICT',
  title: 'Supplier tax recording conflict',
  detail:
    'A supplier tax recording with this supplier document reference already exists for the supplier.',
});

/** 500 — the verified register matches more than one version for a date. */
export const taxRuleRegisterInvalid = (): TaxProblemSpec => ({
  status: 500,
  code: 'TAX_RULE_REGISTER_INVALID',
  title: 'Tax rule register invalid',
  detail: 'The verified register has overlapping versions for this date. Contact support.',
});

/** Maps a thrown MoneyInputError to its exact 422 Problem code. */
export function moneyInputSpec(
  code: 'MONEY_FORMAT_INVALID' | 'MONEY_NOT_EXACT' | 'MONEY_OUT_OF_RANGE',
  detail: string,
): TaxProblemSpec {
  const title =
    code === 'MONEY_FORMAT_INVALID'
      ? 'Money format invalid'
      : code === 'MONEY_NOT_EXACT'
        ? 'Money not exact'
        : 'Money out of range';
  return { status: 422, code, title, detail };
}
