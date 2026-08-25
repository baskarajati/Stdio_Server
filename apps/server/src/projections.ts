/**
 * Wire projections for the engagement-scoped routes (SOL-28 revision 7).
 *
 * Every projection honors the money lens (D-007): when `canReadFinance` is
 * false the server masks every money field — the numeric twin and the label —
 * to null. Money numbers are `RawDecimal` (emitted verbatim by
 * `serializeJson`); money labels are formatted from the same `numeric(20,2)`
 * value through `packages/core` integer minor-unit arithmetic, never a float.
 */

import { moneyFromDecimal, moneyToDecimal } from '@stdio/core';

import { maskMoney, moneyNumber, moneyWire, type RawDecimal } from './money';

/** The presentation label for a money column, e.g. `Rp 850.000.000,00`. */
export function moneyLabel(value: string | null | undefined, currency: string): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const minor = moneyFromDecimal(value, currency).amount;
  const negative = minor < 0n;
  const absolute = negative ? -minor : minor;
  const whole = absolute / 100n;
  const cents = absolute % 100n;
  const wholeText = new Intl.NumberFormat('id-ID').format(whole);
  const text = `${wholeText},${cents.toString().padStart(2, '0')}`;
  const code = currency === 'IDR' ? 'Rp' : currency;
  return `${negative ? '-' : ''}${code} ${text}`;
}

/** The presentation label for a timestamp, e.g. `1 Agu 2026`. */
export function dateLabel(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return new Intl.DateTimeFormat('id-ID', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(date);
}

/** The descriptive label for one receivable component (SOL-149 R5, option b).
 * Components render as planned draft structure only; live balances are
 * invoice-level and cash-derived. The label says which: DEPOSIT and BALANCE
 * are planned parts; RETENTION is held and not yet due (D-033).
 */
export function receivableComponentLabel(kind: string): string {
  switch (kind) {
    case 'DEPOSIT':
      return 'Deposit (planned)';
    case 'RETENTION':
      return 'Retention held - receivable, not yet due';
    case 'BALANCE':
      return 'Balance (planned)';
    default:
      return kind;
  }
}

/** Humanized status label: `SENT` to `Sent`, `PROGRESS_CERTIFICATE` to `Progress certificate`. */
export function statusLabel(status: string | null | undefined): string | null {
  if (status === null || status === undefined) {
    return null;
  }
  const words = status.split('_');
  return words.map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join(' ');
}

/** The opaque register sort key: `updatedAt|createdAt|id`. */
export function sortKey(updatedAt: Date | string, createdAt: Date | string, id: string): string {
  const iso = (value: Date | string) =>
    value instanceof Date ? value.toISOString() : new Date(value).toISOString();
  return [iso(updatedAt), iso(createdAt), id].join('|');
}

/**
 * The numeric twin and its label for one money column. Both are masked by the
 * finance lens so a non-finance actor sees `null` in both wire forms.
 */
export function moneyTwin(
  canReadFinance: boolean,
  value: string | null | undefined,
  currency: string,
): { number: RawDecimal | null; label: string | null } {
  return {
    number: maskMoney(canReadFinance, moneyNumber(value, currency)),
    label: maskMoney(canReadFinance, moneyLabel(value, currency)),
  };
}

/**
 * The canonical 2dp money string for a STRING-form field (VariationOrder,
 * ScheduleOfValuesLine, progress), masked by the finance lens.
 */
export function moneyString(
  canReadFinance: boolean,
  value: string | null | undefined,
  currency: string,
): string | null {
  return maskMoney(canReadFinance, moneyWire(value, currency));
}

/** Formats a `numeric(20,2)` column back to the canonical 2dp string. */
export function canonicalMoney(value: string | null | undefined, currency: string): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return moneyToDecimal(moneyFromDecimal(value, currency));
}
