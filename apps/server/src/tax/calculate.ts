/**
 * The tax calculation stage (SOL-25 revision 24, section 8 and 9.4 B9).
 *
 * Shared by preview and the issue operations. Money is parsed strictly
 * (MONEY_FORMAT_INVALID / MONEY_NOT_EXACT / MONEY_OUT_OF_RANGE), the discount
 * is bounded to `[0, consideration]` (TAX_AMOUNT_INVALID), and the
 * two-stage DPP-then-PPN whole-IDR algorithm runs for RATIONAL_RATE rules.
 * FIXED_AMOUNT rules add the fixed tax to the exact taxable base. The result
 * is the wire `TaxCalculationResult` leaf plus the exact minor-unit numbers
 * the immutable snapshot copies.
 */

import { calculateRationalRate, moneyOutput, type VerifiedPpnRule } from '@stdio/core';
import { parseMoneyMinor } from './application';
import { TaxWriteRejection, taxAmountInvalid } from './codes';
import type { TaxRuleRow } from './rules';

export type CalculationOutcome = {
  /** The exact wire `TaxCalculationResult` leaf. */
  result: Record<string, unknown>;
  considerationBeforeDiscountMinor: bigint;
  discountMinor: bigint;
  taxableBaseMinor: bigint;
  totalMinor: bigint;
  dppRounded: string | null;
  ppnRounded: string | null;
  fixedTaxAmountMinor: bigint | null;
};

/** The whole-IDR string `"N.00"` to its minor-unit value. */
function wholeIdrMinor(text: string): bigint {
  return BigInt(text.slice(0, text.length - 3)) * 100n;
}

/**
 * Runs the shared money + calculation stage for a resolved rule.
 * `considerationBeforeDiscount` and `discount` are contract MoneyInput values
 * (string or JSON number).
 */
export function calculateForRule(
  rule: TaxRuleRow,
  considerationBeforeDiscount: unknown,
  discount: unknown,
): CalculationOutcome {
  const considerationMinor = parseMoneyMinor(considerationBeforeDiscount);
  const discountMinor = parseMoneyMinor(discount);
  if (discountMinor < 0n || discountMinor > considerationMinor) {
    throw new TaxWriteRejection(taxAmountInvalid());
  }
  const taxableBaseMinor = considerationMinor - discountMinor;

  if (rule.calculationMode === 'FIXED_AMOUNT') {
    const fixedMinor = parseMoneyMinor(rule.fixedAmount ?? '0.00');
    const totalMinor = taxableBaseMinor + fixedMinor;
    return {
      result: {
        calculationMode: 'FIXED_AMOUNT',
        ruleId: rule.id,
        ruleVersion: rule.version,
        ruleStatus: 'CUSTOM_UNVERIFIED',
        documentCurrency: 'IDR',
        considerationBeforeDiscount: moneyOutput(considerationMinor),
        discount: moneyOutput(discountMinor),
        taxableBase: moneyOutput(taxableBaseMinor),
        fixedTaxAmount: moneyOutput(fixedMinor),
        dppExactNumerator: null,
        dppExactDenominator: null,
        dppRounded: null,
        ppnExactNumerator: null,
        ppnExactDenominator: null,
        ppnRounded: null,
        roundingStage: null,
        total: moneyOutput(totalMinor),
      },
      considerationBeforeDiscountMinor: considerationMinor,
      discountMinor,
      taxableBaseMinor,
      totalMinor,
      dppRounded: null,
      ppnRounded: null,
      fixedTaxAmountMinor: fixedMinor,
    };
  }

  const engineRule: VerifiedPpnRule = {
    dppFactorNumerator: rule.dppFactorNumerator ?? '1',
    dppFactorDenominator: rule.dppFactorDenominator ?? '1',
    statutoryRateNumerator: rule.statutoryRateNumerator ?? '0',
    statutoryRateDenominator: rule.statutoryRateDenominator ?? '1',
    roundingUnitMinor: rule.roundingUnitMinor,
  } as VerifiedPpnRule;
  const engine = calculateRationalRate({
    considerationBeforeDiscount: considerationMinor,
    discount: discountMinor,
    rule: engineRule,
  });
  const ppnMinor = wholeIdrMinor(engine.ppnRounded);

  return {
    result: {
      calculationMode: 'RATIONAL_RATE',
      ruleId: rule.id,
      ruleVersion: rule.version,
      ruleStatus: rule.status,
      documentCurrency: 'IDR',
      considerationBeforeDiscount: engine.considerationBeforeDiscount,
      discount: engine.discount,
      taxableBase: engine.taxableBase,
      fixedTaxAmount: null,
      dppExactNumerator: engine.dppExactNumerator,
      dppExactDenominator: engine.dppExactDenominator,
      dppRounded: engine.dppRounded,
      ppnExactNumerator: engine.ppnExactNumerator,
      ppnExactDenominator: engine.ppnExactDenominator,
      ppnRounded: engine.ppnRounded,
      roundingStage: 'DPP_THEN_PPN',
      total: engine.total,
    },
    considerationBeforeDiscountMinor: considerationMinor,
    discountMinor,
    taxableBaseMinor,
    totalMinor: taxableBaseMinor + ppnMinor,
    dppRounded: engine.dppRounded,
    ppnRounded: engine.ppnRounded,
    fixedTaxAmountMinor: null,
  };
}
