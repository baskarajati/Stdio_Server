/**
 * Money for Stdio.
 *
 * Rule: every amount is an integer count of minor units (cents, sen, pence).
 * Stdio never stores a money value in a float. A float loses cents on an invoice.
 *
 * The database column type for a money amount is `bigint`. The transport type is
 * a string, because JSON cannot carry a 64-bit integer safely.
 */

/** An amount of money in minor units, with its currency. */
export type Money = {
  /** The amount in minor units. 12.34 EUR is 1234n. */
  readonly amount: bigint;
  /** An ISO 4217 code, upper case. Example: 'EUR'. */
  readonly currency: string;
};

/** The rounding rule for a division or a percentage. */
export type Rounding = 'half-up' | 'half-even';

export class CurrencyMismatchError extends Error {
  constructor(left: string, right: string) {
    super(`Cannot combine ${left} with ${right}.`);
    this.name = 'CurrencyMismatchError';
  }
}

/** Builds a Money value from minor units. */
export function money(amount: bigint | number, currency: string): Money {
  if (typeof amount === 'number' && !Number.isSafeInteger(amount)) {
    throw new RangeError(`The amount ${amount} is not a safe integer of minor units.`);
  }
  return { amount: BigInt(amount), currency: normaliseCurrency(currency) };
}

/** Builds a zero amount in the given currency. */
export function zero(currency: string): Money {
  return { amount: 0n, currency: normaliseCurrency(currency) };
}

function normaliseCurrency(currency: string): string {
  const code = currency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) {
    throw new RangeError(`The currency code '${currency}' is not three letters.`);
  }
  return code;
}

function assertSameCurrency(left: Money, right: Money): void {
  if (left.currency !== right.currency) {
    throw new CurrencyMismatchError(left.currency, right.currency);
  }
}

export function add(left: Money, right: Money): Money {
  assertSameCurrency(left, right);
  return { amount: left.amount + right.amount, currency: left.currency };
}

export function subtract(left: Money, right: Money): Money {
  assertSameCurrency(left, right);
  return { amount: left.amount - right.amount, currency: left.currency };
}

export function negate(value: Money): Money {
  return { amount: -value.amount, currency: value.currency };
}

/** Adds a list of amounts. An empty list needs an explicit currency. */
export function sum(values: readonly Money[], currency?: string): Money {
  const first = values[0];
  if (first === undefined) {
    if (currency === undefined) {
      throw new RangeError('An empty sum needs an explicit currency.');
    }
    return zero(currency);
  }
  return values.reduce(add, zero(currency ?? first.currency));
}

/** Multiplies an amount by a whole quantity. This is exact. */
export function multiply(value: Money, quantity: bigint | number): Money {
  if (typeof quantity === 'number' && !Number.isSafeInteger(quantity)) {
    throw new RangeError(`The quantity ${quantity} is not a whole number.`);
  }
  return { amount: value.amount * BigInt(quantity), currency: value.currency };
}

/**
 * Multiplies an amount by a rational factor, then rounds to one minor unit.
 *
 * Use this for a tax rate or a discount. Give the factor as a numerator and a
 * denominator. A rate of 21% is `numerator = 21n` and `denominator = 100n`.
 */
export function multiplyRate(
  value: Money,
  numerator: bigint,
  denominator: bigint,
  rounding: Rounding = 'half-up',
): Money {
  if (denominator === 0n) {
    throw new RangeError('The denominator must not be zero.');
  }
  return {
    amount: divideRounded(value.amount * numerator, denominator, rounding),
    currency: value.currency,
  };
}

/**
 * Divides two bigints and rounds to one minor unit. The ratified contract
 * function: `divideRounded(value, scale, 'half-up')` rounds ties away from
 * zero and is sign-symmetric (SOL-25 revision 24, section 9.4 B9).
 */
export function divideRounded(numerator: bigint, denominator: bigint, rounding: Rounding): bigint {
  const negative = numerator < 0n !== denominator < 0n;
  const absNumerator = numerator < 0n ? -numerator : numerator;
  const absDenominator = denominator < 0n ? -denominator : denominator;

  const quotient = absNumerator / absDenominator;
  const remainder = absNumerator % absDenominator;
  const twice = remainder * 2n;

  let rounded = quotient;
  if (twice > absDenominator) {
    rounded = quotient + 1n;
  } else if (twice === absDenominator) {
    // A tie. 'half-up' goes away from zero. 'half-even' goes to the even value.
    if (rounding === 'half-up' || quotient % 2n !== 0n) {
      rounded = quotient + 1n;
    }
  }
  return negative ? -rounded : rounded;
}

/**
 * Splits an amount into `parts` shares that add back to the original amount.
 *
 * The remainder goes one minor unit at a time to the first shares. No cent is
 * created and no cent is lost.
 */
export function allocateEvenly(value: Money, parts: number): Money[] {
  if (!Number.isSafeInteger(parts) || parts <= 0) {
    throw new RangeError(`The part count ${parts} must be a positive whole number.`);
  }
  return allocateByRatios(value, new Array<bigint>(parts).fill(1n));
}

/**
 * Splits an amount by a list of weights. The shares add back to the original
 * amount exactly. This is the rule for a deposit invoice and a retention.
 */
export function allocateByRatios(value: Money, ratios: readonly bigint[]): Money[] {
  if (ratios.length === 0) {
    throw new RangeError('The ratio list must not be empty.');
  }
  if (ratios.some((ratio) => ratio < 0n)) {
    throw new RangeError('A ratio must not be negative.');
  }

  const total = ratios.reduce((carry, ratio) => carry + ratio, 0n);
  if (total === 0n) {
    throw new RangeError('The ratios must not add up to zero.');
  }

  const negative = value.amount < 0n;
  const absolute = negative ? -value.amount : value.amount;

  const shares: bigint[] = [];
  let assigned = 0n;
  for (const ratio of ratios) {
    const share = (absolute * ratio) / total;
    shares.push(share);
    assigned += share;
  }

  let remainder = absolute - assigned;
  for (let index = 0; remainder > 0n; index = (index + 1) % shares.length) {
    shares[index] = (shares[index] ?? 0n) + 1n;
    remainder -= 1n;
  }

  return shares.map((share) => ({
    amount: negative ? -share : share,
    currency: value.currency,
  }));
}

export function isZero(value: Money): boolean {
  return value.amount === 0n;
}

export function compare(left: Money, right: Money): -1 | 0 | 1 {
  assertSameCurrency(left, right);
  if (left.amount < right.amount) return -1;
  if (left.amount > right.amount) return 1;
  return 0;
}

export function equals(left: Money, right: Money): boolean {
  return left.currency === right.currency && left.amount === right.amount;
}

/** Formats an amount for a person. The default locale follows the runtime. */
export function format(value: Money, locale?: string, fractionDigits = 2): string {
  const divisor = 10n ** BigInt(fractionDigits);
  const negative = value.amount < 0n;
  const absolute = negative ? -value.amount : value.amount;
  const whole = absolute / divisor;
  const fraction = absolute % divisor;

  const wholeText = new Intl.NumberFormat(locale).format(whole);
  const fractionText = fraction.toString().padStart(fractionDigits, '0');
  const decimalMark = new Intl.NumberFormat(locale).format(1.1).charAt(1);
  const body = fractionDigits > 0 ? `${wholeText}${decimalMark}${fractionText}` : wholeText;

  return `${negative ? '-' : ''}${body} ${value.currency}`;
}

/** Serialises an amount for JSON. The amount becomes a string. */
export function toJSON(value: Money): { amount: string; currency: string } {
  return { amount: value.amount.toString(), currency: value.currency };
}

/** Reads an amount back from JSON. */
export function fromJSON(value: { amount: string; currency: string }): Money {
  return money(BigInt(value.amount), value.currency);
}
