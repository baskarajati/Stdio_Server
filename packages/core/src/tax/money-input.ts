/**
 * Strict `MoneyInput` parsing per SOL-25 revision 24, section 3.
 *
 * The contract replaces the loose `oneOf: [string, number]` money input with
 * the ratified exact pair `MoneyInputString` / `MoneyInputNumber`. Every
 * rejected money request returns exactly one of three `Problem.code` values.
 * The categories do not overlap and run in this order:
 *
 * 1. `MONEY_FORMAT_INVALID` - grammar and finiteness. Rejects `""`, `.5`,
 *    `1.`, `1e`, `1e+`, `--1`, whitespace, commas, `NaN`, `Infinity`, and any
 *    non-finite runtime number token.
 * 2. `MONEY_NOT_EXACT` - a JSON number whose magnitude is at or above 2^53.
 *    The exact string form is required there.
 * 3. `MONEY_OUT_OF_RANGE` - a syntactically valid value whose half-up,
 *    two-decimal result is outside PostgreSQL `numeric(20,2)` range
 *    `-999999999999999999.99` through `999999999999999999.99`.
 *
 * Parsing never goes through binary floating point. A string with an exponent
 * is parsed as exact decimal text; a number is read through its shortest
 * round-trip decimal form.
 */

/** The three exact rejection categories of the ratified money rule. */
export type MoneyInputErrorCode = 'MONEY_FORMAT_INVALID' | 'MONEY_NOT_EXACT' | 'MONEY_OUT_OF_RANGE';

/** Typed error the server maps to the exact `Problem.code`. */
export class MoneyInputError extends RangeError {
  readonly code: MoneyInputErrorCode;
  constructor(code: MoneyInputErrorCode, message: string) {
    super(message);
    this.name = 'MoneyInputError';
    this.code = code;
  }
}

import { MAX_MINOR_UNITS } from '../money-decimal';

export { MAX_MINOR_UNITS };

/** The exact string grammar: sign, digits, optional fraction, optional exponent. */
const STRING_PATTERN = /^[+-]?[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/;

/** 2^53 as the exact rejection threshold for JSON numbers. */
const NOT_EXACT_THRESHOLD = 2 ** 53;

type ParsedDecimal = {
  sign: 1 | -1;
  /** Integer digits with leading zeros removed. "0" stays "0". */
  digits: string;
  /** Power of ten that scales `digits` to the value. 12.34 -> "1234", -2. */
  scale10: number;
};

function parseDecimalText(text: string): ParsedDecimal {
  if (!STRING_PATTERN.test(text)) {
    throw new MoneyInputError(
      'MONEY_FORMAT_INVALID',
      `Money input "${text}" is not exact decimal text.`,
    );
  }
  const sign = text.startsWith('-') ? -1 : 1;
  const unsigned = text.replace(/^[+-]/, '');
  const [intPart, fracPart = '', exponentPart = ''] =
    /^([0-9]+)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$/.exec(unsigned)?.slice(1) ?? [];
  const exponent = exponentPart === '' ? 0 : Number.parseInt(exponentPart, 10);
  const digits = `${intPart}${fracPart}`.replace(/^0+(?=\d)/, '');
  return { sign, digits, scale10: exponent - fracPart.length };
}

/**
 * Parses a contract `MoneyInput` value (string or JSON number) into integer
 * minor units, rounding half-up to two decimal places. Throws `MoneyInputError`
 * with the exact rejection category. Never uses floating point for the value.
 */
export function parseStrictMoneyInput(input: string | number): bigint {
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) {
      throw new MoneyInputError(
        'MONEY_FORMAT_INVALID',
        `Money input ${input} is not a finite number.`,
      );
    }
    if (Math.abs(input) >= NOT_EXACT_THRESHOLD) {
      throw new MoneyInputError(
        'MONEY_NOT_EXACT',
        `Money number ${input} is at or above 2^53; submit the exact string form.`,
      );
    }
    return moneyFromShiftedDigits(parseDecimalText(String(input)));
  }
  if (typeof input !== 'string') {
    throw new MoneyInputError('MONEY_FORMAT_INVALID', `Money input is not a string or a number.`);
  }
  return moneyFromShiftedDigits(parseDecimalText(input));
}

function moneyFromShiftedDigits(parsed: ParsedDecimal): bigint {
  const { sign, digits, scale10 } = parsed;
  const shift = scale10 + 2;
  // Guard the exponent before BigInt exponentiation: the numeric(20,2) range
  // has 20 integer digits, so any value with more is out of range by shape.
  if (shift > 20 || digits.length + scale10 > 20) {
    throw new MoneyInputError(
      'MONEY_OUT_OF_RANGE',
      `Money value is outside the numeric(20,2) column range.`,
    );
  }
  const base = BigInt(digits);
  let minor: bigint;
  if (shift >= 0) {
    minor = base * 10n ** BigInt(shift);
  } else {
    const divisor = 10n ** BigInt(-shift);
    const quotient = base / divisor;
    const remainder = base % divisor;
    minor = remainder * 2n >= divisor ? quotient + 1n : quotient;
  }
  if (minor > MAX_MINOR_UNITS) {
    throw new MoneyInputError(
      'MONEY_OUT_OF_RANGE',
      `Money value is outside the numeric(20,2) column range.`,
    );
  }
  return sign === -1 ? -minor : minor;
}

/**
 * Canonical two-decimal output text for a minor-unit amount. The zero is
 * always `0.00`; negative zero cannot occur because the amount is a bigint.
 */
export function moneyOutput(minor: bigint): string {
  const negative = minor < 0n;
  const absolute = negative ? -minor : minor;
  const whole = absolute / 100n;
  const cents = absolute % 100n;
  const text = `${whole}.${cents.toString().padStart(2, '0')}`;
  return negative ? `-${text}` : text;
}

/**
 * Whole-IDR output text: exactly two zero fractional digits. Rejects negative
 * zero and fractional rupiah (`916666.50` fails, `916667.00` passes). The
 * two-stage DPP-then-PPN engine always produces whole rupiah, so a fractional
 * value is a serialization error, never a silent fallback.
 */
export function wholeIdrOutput(minor: bigint): string {
  if (minor % 100n !== 0n) {
    throw new RangeError(`Whole-IDR value ${moneyOutput(minor)} has a non-zero fractional part.`);
  }
  return `${(minor / 100n).toString()}.00`;
}
