/**
 * Required vectors for the ratified money and tax rules. SOL-25 revision 24:
 * section 3 money categories (N20), N27 date resolution, N28 MoneyOutput
 * canonical form, N33 whole-IDR rejection, the B9 reference algorithm, and
 * the B15 / Q25-10 allocation vector.
 */

import { describe, expect, it } from 'vitest';
import { allocateByRatios, divideRounded, money } from '../money';
import { calculateRationalRate } from './engine';
import {
  MAX_MINOR_UNITS,
  MoneyInputError,
  moneyOutput,
  parseStrictMoneyInput,
  wholeIdrOutput,
} from './money-input';
import { PPN_STANDARD_2025, resolveVerifiedRule } from './ppn-2025';

describe('MoneyInput grammar (section 3, N20)', () => {
  it.each(['', '.5', '1.', '1e', '1e+', '--1', ' 1 ', '1  ', '1,5', 'NaN', 'Infinity'])(
    'rejects "%s" with MONEY_FORMAT_INVALID',
    (text) => {
      expect(() => parseStrictMoneyInput(text)).toThrowError(MoneyInputError);
      try {
        parseStrictMoneyInput(text);
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(MoneyInputError);
        expect((error as MoneyInputError).code).toBe('MONEY_FORMAT_INVALID');
      }
    },
  );

  it('rejects a non-finite runtime number with MONEY_FORMAT_INVALID', () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      try {
        parseStrictMoneyInput(value);
        expect.unreachable();
      } catch (error) {
        expect((error as MoneyInputError).code).toBe('MONEY_FORMAT_INVALID');
      }
    }
  });

  it('rejects a JSON number at or above 2^53 with MONEY_NOT_EXACT', () => {
    for (const value of [9007199254740992, -9007199254740992, 1e21, -1e30]) {
      try {
        parseStrictMoneyInput(value);
        expect.unreachable();
      } catch (error) {
        expect((error as MoneyInputError).code).toBe('MONEY_NOT_EXACT');
      }
    }
  });

  it('accepts JSON number 9007199254740991 (below 2^53)', () => {
    expect(parseStrictMoneyInput(9007199254740991)).toBe(900719925474099100n);
  });

  it('rejects a resolved value outside numeric(20,2) with MONEY_OUT_OF_RANGE', () => {
    for (const text of ['1e30', '99999999999999999999.99', '1000000000000000000.00', '-1e40']) {
      try {
        parseStrictMoneyInput(text);
        expect.unreachable();
      } catch (error) {
        expect((error as MoneyInputError).code).toBe('MONEY_OUT_OF_RANGE');
      }
    }
  });

  it('accepts the exact string examples and resolves them canonically', () => {
    expect(parseStrictMoneyInput('0')).toBe(0n);
    expect(parseStrictMoneyInput('-0')).toBe(0n);
    expect(parseStrictMoneyInput('+1')).toBe(100n);
    expect(parseStrictMoneyInput('1.0')).toBe(100n);
    expect(parseStrictMoneyInput('1e5')).toBe(10_000_000n); // 100000.00
    expect(parseStrictMoneyInput('1E+5')).toBe(10_000_000n);
    expect(parseStrictMoneyInput('1e-5')).toBe(0n); // 0.00001 -> 0.00
    expect(parseStrictMoneyInput('1.005')).toBe(101n); // 1.01 half-up
    expect(parseStrictMoneyInput('1.004')).toBe(100n); // 1.00
    expect(parseStrictMoneyInput(1e5)).toBe(10_000_000n);
  });

  it('accepts the numeric(20,2) boundary values', () => {
    expect(parseStrictMoneyInput('999999999999999999.99')).toBe(MAX_MINOR_UNITS);
    expect(parseStrictMoneyInput('-999999999999999999.99')).toBe(-MAX_MINOR_UNITS);
  });
});

describe('MoneyOutput canonical form (section 3, N28)', () => {
  it('emits canonical two-decimal text and zero only as 0.00', () => {
    expect(moneyOutput(0n)).toBe('0.00');
    expect(moneyOutput(1n)).toBe('0.01');
    expect(moneyOutput(-1n)).toBe('-0.01');
    expect(moneyOutput(12_345n)).toBe('123.45');
    expect(moneyOutput(-12_345n)).toBe('-123.45');
  });

  it('whole-IDR output rejects fractional rupiah (N33)', () => {
    expect(wholeIdrOutput(91_666_700n)).toBe('916667.00');
    expect(() => wholeIdrOutput(91_666_650n)).toThrowError(); // 916666.50
    expect(() => wholeIdrOutput(0n)).not.toThrowError();
  });
});

describe('divideRounded (section 9.4 B9, M5)', () => {
  it('rounds ties away from zero and is sign-symmetric', () => {
    expect(divideRounded(5n, 2n, 'half-up')).toBe(3n);
    expect(divideRounded(-5n, 2n, 'half-up')).toBe(-3n);
    expect(divideRounded(3n, 2n, 'half-up')).toBe(2n);
    expect(divideRounded(-3n, 2n, 'half-up')).toBe(-2n);
    expect(divideRounded(1n, 3n, 'half-up')).toBe(0n);
    expect(divideRounded(-1n, 3n, 'half-up')).toBe(0n);
  });
});

describe('allocateByRatios (B15 / Q25-10 option A)', () => {
  it('allocates the unequal-line selected-subset vector exactly', () => {
    const documentDiscount = money(10_000_000n, 'IDR'); // Rp100,000.00
    const shares = allocateByRatios(documentDiscount, [75_000_000n, 25_000_000n]);
    const lineA = shares[0];
    const lineB = shares[1];
    expect(lineA?.amount).toBe(7_500_000n); // Rp75,000.00
    expect(lineB?.amount).toBe(2_500_000n); // Rp25,000.00
    expect((lineA?.amount ?? 0n) + (lineB?.amount ?? 0n)).toBe(documentDiscount.amount);
  });

  it('gives the remainder one minor unit at a time to the first shares', () => {
    const shares = allocateByRatios(money(100n, 'IDR'), [1n, 1n, 1n]);
    expect(shares.map((share) => share.amount)).toEqual([34n, 33n, 33n]);
    expect(shares.reduce((sum, share) => sum + share.amount, 0n)).toBe(100n);
  });
});

describe('B9 reference algorithm (section 9.4)', () => {
  const rule = PPN_STANDARD_2025;

  it('produces the approved example exactly', () => {
    // Consideration Rp750,000.00; selected-bucket discount Rp75,000.00.
    const result = calculateRationalRate({
      considerationBeforeDiscount: 75_000_000n,
      discount: 7_500_000n,
      rule,
    });
    expect(result.considerationBeforeDiscount).toBe('750000.00');
    expect(result.discount).toBe('75000.00');
    expect(result.taxableBase).toBe('675000.00');
    expect(result.dppRounded).toBe('618750.00');
    expect(result.ppnRounded).toBe('74250.00');
    expect(result.total).toBe('749250.00');
    expect(result.dppExactNumerator).toBe('742500000'); // 67500000 x 11
    expect(result.dppExactDenominator).toBe('12');
    expect(result.ppnExactNumerator).toBe('742500000'); // 61875000 x 12
    expect(result.ppnExactDenominator).toBe('100');
  });

  it('rounds DPP to whole rupiah before PPN (roundDppBeforeTax)', () => {
    // Base 100,000,000 minor (Rp1,000,000.00): DPP exact = 916,666.66...
    // DPP rounds to Rp916,667.00; PPN = 12% of the rounded DPP.
    const result = calculateRationalRate({
      considerationBeforeDiscount: 100_000_000n,
      discount: 0n,
      rule,
    });
    expect(result.dppRounded).toBe('916667.00');
    expect(result.ppnRounded).toBe('110000.00'); // 916667 x 12 / 100
    expect(result.total).toBe('1110000.00');
  });

  it('is sign-symmetric for a reversal base (M5)', () => {
    const result = calculateRationalRate({
      considerationBeforeDiscount: -75_000_000n,
      discount: -7_500_000n,
      rule,
    });
    expect(result.taxableBase).toBe('-675000.00');
    expect(result.dppRounded).toBe('-618750.00');
    expect(result.ppnRounded).toBe('-74250.00');
    expect(result.total).toBe('-749250.00');
  });

  it('resolves the verified rule by half-open interval (N27, N42)', () => {
    expect(resolveVerifiedRule('2024-12-31')).toBeNull();
    expect(resolveVerifiedRule('2025-01-01')).toBe(rule);
    expect(resolveVerifiedRule('2026-01-01')).toBe(rule);
  });

  it('fails closed on an overlapping register (N41)', () => {
    const corrupt = [
      { ...PPN_STANDARD_2025, id: 'V1', effectiveFrom: '2025-01-01', effectiveTo: '2026-01-01' },
      {
        ...PPN_STANDARD_2025,
        id: 'V2',
        version: 2,
        effectiveFrom: '2025-06-01',
        effectiveTo: null,
      },
    ];
    expect(() => resolveVerifiedRule('2025-07-01', corrupt)).toThrowError(
      'TAX_RULE_REGISTER_INVALID',
    );
  });
});
