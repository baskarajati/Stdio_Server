import { describe, expect, it } from 'vitest';
import { money } from './money';
import {
  MAX_MINOR_UNITS,
  moneyFromDecimal,
  moneyToDecimal,
  parseMoneyInput,
} from './money-decimal';

describe('moneyToDecimal', () => {
  it('writes a canonical 2dp decimal string', () => {
    expect(moneyToDecimal(money(1234n, 'IDR'))).toBe('12.34');
  });

  it('writes zero with two decimal places', () => {
    expect(moneyToDecimal(money(0n, 'IDR'))).toBe('0.00');
  });

  it('writes amounts below one major unit', () => {
    expect(moneyToDecimal(money(5n, 'IDR'))).toBe('0.05');
  });

  it('writes negative amounts', () => {
    expect(moneyToDecimal(money(-1234n, 'IDR'))).toBe('-12.34');
    expect(moneyToDecimal(money(-5n, 'IDR'))).toBe('-0.05');
  });

  it('writes the numeric(20,2) maximum exactly', () => {
    expect(moneyToDecimal(money(MAX_MINOR_UNITS, 'IDR'))).toBe('999999999999999999.99');
  });
});

describe('moneyFromDecimal', () => {
  it('reads a 2dp decimal string exactly', () => {
    expect(moneyFromDecimal('12.34', 'IDR')).toEqual(money(1234n, 'IDR'));
  });

  it('reads a whole number as whole units', () => {
    expect(moneyFromDecimal('250000', 'IDR')).toEqual(money(25000000n, 'IDR'));
  });

  it('reads one decimal place', () => {
    expect(moneyFromDecimal('12.3', 'IDR')).toEqual(money(1230n, 'IDR'));
  });

  it('reads negative amounts', () => {
    expect(moneyFromDecimal('-0.50', 'IDR')).toEqual(money(-50n, 'IDR'));
  });

  it('rejects more than two decimal places', () => {
    expect(() => moneyFromDecimal('12.345', 'IDR')).toThrow(RangeError);
  });

  it('rejects a non-decimal string', () => {
    expect(() => moneyFromDecimal('12,34', 'IDR')).toThrow(RangeError);
    expect(() => moneyFromDecimal('', 'IDR')).toThrow(RangeError);
    expect(() => moneyFromDecimal('1e3', 'IDR')).toThrow(RangeError);
  });

  it('rejects an amount outside numeric(20,2)', () => {
    expect(() => moneyFromDecimal('1000000000000000000.00', 'IDR')).toThrow(RangeError);
  });
});

describe('parseMoneyInput', () => {
  it('accepts the contract string form', () => {
    expect(parseMoneyInput('12.34', 'IDR')).toEqual(money(1234n, 'IDR'));
  });

  it('accepts the contract number form', () => {
    expect(parseMoneyInput(12.34, 'IDR')).toEqual(money(1234n, 'IDR'));
    expect(parseMoneyInput(250000, 'IDR')).toEqual(money(25000000n, 'IDR'));
  });

  it('rounds a deep decimal string half-up at the second place', () => {
    expect(parseMoneyInput('1.005', 'IDR')).toEqual(money(101n, 'IDR'));
    expect(parseMoneyInput('1.004', 'IDR')).toEqual(money(100n, 'IDR'));
    expect(parseMoneyInput('-1.005', 'IDR')).toEqual(money(-101n, 'IDR'));
  });

  it('rejects NaN and infinity', () => {
    expect(() => parseMoneyInput(Number.NaN, 'IDR')).toThrow(RangeError);
    expect(() => parseMoneyInput(Number.POSITIVE_INFINITY, 'IDR')).toThrow(RangeError);
  });

  it('rejects an amount outside numeric(20,2)', () => {
    expect(() => parseMoneyInput('1000000000000000000.00', 'IDR')).toThrow(RangeError);
    expect(() => parseMoneyInput(1e19, 'IDR')).toThrow(RangeError);
  });

  it('round-trips every value through the decimal column form', () => {
    const samples = [0n, 1n, 99n, 100n, 123456789n, -1n, -999n, MAX_MINOR_UNITS, -MAX_MINOR_UNITS];
    for (const amount of samples) {
      const value = money(amount, 'IDR');
      expect(moneyFromDecimal(moneyToDecimal(value), 'IDR')).toEqual(value);
    }
  });
});
