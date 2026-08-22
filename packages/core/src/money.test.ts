import { describe, expect, it } from 'vitest';
import {
  add,
  allocateByRatios,
  allocateEvenly,
  CurrencyMismatchError,
  compare,
  format,
  fromJSON,
  money,
  multiply,
  multiplyRate,
  subtract,
  sum,
  toJSON,
  zero,
} from './money';

describe('money', () => {
  it('holds the amount as minor units', () => {
    expect(money(1234, 'EUR')).toEqual({ amount: 1234n, currency: 'EUR' });
  });

  it('makes the currency code upper case', () => {
    expect(money(0, 'eur').currency).toBe('EUR');
  });

  it('rejects a currency code that is not three letters', () => {
    expect(() => money(0, 'EURO')).toThrow(RangeError);
  });

  it('rejects a fractional amount', () => {
    expect(() => money(12.5, 'EUR')).toThrow(RangeError);
  });
});

describe('add and subtract', () => {
  it('adds two amounts', () => {
    expect(add(money(1050, 'EUR'), money(295, 'EUR'))).toEqual(money(1345, 'EUR'));
  });

  it('subtracts two amounts', () => {
    expect(subtract(money(1050, 'EUR'), money(295, 'EUR'))).toEqual(money(755, 'EUR'));
  });

  it('refuses two different currencies', () => {
    expect(() => add(money(100, 'EUR'), money(100, 'USD'))).toThrow(CurrencyMismatchError);
  });
});

describe('sum', () => {
  it('adds a list of line totals', () => {
    const lines = [money(19999, 'EUR'), money(4550, 'EUR'), money(125, 'EUR')];
    expect(sum(lines)).toEqual(money(24674, 'EUR'));
  });

  it('returns zero for an empty list with a currency', () => {
    expect(sum([], 'IDR')).toEqual(zero('IDR'));
  });

  it('refuses an empty list with no currency', () => {
    expect(() => sum([])).toThrow(RangeError);
  });
});

describe('multiply', () => {
  it('multiplies by a whole quantity', () => {
    expect(multiply(money(1250, 'EUR'), 8)).toEqual(money(10000, 'EUR'));
  });

  it('refuses a fractional quantity', () => {
    expect(() => multiply(money(1250, 'EUR'), 2.5)).toThrow(RangeError);
  });
});

describe('multiplyRate', () => {
  it('applies a 21 percent tax rate', () => {
    expect(multiplyRate(money(10000, 'EUR'), 21n, 100n)).toEqual(money(2100, 'EUR'));
  });

  it('rounds a tie away from zero with half-up', () => {
    // 1005 * 1 / 2 = 502.5 -> 503
    expect(multiplyRate(money(1005, 'EUR'), 1n, 2n, 'half-up')).toEqual(money(503, 'EUR'));
  });

  it('rounds a tie to the even value with half-even', () => {
    // 1005 * 1 / 2 = 502.5 -> 502, because 502 is even
    expect(multiplyRate(money(1005, 'EUR'), 1n, 2n, 'half-even')).toEqual(money(502, 'EUR'));
    // 1007 * 1 / 2 = 503.5 -> 504, because 504 is even
    expect(multiplyRate(money(1007, 'EUR'), 1n, 2n, 'half-even')).toEqual(money(504, 'EUR'));
  });

  it('rounds a negative amount away from zero with half-up', () => {
    expect(multiplyRate(money(-1005, 'EUR'), 1n, 2n, 'half-up')).toEqual(money(-503, 'EUR'));
  });

  it('refuses a zero denominator', () => {
    expect(() => multiplyRate(money(100, 'EUR'), 1n, 0n)).toThrow(RangeError);
  });
});

describe('allocateEvenly', () => {
  it('never loses a cent', () => {
    const shares = allocateEvenly(money(10000, 'EUR'), 3);
    expect(shares).toEqual([money(3334, 'EUR'), money(3333, 'EUR'), money(3333, 'EUR')]);
    expect(sum(shares)).toEqual(money(10000, 'EUR'));
  });

  it('splits one cent into two shares', () => {
    const shares = allocateEvenly(money(1, 'EUR'), 2);
    expect(shares).toEqual([money(1, 'EUR'), money(0, 'EUR')]);
    expect(sum(shares)).toEqual(money(1, 'EUR'));
  });

  it('keeps the sign of a credit note', () => {
    const shares = allocateEvenly(money(-10000, 'EUR'), 3);
    expect(sum(shares)).toEqual(money(-10000, 'EUR'));
  });

  it('refuses a part count of zero', () => {
    expect(() => allocateEvenly(money(100, 'EUR'), 0)).toThrow(RangeError);
  });
});

describe('allocateByRatios', () => {
  it('splits a project fee into a 30/40/30 payment plan', () => {
    const shares = allocateByRatios(money(1_000_001, 'EUR'), [30n, 40n, 30n]);
    expect(sum(shares)).toEqual(money(1_000_001, 'EUR'));
  });

  it('gives the remainder to the first share', () => {
    const shares = allocateByRatios(money(100, 'EUR'), [1n, 1n, 1n]);
    expect(shares).toEqual([money(34, 'EUR'), money(33, 'EUR'), money(33, 'EUR')]);
  });

  it('accepts a zero weight', () => {
    const shares = allocateByRatios(money(100, 'EUR'), [1n, 0n]);
    expect(sum(shares)).toEqual(money(100, 'EUR'));
  });

  it('refuses ratios that add up to zero', () => {
    expect(() => allocateByRatios(money(100, 'EUR'), [0n, 0n])).toThrow(RangeError);
  });

  it('refuses a negative ratio', () => {
    expect(() => allocateByRatios(money(100, 'EUR'), [-1n, 2n])).toThrow(RangeError);
  });
});

describe('compare', () => {
  it('orders two amounts', () => {
    expect(compare(money(100, 'EUR'), money(200, 'EUR'))).toBe(-1);
    expect(compare(money(200, 'EUR'), money(100, 'EUR'))).toBe(1);
    expect(compare(money(100, 'EUR'), money(100, 'EUR'))).toBe(0);
  });
});

describe('format', () => {
  it('writes two decimal places', () => {
    expect(format(money(1234, 'EUR'), 'en-US')).toBe('12.34 EUR');
  });

  it('writes a leading zero in the fraction', () => {
    expect(format(money(1205, 'EUR'), 'en-US')).toBe('12.05 EUR');
  });

  it('writes a negative amount', () => {
    expect(format(money(-1234, 'EUR'), 'en-US')).toBe('-12.34 EUR');
  });

  it('writes a zero-decimal currency', () => {
    expect(format(money(150000, 'IDR'), 'en-US', 0)).toBe('150,000 IDR');
  });
});

describe('JSON transport', () => {
  it('survives a round trip past the safe integer limit', () => {
    const large = money(9_007_199_254_740_993n, 'IDR');
    expect(fromJSON(toJSON(large))).toEqual(large);
  });

  it('writes the amount as a string', () => {
    expect(toJSON(money(1234, 'EUR'))).toEqual({ amount: '1234', currency: 'EUR' });
  });
});
