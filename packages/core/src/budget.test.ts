/**
 * Unit tests for the SOL-19 budget math (SOL-73-A ruling + revision 6).
 *
 * Pins the ratified rules: the half-up tie rule (C1), presentation-only
 * rounding (C2), the residual-allocation counterexample, the over-receipt
 * rule (C2), and invariant I-1 on every line.
 */
import { describe, expect, it } from 'vitest';
import {
  allocatePoLine,
  assertInvariantOne,
  formatScaled,
  labourCost,
  parseScaled,
} from './budget';

const q4 = (text: string) => parseScaled(text, 4);
const u2 = (text: string) => parseScaled(text, 2);
const h2 = (text: string) => parseScaled(text, 2);
const r4 = (text: string) => parseScaled(text, 4);

describe('parseScaled / formatScaled', () => {
  it('round-trips a quantity at 4dp', () => {
    expect(formatScaled(parseScaled('2.5000', 4), 4)).toBe('2.5000');
  });
  it('zero-pads a short fraction', () => {
    expect(parseScaled('0.5', 4)).toBe(5000n);
  });
  it('accepts an integer without a fraction', () => {
    expect(parseScaled('3', 4)).toBe(30000n);
  });
  it('rejects a fraction longer than the scale', () => {
    expect(() => parseScaled('0.12345', 4)).toThrow();
  });
  it('rejects a float token', () => {
    expect(() => parseScaled('1e2', 4)).toThrow();
  });
});

describe('residual allocation (section 1.2)', () => {
  it('splits a partial receipt: Q=1, R=0.5, U=0.01 (the counterexample)', () => {
    // Ruling SOL-73-A: 1 x 0.01 = 0.0100 -> 0.01, 0.5 x 0.01 = 0.0050 ->
    // 0.01 half-up, committed = 0.01 - 0.01 = 0.00. Actual 0.01, committed
    // 0.00, sum 0.01 — never 0.01 + 0.01 != 0.01.
    const line = allocatePoLine(q4('1'), q4('0.5'), u2('0.01'));
    expect(line.allocRounded).toBe(1n);
    expect(line.receivedRounded).toBe(1n);
    expect(line.committedRounded).toBe(0n);
    expect(line.overReceived).toBe(false);
    assertInvariantOne(line);
  });

  it('gives the whole value to committed when nothing is received', () => {
    const line = allocatePoLine(q4('2'), q4('0'), u2('60000000.00'));
    expect(line.allocRounded).toBe(12000000000n);
    expect(line.receivedRounded).toBe(0n);
    expect(line.committedRounded).toBe(12000000000n);
    assertInvariantOne(line);
  });

  it('moves everything to actual when the line is fully received', () => {
    const line = allocatePoLine(q4('2'), q4('2'), u2('60000000.00'));
    expect(line.allocRounded).toBe(12000000000n);
    expect(line.receivedRounded).toBe(12000000000n);
    expect(line.committedRounded).toBe(0n);
    assertInvariantOne(line);
  });

  it('holds I-1 across a sweep of quantities and receipts', () => {
    for (const q of ['0.0001', '1', '2.5000', '99.9999']) {
      for (const r of ['0', '0.0001', '0.5', q]) {
        const line = allocatePoLine(q4(q), q4(r), u2('1234567.89'));
        assertInvariantOne(line);
        if (line.overReceived) {
          expect(line.committedRounded).toBe(0n);
          expect(line.receivedRounded).toBeGreaterThanOrEqual(line.allocRounded);
        } else {
          expect(line.receivedRounded + line.committedRounded).toBe(line.allocRounded);
        }
      }
    }
  });

  it('keeps the residual in committed when the received share rounds up', () => {
    // Q x U = 0.0100 -> 0.01, R x U = 0.0050 -> 0.01 (half-up tie):
    // committed = 0.00, the residual lands in committed, never in actual.
    const line = allocatePoLine(q4('1'), q4('0.5'), u2('0.01'));
    expect(line.receivedRounded).toBe(1n);
    expect(line.committedRounded).toBe(0n);
  });
});

describe('over-receipt rule (condition C2)', () => {
  it('carries the full received value as actual and zeroes committed', () => {
    // R = 2 > Q = 1: true cost 2 x 100.00 = 200.00, committed never negative.
    const line = allocatePoLine(q4('1'), q4('2'), u2('100.00'));
    expect(line.overReceived).toBe(true);
    expect(line.receivedRounded).toBe(20000n);
    expect(line.committedRounded).toBe(0n);
    assertInvariantOne(line);
  });

  it('flags over-receipt even when rounding would hide it', () => {
    const line = allocatePoLine(q4('1'), q4('1.0001'), u2('0.01'));
    expect(line.overReceived).toBe(true);
    assertInvariantOne(line);
  });
});

describe('labour cost (section 2.6, condition C1)', () => {
  it('computes 7.5 h at 125000.0000 exactly', () => {
    expect(labourCost(h2('7.50'), r4('125000.0000'))).toBe(93750000n);
  });

  it('rounds a half-up tie away from zero per entry', () => {
    // 1.00 h x 0.0050 = 0.0050 -> 0.01, independent of any other line.
    expect(labourCost(h2('1.00'), r4('0.0050'))).toBe(1n);
  });

  it('never double-rounds: the product rounds once to 2dp', () => {
    // 0.33 h x 1.0000 = 0.3300 -> 0.33.
    expect(labourCost(h2('0.33'), r4('1.0000'))).toBe(33n);
    // 0.335 h cannot be represented in 2dp hours; 0.34 h x 1.0000 = 0.34.
    expect(labourCost(h2('0.34'), r4('1.0000'))).toBe(34n);
  });
});

describe('I-1 assertion', () => {
  it('throws when the parts do not sum to the rounded total', () => {
    expect(() =>
      assertInvariantOne({
        allocRounded: 10n,
        receivedRounded: 6n,
        committedRounded: 3n,
        overReceived: false,
      }),
    ).toThrow(/I-1 violated/);
  });
  it('throws when an over-received line keeps a committed value', () => {
    expect(() =>
      assertInvariantOne({
        allocRounded: 10n,
        receivedRounded: 12n,
        committedRounded: 1n,
        overReceived: true,
      }),
    ).toThrow(/over-receipt rule violated/);
  });
});
