/**
 * The bridge between integer-cents money and the `numeric(20,2)` column type.
 *
 * SOL-23 rule: money columns in Postgres use `numeric(20,2)`, and the wire
 * type is an integer count of minor units (`packages/core/src/money.ts`).
 * Nothing in between may use a float. These functions convert with BigInt only.
 *
 * `MoneyInput` in `contracts/openapi/native-v1.yaml` (L9140) accepts a string
 * or a number. `parseMoneyInput` accepts both forms and rounds half-up to the
 * minor unit.
 */

import { type Money, money } from './money';

/**
 * The largest absolute value a `numeric(20,2)` column holds: twenty total
 * digits, two of them after the decimal point.
 */
export const MAX_MINOR_UNITS = 10n ** 20n - 1n;
const DECIMAL_PATTERN = /^([+-]?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/;

/** Writes a canonical decimal string with two decimal places, e.g. `12.34`. */
export function moneyToDecimal(value: Money): string {
  const negative = value.amount < 0n;
  const absolute = negative ? -value.amount : value.amount;
  const whole = absolute / 100n;
  const cents = absolute % 100n;
  const text = `${whole}.${cents.toString().padStart(2, '0')}`;
  return negative ? `-${text}` : text;
}

/**
 * Reads a decimal string exactly. More than two decimal places is an error,
 * because a stored `numeric(20,2)` value never has more. Use this to read a
 * value back from the database. Exponent notation is rejected too.
 */
export function moneyFromDecimal(text: string, currency: string): Money {
  const parsed = parseDecimal(text);
  if (parsed.hasExponent) {
    throw new RangeError(`Money decimal "${text}" must be a plain decimal number.`);
  }
  if (parsed.fractionDigits > 2) {
    throw new RangeError(`Money decimal "${text}" has more than two decimal places.`);
  }
  return moneyFromShiftedDigits(parsed, currency, 'exact');
}

/**
 * Parses a contract `MoneyInput` value (a string or a number) into integer
 * minor units. Extra decimal places round half-up. A number is read through its
 * shortest round-trip decimal form, which is the form JSON writes on the wire.
 */
export function parseMoneyInput(input: string | number, currency: string): Money {
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) {
      throw new RangeError('Money input must be a finite number.');
    }
    return moneyFromShiftedDigits(parseDecimal(String(input)), currency, 'half-up');
  }
  return moneyFromShiftedDigits(parseDecimal(input), currency, 'half-up');
}

type ParsedDecimal = {
  sign: 1 | -1;
  /** The integer digits of the value, with leading zeros removed. */
  digits: string;
  /** Power of ten that scales `digits` to the value, e.g. 12.34 -> digits "1234", scale10 -2. */
  scale10: number;
  fractionDigits: number;
  hasExponent: boolean;
};

function parseDecimal(text: string): ParsedDecimal {
  const match = DECIMAL_PATTERN.exec(text.trim());
  if (!match) {
    throw new RangeError(`Money decimal "${text}" is not a plain decimal number.`);
  }
  const sign = match[1] === '-' ? -1 : 1;
  const intPart = match[2] ?? '';
  const fracPart = match[3] ?? '';
  const hasExponent = match[4] !== undefined;
  const exponent = hasExponent ? Number.parseInt(match[4] ?? '0', 10) : 0;
  const digits = `${intPart}${fracPart}`.replace(/^0+(?=\d)/, '');
  return {
    sign,
    digits,
    scale10: exponent - fracPart.length,
    fractionDigits: fracPart.length,
    hasExponent,
  };
}

function moneyFromShiftedDigits(
  parsed: ParsedDecimal,
  currency: string,
  rounding: 'exact' | 'half-up',
): Money {
  // minor = digits * 10^(scale10 + 2). A negative shift divides with rounding.
  const shift = parsed.scale10 + 2;
  const base = BigInt(parsed.digits);
  let minor: bigint;
  if (shift >= 0) {
    minor = base * 10n ** BigInt(shift);
  } else if (rounding === 'half-up') {
    const divisor = 10n ** BigInt(-shift);
    const quotient = base / divisor;
    const remainder = base % divisor;
    minor = remainder * 2n >= divisor ? quotient + 1n : quotient;
  } else {
    throw new RangeError('Exact decimal parse rejected a value with extra precision.');
  }
  if (minor > MAX_MINOR_UNITS) {
    throw new RangeError('Money amount is outside the numeric(20,2) column range.');
  }
  return money(parsed.sign === -1 ? -minor : minor, currency);
}
