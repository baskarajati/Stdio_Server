/**
 * Tax application parsing and rule resolution (SOL-25 revision 24, sections
 * 6, 8 and 9.8).
 *
 * One `TaxApplicationInput` matches exactly one of three closed branches:
 * VERIFIED_RATIONAL (the central preset), CUSTOM_RULE (a studio-owned
 * unverified rule) or CUSTOM_RECORDING (a manual override; issue operations
 * only). The request boundary is parsed once with zod; the semantic checks
 * that need an exact `Problem.code` (line selection, acknowledgment,
 * confirmation text) run on the parsed shape. Every rejection throws a
 * `TaxWriteRejection`, so a failed attempt writes no document, no snapshot
 * and no idempotency row.
 */

import { parseStrictMoneyInput } from '@stdio/core';
import { z } from 'zod';

import type { Db } from '../context/db';
import {
  reject,
  taxAcknowledgmentMissing,
  taxApplicabilityConfirmationInvalid,
  taxCurrencyMismatch,
  taxLineSelectionEmpty,
  taxLineSelectionInvalid,
  taxOverrideLineInvalid,
  taxRecordingEvidenceInvalid,
  taxRuleDateMismatch,
  taxRuleModeConflict,
  taxRuleNotFound,
  taxRuleVersionNotFound,
  taxRuleVersionStale,
} from './codes';
import {
  findRuleVersion,
  latestStudioRule,
  resolveVerifiedForDate,
  type TaxRuleRow,
} from './rules';

/** One line selection of a document. */
export type LineSelection = { lineId: string; selected: boolean };

const lineSelectionSchema = z.object({ lineId: z.string().min(1), selected: z.boolean() });

const confirmationSchema = z
  .object({
    transactionInIndonesia: z.literal(true),
    fallsWithinPmk131Article3: z.literal(true),
    noSeparateRegimeApplies: z.literal(true),
    pkpStatusConfirmed: z.literal(true),
    acceptedText: z.string().min(1),
  })
  .strict();

const customRuleAcknowledgmentSchema = z
  .object({ customUnverified: z.literal(true), acceptedText: z.string().min(1) })
  .strict();

const recordingAcknowledgmentSchema = z
  .object({
    recordedOutsideStdio: z.literal(true),
    notVerifiedTreatment: z.literal(true),
    acceptedText: z.string().min(1),
  })
  .strict();

const manualOverrideSchema = z
  .object({
    label: z.string().min(1),
    amount: z.union([z.string(), z.number()]),
    taxAmountCurrency: z.literal('IDR'),
    documentCurrency: z.string().min(3),
    reason: z.string().min(1),
    source: z.string().min(1),
    lineIds: z.array(z.string().min(1)).min(1),
    exchangeRateEvidence: z.unknown().nullable(),
  })
  .strict();

const verifiedSchema = z
  .object({
    ruleId: z.string().min(1),
    ruleVersion: z.number().int().min(1),
    documentCurrency: z.literal('IDR'),
    lineSelections: z.array(lineSelectionSchema).min(1),
    confirmation: confirmationSchema,
  })
  .strict();

const customSchema = z
  .object({
    ruleId: z.string().min(1),
    ruleVersion: z.number().int().min(1),
    documentCurrency: z.literal('IDR'),
    lineSelections: z.array(lineSelectionSchema).min(1),
    customRuleAcknowledgment: customRuleAcknowledgmentSchema,
  })
  .strict();

const recordingSchema = z
  .object({
    lineSelections: z.array(lineSelectionSchema).min(1),
    manualOverride: manualOverrideSchema,
    recordingAcknowledgment: recordingAcknowledgmentSchema,
  })
  .strict();

const applicationSchema = z.union([verifiedSchema, customSchema, recordingSchema]);

/** The three closed application branches, parsed and typed. */
export type ParsedApplication = z.infer<typeof applicationSchema>;

const AFFECTED_STRUCTURE = {
  status: 422,
  code: 'TAX_REQUEST_INVALID',
  title: 'Invalid tax request',
  detail: 'The taxApplication object does not match a closed application branch.',
} as const;

/** The line-selection array; empty/all-false/duplicate/conflicting fail. */
export function parseLineSelections(raw: unknown): LineSelection[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    reject(taxLineSelectionEmpty());
  }
  const seen = new Map<string, boolean>();
  for (const item of raw) {
    if (
      typeof item !== 'object' ||
      item === null ||
      typeof item.lineId !== 'string' ||
      item.lineId.length === 0
    ) {
      reject(taxLineSelectionInvalid());
    }
    const lineId = item.lineId;
    if (item.selected !== true && item.selected !== false) {
      reject(taxLineSelectionInvalid());
    }
    if (seen.has(lineId)) {
      reject(taxLineSelectionInvalid());
    }
    seen.set(lineId, item.selected);
  }
  const selections = [...seen.entries()].map(([lineId, selected]) => ({ lineId, selected }));
  if (selections.every((s) => !s.selected)) {
    reject(taxLineSelectionEmpty());
  }
  return selections;
}

/**
 * Issue-surface exhaustiveness: the submitted line ids must be exactly the
 * document's lines. Preview skips this (no document fetch); issue enforces it
 * (N31).
 */
export function validateDocumentLines(
  selections: LineSelection[],
  documentLineIds: readonly string[],
): { includedLineIds: string[]; excludedLineIds: string[] } {
  const submitted = [...selections.map((s) => s.lineId)].sort();
  const expected = [...documentLineIds].sort();
  if (submitted.length !== expected.length || submitted.some((id, i) => id !== expected[i])) {
    reject(taxLineSelectionInvalid());
  }
  return {
    includedLineIds: selections
      .filter((s) => s.selected)
      .map((s) => s.lineId)
      .sort(),
    excludedLineIds: selections
      .filter((s) => !s.selected)
      .map((s) => s.lineId)
      .sort(),
  };
}

/** Override line ids must equal the selected-true set (N31 recording). */
export function validateOverrideLines(
  selections: LineSelection[],
  overrideLineIds: readonly string[],
): void {
  const selected = selections
    .filter((s) => s.selected)
    .map((s) => s.lineId)
    .sort();
  const submitted = [...overrideLineIds].sort();
  if (selected.length !== submitted.length || selected.some((id, i) => id !== submitted[i])) {
    reject(taxOverrideLineInvalid());
  }
}

/** Parses one `TaxApplicationInput` value into a closed branch. */
export function parseApplication(raw: unknown): ParsedApplication {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    reject(AFFECTED_STRUCTURE);
  }
  // Branch discrimination by the branch-specific keys.
  const record = raw as Record<string, unknown>;
  const hasVerified = 'ruleId' in record && 'confirmation' in record;
  const hasCustom = 'ruleId' in record && 'customRuleAcknowledgment' in record;
  const hasRecording = 'manualOverride' in record && 'recordingAcknowledgment' in record;
  const branchCount = Number(hasVerified) + Number(hasCustom) + Number(hasRecording);
  if (branchCount !== 1) {
    reject(AFFECTED_STRUCTURE);
  }

  // Semantic line-selection codes fire before the zod shape check.
  parseLineSelections(record.lineSelections);

  const parsed = applicationSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    if (
      issue?.path[0] === 'confirmation' ||
      issue?.path[0] === 'customRuleAcknowledgment' ||
      issue?.path[0] === 'recordingAcknowledgment'
    ) {
      reject(taxAcknowledgmentMissing());
    }
    reject(AFFECTED_STRUCTURE);
  }
  return parsed.data as ParsedApplication;
}

/** The resolved rule plus the text the snapshot copies as confirmation. */
export type ResolvedApplication =
  | {
      branch: 'verified' | 'custom';
      rule: TaxRuleRow;
      acceptedText: string;
      lineSelections: LineSelection[];
    }
  | { branch: 'recording'; acceptedText: string; lineSelections: LineSelection[] };

/**
 * Resolves the rule for a verified or custom branch against the issue date.
 * Returns the rule row plus the confirmation text the snapshot copies. The
 * recording branch validates its currency, evidence and acknowledgment rules
 * and performs no calculation.
 *
 * The branches are discriminated by their unique keys (`manualOverride`,
 * `confirmation`); `parseApplication` already enforced that exactly one
 * branch's key set is present.
 */
export async function resolveApplication(
  scoped: Db,
  app: ParsedApplication,
  issueDate: string,
  documentCurrency: string,
): Promise<ResolvedApplication> {
  if ('manualOverride' in app) {
    if (app.manualOverride.documentCurrency !== documentCurrency) {
      reject(taxCurrencyMismatch());
    }
    const isIdr = app.manualOverride.documentCurrency === 'IDR';
    const hasEvidence =
      app.manualOverride.exchangeRateEvidence !== null &&
      app.manualOverride.exchangeRateEvidence !== undefined;
    if (isIdr ? hasEvidence : !hasEvidence) {
      reject(taxRecordingEvidenceInvalid());
    }
    validateOverrideLines(app.lineSelections, app.manualOverride.lineIds);
    return {
      branch: 'recording',
      acceptedText: app.recordingAcknowledgment.acceptedText,
      lineSelections: app.lineSelections,
    };
  }

  if ('confirmation' in app) {
    const resolved = await resolveVerifiedForDate(scoped, issueDate);
    if (!resolved) {
      reject(taxRuleDateMismatch());
    }
    if (app.ruleId !== resolved.id) {
      const found = await findRuleVersion(scoped, app.ruleId, app.ruleVersion);
      if (found && found.ownerType === 'CENTRAL') {
        reject(taxRuleModeConflict());
      }
      reject(taxRuleNotFound());
    }
    const pair = await findRuleVersion(scoped, app.ruleId, app.ruleVersion);
    if (!pair) {
      reject(taxRuleVersionNotFound());
    }
    if (pair.version !== resolved.version) {
      reject(taxRuleVersionStale());
    }
    if (app.confirmation.acceptedText !== (resolved.applicabilityConfirmationText ?? '')) {
      reject(taxApplicabilityConfirmationInvalid());
    }
    return {
      branch: 'verified',
      rule: resolved,
      acceptedText: app.confirmation.acceptedText,
      lineSelections: app.lineSelections,
    };
  }

  const rule = await findRuleVersion(scoped, app.ruleId, app.ruleVersion);
  if (!rule) {
    reject(taxRuleNotFound());
  }
  if (rule.ownerType === 'CENTRAL') {
    reject(taxRuleModeConflict());
  }
  const latest = await latestStudioRule(scoped, app.ruleId);
  if (!latest || latest.version !== rule.version) {
    reject(taxRuleVersionStale());
  }
  return {
    branch: 'custom',
    rule,
    acceptedText: app.customRuleAcknowledgment.acceptedText,
    lineSelections: app.lineSelections,
  };
}

/** Parses a MoneyInput strictly; the route maps the error to its code. */
export function parseMoneyMinor(raw: unknown): bigint {
  if (typeof raw !== 'string' && typeof raw !== 'number') {
    reject({
      status: 422,
      code: 'MONEY_FORMAT_INVALID',
      title: 'Money format invalid',
      detail: 'A money value must be a string or a number.',
    });
  }
  return parseStrictMoneyInput(raw);
}
