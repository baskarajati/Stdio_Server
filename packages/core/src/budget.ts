/**
 * Budget-versus-actual money math (SOL-19 revision 6, section 1).
 *
 * The ratified rules, pinned here with BigInt-only arithmetic:
 *
 * - I-1 per PO line: `actualValue + committedValue = quantity x unitCost`.
 * - Half-up ties away from zero (`0.005 -> 0.01`), never double-rounded:
 *   derived fields are computed from already-rounded values and are not
 *   rounded a second time (SOL-73-A condition C1).
 * - Per line the server computes the un-rounded allocation, rounds the line
 *   total and the received share half-up, and gives the residual to the
 *   committed share so the parts sum to the rounded line total exactly.
 * - Rounding is presentation-only: the stored quantities and rates stay
 *   exact (condition C2). Over-receipt (`R > Q`) is a documented rule, not a
 *   rounding case: actual carries the full received value (the true cost),
 *   committed is zero, never negative, and I-1 is asserted only for
 *   `0 <= R <= Q`.
 * - Labour (condition C1): each `hours x effective_hourly_rate` product
 *   rounds half-up to 2dp independently and then sums; labour has no split
 *   bucket, so no residual rule applies.
 */

import { divideRounded } from './money';

/** The 2dp money scale used by every `numeric(20,2)` column. */
export const MONEY_SCALE = 2n;
/** The 4dp scale of quantities and the hourly-rate snapshots. */
export const QUANTITY_SCALE = 4n;

/** One PO line's report allocation, in integer minor units (2dp). */
export type PoLineAllocation = {
  /** `round(Q x U)` half-up — the line total. */
  allocRounded: bigint;
  /** `round(R x U)` half-up — the received (actual) share. */
  receivedRounded: bigint;
  /** The residual `allocRounded - receivedRounded`; zero on over-receipt. */
  committedRounded: bigint;
  /** True when `R > Q`; the documented over-receipt rule applies. */
  overReceived: boolean;
};

/**
 * Parses an exact decimal string at a fixed scale into integer minor units.
 * The report reads `numeric(20,4)` and `numeric(20,2)` column strings, which
 * never exceed the column scale; shorter fractions are zero-padded. A float
 * never appears on this path (I-5).
 */
export function parseScaled(text: string, scale: number): bigint {
  if (typeof text !== 'string' || text.length === 0) {
    throw new Error(`Not a decimal string: ${JSON.stringify(text)}`);
  }
  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(text.trim());
  if (!match) {
    throw new Error(`Not a decimal string: ${JSON.stringify(text)}`);
  }
  const sign = match[1] === '-' ? -1n : 1n;
  const whole = BigInt(match[2] ?? '0');
  const digits = match[3] ?? '';
  if (digits.length > scale) {
    throw new Error(`Not a decimal string: ${JSON.stringify(text)}`);
  }
  const fraction = digits.padEnd(scale, '0');
  return sign * (whole * 10n ** BigInt(scale) + BigInt(fraction));
}

/** Formats integer minor units at a scale back to the canonical decimal string. */
export function formatScaled(minor: bigint, scale: number): string {
  const negative = minor < 0n;
  const absolute = negative ? -minor : minor;
  const divisor = 10n ** BigInt(scale);
  const whole = (absolute / divisor).toString();
  const fraction = (absolute % divisor).toString().padStart(scale, '0');
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}

/**
 * Allocates one PO line (section 1.2). `qty4` and `received4` are integer
 * minor units at 4dp; `unitCost2` is integer minor units at 2dp. All outputs
 * are 2dp minor units. The residual always lands in committed; over-receipt
 * clamps committed at zero (condition C2).
 */
export function allocatePoLine(
  qty4: bigint,
  received4: bigint,
  unitCost2: bigint,
): PoLineAllocation {
  const overReceived = received4 > qty4;
  const allocRounded = divideRounded(qty4 * unitCost2, 10n ** QUANTITY_SCALE, 'half-up');
  const receivedRounded = divideRounded(received4 * unitCost2, 10n ** QUANTITY_SCALE, 'half-up');
  const committedRounded = overReceived ? 0n : allocRounded - receivedRounded;
  return { allocRounded, receivedRounded, committedRounded, overReceived };
}

/**
 * The labour cost of one timesheet entry (section 2.6, condition C1):
 * `round(hours x effective_hourly_rate)` half-up to 2dp, independently per
 * entry. `hours2` is 2dp minor units; `rate4` is 4dp minor units.
 */
export function labourCost(hours2: bigint, rate4: bigint): bigint {
  return divideRounded(hours2 * rate4, 10n ** QUANTITY_SCALE, 'half-up');
}

/**
 * Asserts invariant I-1 for one PO line: the rounded received and committed
 * shares sum to the rounded line total exactly. Over-receipt is the
 * documented exception (committed zero, received carries the full value).
 * Throws on violation so the report-building transaction fails closed.
 */
export function assertInvariantOne(line: PoLineAllocation): void {
  if (line.overReceived) {
    if (line.committedRounded !== 0n) {
      throw new Error(`I-1 over-receipt rule violated: committed must be zero.`);
    }
    if (line.receivedRounded < line.allocRounded) {
      throw new Error(`I-1 over-receipt rule violated: received is below the line total.`);
    }
    return;
  }
  if (line.receivedRounded + line.committedRounded !== line.allocRounded) {
    throw new Error(
      `I-1 violated: received ${line.receivedRounded} + committed ${line.committedRounded} ` +
        `!= alloc ${line.allocRounded}`,
    );
  }
}
