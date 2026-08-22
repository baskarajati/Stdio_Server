/**
 * Tax-rule row access and wire projection (SOL-25 revision 24, section 5).
 *
 * One `tax_rules` row is one immutable version of one rule. RLS exposes
 * CENTRAL rows to every studio and each studio's own STUDIO rows only, so a
 * lookup by (id, version) that returns a row is either a CENTRAL rule or the
 * caller's own custom rule — a cross-studio rule simply returns no row, which
 * the routes map to the non-leaking 404 `TAX_RULE_NOT_FOUND`.
 *
 * The wire projection copies the stored facts verbatim (dates, rational text,
 * JSONB evidence/exclusions/sources, confirmation and disclaimer text) and
 * derives the mode-constant fields from `ownerType` + `calculationMode`.
 */

import { schema } from '@stdio/db';
import { and, desc, eq, sql } from 'drizzle-orm';

import type { Db } from '../context/db';
import { taxRuleRegisterInvalid } from './codes';

const { taxRules } = schema;

/** One immutable rule-version row as the server reads it. */
export type TaxRuleRow = {
  id: string;
  version: number;
  studioId: string | null;
  ownerType: string;
  status: string;
  label: string | null;
  code: string;
  jurisdiction: string;
  taxType: string;
  currency: string;
  calculationMode: string;
  effectiveFrom: Date | string;
  effectiveTo: Date | string | null;
  verifiedAt: Date | string | null;
  statutoryRateNumerator: string | null;
  statutoryRateDenominator: string | null;
  dppFactorNumerator: string | null;
  dppFactorDenominator: string | null;
  fixedAmount: string | null;
  roundingMode: string;
  roundingUnitMinor: number;
  roundDppBeforeTax: boolean | null;
  roundingStage: string | null;
  calculationScope: string;
  evidenceJson: unknown;
  exclusionsJson: unknown;
  sourcesJson: unknown;
  applicabilityConfirmationText: string | null;
  disclaimerText: string;
  entityVersion: string;
};

/** The `date` wire text for a pg DATE value (JS Date at UTC midnight). */
export function dateText(value: Date | string): string {
  if (typeof value === 'string') {
    return value;
  }
  const y = value.getUTCFullYear();
  const m = String(value.getUTCMonth() + 1).padStart(2, '0');
  const d = String(value.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Selects every tax_rule column with the drizzle snake_case mapping. */ export const taxRuleSelect =
  {
    id: taxRules.id,
    version: taxRules.version,
    studioId: taxRules.studioId,
    ownerType: taxRules.ownerType,
    status: taxRules.status,
    label: taxRules.label,
    code: taxRules.code,
    jurisdiction: taxRules.jurisdiction,
    taxType: taxRules.taxType,
    currency: taxRules.currency,
    calculationMode: taxRules.calculationMode,
    effectiveFrom: taxRules.effectiveFrom,
    effectiveTo: taxRules.effectiveTo,
    verifiedAt: taxRules.verifiedAt,
    statutoryRateNumerator: taxRules.statutoryRateNumerator,
    statutoryRateDenominator: taxRules.statutoryRateDenominator,
    dppFactorNumerator: taxRules.dppFactorNumerator,
    dppFactorDenominator: taxRules.dppFactorDenominator,
    fixedAmount: taxRules.fixedAmount,
    roundingMode: taxRules.roundingMode,
    roundingUnitMinor: taxRules.roundingUnitMinor,
    roundDppBeforeTax: taxRules.roundDppBeforeTax,
    roundingStage: taxRules.roundingStage,
    calculationScope: taxRules.calculationScope,
    evidenceJson: taxRules.evidenceJson,
    exclusionsJson: taxRules.exclusionsJson,
    sourcesJson: taxRules.sourcesJson,
    applicabilityConfirmationText: taxRules.applicabilityConfirmationText,
    disclaimerText: taxRules.disclaimerText,
    entityVersion: taxRules.entityVersion,
  } as const;

/**
 * Looks up one exact (ruleId, version) visible to this studio. A null result
 * is the non-leaking 404: unknown, another studio's rule, or both.
 */
export async function findRuleVersion(
  scoped: Db,
  ruleId: string,
  ruleVersion: number,
): Promise<TaxRuleRow | null> {
  const rows = await scoped.db
    .select(taxRuleSelect)
    .from(taxRules)
    .where(and(eq(taxRules.id, ruleId), eq(taxRules.version, ruleVersion)))
    .limit(1);
  return (rows[0] as TaxRuleRow | undefined) ?? null;
}

/**
 * The latest version of a STUDIO-owned rule (custom-rule version append and
 * the custom-branch "current version" check). RLS hides other studios' rows,
 * so a null result is the non-leaking 404.
 */
export async function latestStudioRule(scoped: Db, ruleId: string): Promise<TaxRuleRow | null> {
  const rows = await scoped.db
    .select(taxRuleSelect)
    .from(taxRules)
    .where(and(eq(taxRules.id, ruleId), eq(taxRules.studioId, scoped.studioId)))
    .orderBy(desc(taxRules.version))
    .limit(1);
  return (rows[0] as TaxRuleRow | undefined) ?? null;
}

/**
 * Resolves the verified CENTRAL rule whose half-open interval
 * `[effectiveFrom, effectiveTo)` contains `issueDate`. Zero matches return
 * null; multiple matches fail closed (register corruption).
 */
export async function resolveVerifiedForDate(
  scoped: Db,
  issueDate: string,
): Promise<TaxRuleRow | null> {
  const rows = await scoped.db
    .select(taxRuleSelect)
    .from(taxRules)
    .where(
      sql`${taxRules.ownerType} = 'CENTRAL' AND ${taxRules.status} = 'VERIFIED'
          AND ${taxRules.effectiveFrom} <= ${issueDate}::date
          AND (${taxRules.effectiveTo} IS NULL OR ${issueDate}::date < ${taxRules.effectiveTo})`,
    )
    .orderBy(desc(taxRules.effectiveFrom), desc(taxRules.version));
  if (rows.length > 1) {
    throw new Error(taxRuleRegisterInvalid().detail);
  }
  return (rows[0] as TaxRuleRow | undefined) ?? null;
}

/** The latest version of every custom rule the studio owns (discovery). */
export async function studioCustomRules(scoped: Db): Promise<TaxRuleRow[]> {
  const rows = await scoped.db
    .select(taxRuleSelect)
    .from(taxRules)
    .where(
      sql`${taxRules.ownerType} = 'STUDIO' AND ${taxRules.studioId} = ${scoped.studioId}::uuid`,
    );
  const latest = new Map<string, TaxRuleRow>();
  for (const row of rows as TaxRuleRow[]) {
    const current = latest.get(row.id);
    if (!current || row.version > current.version) {
      latest.set(row.id, row);
    }
  }
  return [...latest.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
}

/** The `TaxRule` wire leaf (one of the three closed modes). */
export function projectTaxRule(row: TaxRuleRow): Record<string, unknown> {
  const base = {
    id: row.id,
    version: row.version,
    ownerType: row.ownerType,
    studioId: row.ownerType === 'CENTRAL' ? null : row.studioId,
    status: row.status,
    jurisdiction: row.jurisdiction,
    taxType: row.taxType,
    currency: row.currency,
    calculationMode: row.calculationMode,
    effectiveFrom: dateText(row.effectiveFrom),
    effectiveTo: row.effectiveTo === null ? null : dateText(row.effectiveTo),
    verifiedAt: row.verifiedAt === null ? null : dateText(row.verifiedAt),
    roundingMode: row.roundingMode,
    roundingUnitMinor: row.roundingUnitMinor,
    calculationScope: row.calculationScope,
    disclaimerText: row.disclaimerText,
    entityVersion: row.entityVersion,
  };
  if (row.ownerType === 'CENTRAL') {
    return {
      ...base,
      code: row.code,
      statutoryRateNumerator: row.statutoryRateNumerator,
      statutoryRateDenominator: row.statutoryRateDenominator,
      dppFactorNumerator: row.dppFactorNumerator,
      dppFactorDenominator: row.dppFactorDenominator,
      fixedAmount: null,
      roundDppBeforeTax: true,
      roundingStage: row.roundingStage ?? 'DPP_THEN_PPN',
      verifiedEvidence: row.evidenceJson ?? [],
      exclusions: row.exclusionsJson ?? [],
      applicabilityConfirmationText: row.applicabilityConfirmationText ?? '',
    };
  }
  const custom = {
    ...base,
    label: row.label ?? '',
    code: row.code,
    verifiedAt: null,
    sources: row.sourcesJson ?? [],
  };
  if (row.calculationMode === 'FIXED_AMOUNT') {
    return {
      ...custom,
      statutoryRateNumerator: null,
      statutoryRateDenominator: null,
      dppFactorNumerator: null,
      dppFactorDenominator: null,
      fixedAmount: row.fixedAmount,
      roundDppBeforeTax: null,
      roundingStage: null,
    };
  }
  return {
    ...custom,
    statutoryRateNumerator: row.statutoryRateNumerator,
    statutoryRateDenominator: row.statutoryRateDenominator,
    dppFactorNumerator: row.dppFactorNumerator,
    dppFactorDenominator: row.dppFactorDenominator,
    fixedAmount: null,
    roundDppBeforeTax: true,
    roundingStage: 'DPP_THEN_PPN',
  };
}
