/**
 * Budget-versus-actual money math (SOL-19 revision 6, section 1; ruling
 * SOL-73-A).
 *
 * Every amount is an integer count of minor units; no float exists on the
 * path. Quantities are `numeric(20,4)` (4 decimal places), unit costs are
 * `numeric(20,2)`, so one PO-line product has up to 6 decimal places. The
 * wire report rounds to exactly 2 decimal places.
 *
 * The rounding rule (SOL-73-A, rules 3 and 4, conditions C1 and C2):
 *
 * - Per line the server computes the exact un-rounded values.
 * - The line total and the received share round half-up to 2dp.
 * - The residual is assigned to the committed share, so the per-line parts
 *   sum to the rounded line total exactly (I-1).
 * - Rounding is NEVER applied independently per bucket and then summed.
 * - Derived fields (signedVariance, forecastRemaining) are computed from the
 *   already-rounded values and are never rounded a second time (C1).
 * - Labour lines: each `hours x rate` product rounds half-up to 2dp
 *   independently and then sums; labour has no split bucket (C1).
 * - Over-receipt rule (C2): when `receivedQuantity > quantity`, the received
 *   bucket is capped at the ordered quantity. The excess receipt value is
 *   not recognized in the report, committed never goes negative, and I-1
 *   holds. Stated explicitly because the report is read-only and cannot
 *   reject a receipt.
 *
 * Invariant I-1 (per-line conservation), asserted in the building transaction
 * and in a server-side unit test:
 *
 *   receivedRounded + committedRounded === allocRounded
 */

import { divideRounded } from '@stdio/core';

/** One line's allocation in minor units (2dp). */
export type LineAllocation = {
  /** `quantity x unitCost`, rounded half-up to 2dp. */
  allocRounded: bigint;
  /** `min(received, quantity) x unitCost`, rounded half-up to 2dp. */
  receivedRounded: bigint;
  /** `allocRounded - receivedRounded`; the residual lands here (I-1). */
  committedRounded: bigint;
  /** True when `receivedQuantity > quantity` (the over-receipt rule applied). */
  overReceived: boolean;
};

const SCALE4 = 10n ** 4n;
const SCALE2 = 10n ** 2n;

/** Parses a `numeric(20,4)` column string (e.g. `2.0000`) to 1e-4 units. */
export function parseScale4(value: string): bigint {
  const match = /^(-?)(\d+)(?:\.(\d{1,4}))?$/.exec(value.trim());
  if (!match) {
    throw new RangeError(`Quantity "${value}" is not a numeric(20,4) value.`);
  }
  const sign = match[1] === '-' ? -1n : 1n;
  const whole = BigInt(match[2] ?? '0');
  const frac = BigInt((match[3] ?? '').padEnd(4, '0'));
  return sign * (whole * SCALE4 + frac);
}

/** Parses a `numeric(20,2)` column string (e.g. `60000000.00`) to 1e-2 units. */
export function parseScale2(value: string): bigint {
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) {
    throw new RangeError(`Money "${value}" is not a numeric(20,2) value.`);
  }
  const sign = match[1] === '-' ? -1n : 1n;
  const whole = BigInt(match[2] ?? '0');
  const frac = BigInt((match[3] ?? '').padEnd(2, '0'));
  return sign * (whole * SCALE2 + frac);
}

/** Rounds a 1e-6-unit product (4dp x 2dp) half-up to 1e-2 minor units. */
export function roundHalfUpToMinor2(productScale6: bigint): bigint {
  // divideRounded rounds ties away from zero (half-up), sign-symmetric.
  return divideRounded(productScale6, SCALE4, 'half-up');
}

/**
 * Allocates one PO line between the received (actual) and committed buckets.
 *
 * The over-receipt rule caps the received share at the ordered quantity, so
 * `committedRounded` is never negative and I-1 holds by construction.
 */
export function allocateLine(
  quantity: string,
  receivedQuantity: string,
  unitCost: string,
): LineAllocation {
  const q = parseScale4(quantity);
  const r = parseScale4(receivedQuantity);
  const u = parseScale2(unitCost);

  const overReceived = r > q;
  const received = overReceived ? q : r;

  const allocated = q * u; // 1e-6 units, exact
  const receivedScaled = received * u; // 1e-6 units, exact

  const allocRounded = roundHalfUpToMinor2(allocated);
  const receivedRounded = roundHalfUpToMinor2(receivedScaled);
  const committedRounded = allocRounded - receivedRounded;

  // I-1: the per-line parts sum to the rounded line total exactly.
  if (receivedRounded + committedRounded !== allocRounded) {
    throw new RangeError('I-1 conservation failed for a purchase-order line.');
  }
  if (committedRounded < 0n) {
    throw new RangeError('The committed bucket went negative for a purchase-order line.');
  }

  return { allocRounded, receivedRounded, committedRounded, overReceived };
}

/**
 * The labour actual cost of one timesheet entry: `hours x rate` rounded
 * half-up to 2dp. Hours are `numeric(10,2)` (1e-2 units), the rate snapshot
 * is `numeric(20,4)` (1e-4 units), so the product has 6 decimal places.
 * Labour has no split bucket; the residual rule does not apply (C1).
 */
export function labourLineCost(hours: string, rate: string): bigint {
  const h = parseScale2(hours);
  const r = parseScale4(rate);
  return roundHalfUpToMinor2(h * r);
}

/** Formats 1e-2 minor units as the canonical 2dp wire string (never -0.00). */
export function toMoneyString(minor: bigint): string {
  const negative = minor < 0n;
  const absolute = negative ? -minor : minor;
  const whole = absolute / SCALE2;
  const cents = absolute % SCALE2;
  const text = `${whole}.${cents.toString().padStart(2, '0')}`;
  if (negative && absolute === 0n) {
    return '0.00';
  }
  return negative ? `-${text}` : text;
}

/** Sums a list of 1e-2 minor-unit values. */
export function sumMinor(values: readonly bigint[]): bigint {
  return values.reduce((carry, value) => carry + value, 0n);
}
