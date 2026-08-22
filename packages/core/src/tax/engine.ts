/**
 * The tax calculation engine. SOL-25 revision 24, section 9.4 B9 (reference
 * algorithm) and section 4 (`TaxCalculationResult`). All amounts are integer
 * minor units; 1 IDR = 100 minor units. Rounding is the ratified
 * `divideRounded(..., 'half-up')`: ties go away from zero, sign-symmetric.
 *
 *   base_minor = sum(selected line amounts) - allocated_document_discount
 *   dpp_exact  = base_minor * dppFactorNumerator / dppFactorDenominator
 *   dpp_idr    = round_half_up(dpp_exact, 100)         # whole IDR
 *   dpp_minor  = dpp_idr * 100
 *   ppn_exact  = dpp_minor * statutoryRateNumerator / statutoryRateDenominator
 *   ppn_idr    = round_half_up(ppn_exact, 100)
 *   ppn_minor  = ppn_idr * 100
 *   total_minor = base_minor + ppn_minor
 */

import { divideRounded, type Rounding } from '../money';
import { moneyOutput, wholeIdrOutput } from './money-input';
import type { VerifiedPpnRule } from './ppn-2025';

/** The rule fields the two-stage engine reads. Server rule rows satisfy it. */
export type EngineRuleInput = Pick<
  VerifiedPpnRule,
  | 'dppFactorNumerator'
  | 'dppFactorDenominator'
  | 'statutoryRateNumerator'
  | 'statutoryRateDenominator'
  | 'roundingUnitMinor'
>;

/** The result of one rational-rate PPN calculation (section 4). */
export type RationalRateResult = {
  readonly calculationMode: 'RATIONAL_RATE';
  readonly considerationBeforeDiscount: string; // MoneyOutput
  readonly discount: string; // MoneyOutput
  readonly taxableBase: string; // MoneyOutput
  readonly dppExactNumerator: string;
  readonly dppExactDenominator: string;
  readonly dppRounded: string; // WholeIDRMoneyOutput
  readonly ppnExactNumerator: string;
  readonly ppnExactDenominator: string;
  readonly ppnRounded: string; // WholeIDRMoneyOutput
  readonly roundingStage: 'DPP_THEN_PPN';
  readonly total: string; // MoneyOutput
};

export type CalculationInput = {
  /** Exact minor units before discount. */
  readonly considerationBeforeDiscount: bigint;
  /** Exact minor units of the allocated bucket discount (server-owned). */
  readonly discount: bigint;
  readonly rule: EngineRuleInput;
};

/**
 * Runs the two-stage DPP-then-PPN whole-IDR calculation. `divideRounded`
 * rounds ties away from zero, so a reversal base exactly negates the original
 * (rounding decision M5).
 */
export function calculateRationalRate({
  considerationBeforeDiscount,
  discount,
  rule,
}: CalculationInput): RationalRateResult {
  const baseMinor = considerationBeforeDiscount - discount;
  const dppFactorNumerator = BigInt(rule.dppFactorNumerator);
  const dppFactorDenominator = BigInt(rule.dppFactorDenominator);
  const rateNumerator = BigInt(rule.statutoryRateNumerator);
  const rateDenominator = BigInt(rule.statutoryRateDenominator);
  const unitMinor = BigInt(rule.roundingUnitMinor);

  // DPP exact is a rational; rounding goes to the whole-IDR unit.
  const dppIdr = divideRounded(
    baseMinor * dppFactorNumerator,
    dppFactorDenominator * unitMinor,
    'half-up',
  );
  const dppMinor = dppIdr * unitMinor;
  const ppnIdr = divideRounded(dppMinor * rateNumerator, rateDenominator * unitMinor, 'half-up');
  const ppnMinor = ppnIdr * unitMinor;

  return {
    calculationMode: 'RATIONAL_RATE',
    considerationBeforeDiscount: moneyOutput(considerationBeforeDiscount),
    discount: moneyOutput(discount),
    taxableBase: moneyOutput(baseMinor),
    dppExactNumerator: (baseMinor * dppFactorNumerator).toString(),
    dppExactDenominator: dppFactorDenominator.toString(),
    dppRounded: wholeIdrOutput(dppMinor),
    ppnExactNumerator: (dppMinor * rateNumerator).toString(),
    ppnExactDenominator: rateDenominator.toString(),
    ppnRounded: wholeIdrOutput(ppnMinor),
    roundingStage: 'DPP_THEN_PPN',
    total: moneyOutput(baseMinor + ppnMinor),
  };
}

/** Re-exported for callers that need the ratified rounding function. */
export { divideRounded, type Rounding };
