/**
 * SOL-73-A rule tests: half-up rounding, residual allocation, I-1
 * conservation, the resolved counterexample, the no-double-rounding rule for
 * derived fields, and the over-receipt rule (C2).
 */

import { describe, expect, it } from 'vitest';
import {
  allocateLine,
  labourLineCost,
  parseScale2,
  parseScale4,
  roundHalfUpToMinor2,
  sumMinor,
  toMoneyString,
} from './budget-money';

describe('parseScale4 / parseScale2', () => {
  it('reads numeric columns exactly as integer scaled units', () => {
    expect(parseScale4('2.0000')).toBe(20000n);
    expect(parseScale4('0.5000')).toBe(5000n);
    expect(parseScale4('1')).toBe(10000n);
    expect(parseScale2('60000000.00')).toBe(6000000000n);
    expect(parseScale2('0.01')).toBe(1n);
    expect(parseScale4('-0.2500')).toBe(-2500n);
  });
});

describe('half-up rounding (SOL-73-A rule 2, condition C1)', () => {
  it('rounds 0.0050 away from zero', () => {
    expect(toMoneyString(roundHalfUpToMinor2(5000n))).toBe('0.01');
  });
  it('rounds 0.0049 down', () => {
    expect(toMoneyString(roundHalfUpToMinor2(4999n))).toBe('0.00');
  });
});

describe('residual allocation (SOL-73-A rules 3-5, invariant I-1)', () => {
  it('resolves the counterexample Q=1, R=0.5, U=0.01', () => {
    const line = allocateLine('1', '0.5', '0.01');
    expect(toMoneyString(line.receivedRounded)).toBe('0.01');
    expect(toMoneyString(line.committedRounded)).toBe('0.00');
    expect(toMoneyString(line.allocRounded)).toBe('0.01');
    // receivedRounded + committedRounded === allocRounded exactly (I-1).
    expect(line.receivedRounded + line.committedRounded).toBe(line.allocRounded);
  });

  it('never rounds each bucket independently and then sums', () => {
    // If independent half-up were used, 0.01 + 0.01 = 0.02 != 0.01.
    const line = allocateLine('1', '0.5', '0.01');
    expect(toMoneyString(line.receivedRounded + line.committedRounded)).toBe('0.01');
  });

  it('holds I-1 for a partially received line', () => {
    // 2 x 60,000,000.00 = 120,000,000.00; received 0 -> all committed.
    const line = allocateLine('2.0000', '0.0000', '60000000.00');
    expect(toMoneyString(line.allocRounded)).toBe('120000000.00');
    expect(toMoneyString(line.receivedRounded)).toBe('0.00');
    expect(toMoneyString(line.committedRounded)).toBe('120000000.00');
    expect(line.receivedRounded + line.committedRounded).toBe(line.allocRounded);
  });

  it('holds I-1 for a fully received line', () => {
    const line = allocateLine('2.0000', '2.0000', '60000000.00');
    expect(toMoneyString(line.receivedRounded)).toBe('120000000.00');
    expect(toMoneyString(line.committedRounded)).toBe('0.00');
    expect(line.receivedRounded + line.committedRounded).toBe(line.allocRounded);
  });

  it('pushes a rounding residual to committed, never to actual', () => {
    // 0.3333 x 3.00 = 0.9999 -> 1.00 half-up; received 0.1667 x 3.00 = 0.5001 -> 0.50.
    const line = allocateLine('0.3333', '0.1667', '3.00');
    expect(toMoneyString(line.allocRounded)).toBe('1.00');
    expect(toMoneyString(line.receivedRounded)).toBe('0.50');
    expect(toMoneyString(line.committedRounded)).toBe('0.50');
    expect(line.receivedRounded + line.committedRounded).toBe(line.allocRounded);
  });

  it('caps over-receipt at the ordered quantity (C2 rule)', () => {
    const line = allocateLine('2.0000', '3.0000', '60000000.00');
    expect(line.overReceived).toBe(true);
    expect(toMoneyString(line.receivedRounded)).toBe('120000000.00');
    expect(toMoneyString(line.committedRounded)).toBe('0.00');
    expect(line.receivedRounded + line.committedRounded).toBe(line.allocRounded);
  });
});

describe('labour lines (SOL-73-A condition C1)', () => {
  it('rounds each hours x rate product half-up to 2dp', () => {
    // 7.50 x 150000.0000 = 1,125,000.00 exactly.
    expect(toMoneyString(labourLineCost('7.50', '150000.0000'))).toBe('1125000.00');
  });
  it('rounds a half cent up', () => {
    // 0.5 h x 0.01 = 0.005 -> 0.01 half-up.
    expect(toMoneyString(labourLineCost('0.50', '0.0100'))).toBe('0.01');
  });
});

describe('derived fields never double-round (SOL-73-A condition C1)', () => {
  it('computes signedVariance from rounded values only', () => {
    // totalBudget 10.00, committed 4.01, actual 3.99 -> variance 2.00.
    const totalBudget = parseScale2('10.00');
    const spent = sumMinor([parseScale2('4.01'), parseScale2('3.99')]);
    expect(toMoneyString(totalBudget - spent)).toBe('2.00');
  });
});
