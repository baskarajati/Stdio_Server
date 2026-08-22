/**
 * Money serialization to the contract wire form.
 *
 * ADR 0001 / money.ts: every amount is an integer count of minor units, and the
 * database column is `numeric(20,2)`. The contract declares TWO wire forms for
 * money, and the native consumers decode them differently:
 *
 * - `VariationOrder.*`, `ScheduleOfValuesLine.*`, and progress projections
 *   declare `type: [string,"null"]` ("Canonical 2dp money string"). The native
 *   `VariationOrderDTO` money fields are `String?`, parsed with
 *   `Decimal(string:locale:)`.
 * - `ProjectQuotation.*`, `ProjectFinanceInvoice.*`, `ProjectFinanceSummary.*`,
 *   `ProjectMilestone.amount`, and `InvoiceReceivableComponent.*` declare
 *   `type: number`. The native `QuotationDTO` / finance DTOs decode `Decimal?`
 *   via `decodeIfPresent(Decimal.self, ...)`, which REQUIRES a JSON number
 *   token and rejects a string (hard `typeMismatch`).
 *
 * A JavaScript `Number` cannot carry every `numeric(20,2)` value:
 * `Number("999999999999999999.99")` becomes `1000000000000000000`. `c.json`
 * (JSON.stringify) therefore must NEVER be used for a money-bearing response
 * payload. This module provides the lossless path.
 *
 * For the STRING form, `moneyWire()` emits the canonical 2dp string.
 * For the NUMBER form, the server attaches a `RawDecimal` value and writes the
 * response with `serializeJson()` (a raw JSON writer that emits the validated
 * decimal token verbatim — never a float, never `Number`, never `JSON.stringify`
 * on a money field).
 */

import { moneyFromDecimal, moneyToDecimal } from '@stdio/core';

/**
 * Reads a `numeric(20,2)` database value as stored (a string) and returns the
 * canonical decimal string for the STRING wire form (`VariationOrder`,
 * `ScheduleOfValuesLine`, progress). `null` stays `null`.
 */
export function moneyWire(
  value: string | null | undefined,
  currency: string = 'IDR',
): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return moneyToDecimal(moneyFromDecimal(value, currency));
}

/**
 * A number-typed money field on the contract wire.
 *
 * The value is the canonical 2dp decimal string (e.g. `"999999999999999999.99"`).
 * It is validated losslessly through `moneyFromDecimal` (BigInt only) so the
 * token is a real `numeric(20,2)` value, then emitted verbatim by
 * `serializeJson` as a raw JSON number token. A JavaScript `Number` is never
 * constructed, and no float sits on the path.
 */
const RAW_TOKENS = new WeakMap<object, string>();

export class RawDecimal {
  constructor(value: string, currency: string = 'IDR') {
    // moneyFromDecimal rounds nothing and throws on >2dp or out-of-range, so
    // this is the exact `numeric(20,2)` validation and normalization.
    const minor = moneyFromDecimal(value, currency);
    // The canonical token lives in a module-private registry, NOT on the
    // instance. A subclass cannot override it, a caller cannot replace it,
    // and `serializeJson` reads the registry — never an overridable method.
    RAW_TOKENS.set(this, moneyToDecimal(minor));
    Object.freeze(this);
  }

  /** The validated canonical decimal token (read-only view). */
  get value(): string {
    return RAW_TOKENS.get(this) as string;
  }

  /** Kept for source compatibility; the serializer does NOT call this. */
  serialize(): string {
    return RAW_TOKENS.get(this) as string;
  }
}

/**
 * Builds a NUMBER-form money value from a `numeric(20,2)` column string.
 * `null` / `undefined` (money lens off) yields `null`.
 */
export function moneyNumber(
  value: string | null | undefined,
  currency: string = 'IDR',
): RawDecimal | null {
  if (value === null || value === undefined) {
    return null;
  }
  return new RawDecimal(value, currency);
}

/**
 * The `canReadFinance` lens. When off, every money field on the wire is `null`
 * (the UI renders a masked value per D-007). The database still holds the
 * number; only the projection hides it.
 */
export function maskMoney<T>(canRead: boolean, value: T | null | undefined): T | null {
  return canRead ? (value ?? null) : null;
}

/**
 * Writes a JSON string with no float on any money path.
 *
 * `RawDecimal` values are emitted as their validated raw decimal token (a bare
 * JSON number like `999999999999999999.99`). Every other value is serialized
 * exactly as `JSON.stringify` would, so this is a drop-in body writer for the
 * money-bearing responses. It is the only writer those routes may use: `c.json`
 * (JSON.stringify) turns a large `numeric(20,2)` amount into a rounded `Number`
 * and loses money.
 */
export function serializeJson(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (value === undefined) {
    return 'null';
  }
  // The token is read from the module-private registry set by the RawDecimal
  // constructor. An overridden serialize() on a subclass or on the prototype
  // is never consulted, so no code path can smuggle an unvalidated fragment
  // through here. A forged object can inherit RawDecimal.prototype without
  // running its constructor, so it must have a registry entry as well.
  if (value instanceof RawDecimal) {
    if (!RAW_TOKENS.has(value)) {
      throw new TypeError('Cannot serialize an unvalidated RawDecimal.');
    }
    return RAW_TOKENS.get(value) as string;
  }
  const t = typeof value;
  if (t === 'string') {
    return JSON.stringify(value);
  }
  if (t === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (t === 'number') {
    // Non-money numbers (area, quantity, sortOrder, variationCount). A money
    // field is a RawDecimal, never a JS number — see `moneyNumber`.
    return Number.isFinite(value) ? String(value) : 'null';
  }
  if (Array.isArray(value)) {
    const parts = value.map((v) => (v === undefined ? 'null' : serializeJson(v)));
    return `[${parts.join(',')}]`;
  }
  if (t === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    const parts: string[] = [];
    for (const key of keys) {
      const v = record[key];
      if (v === undefined) {
        continue;
      }
      parts.push(`${JSON.stringify(key)}:${serializeJson(v)}`);
    }
    return `{${parts.join(',')}}`;
  }
  throw new TypeError(`Cannot serialize a value of type ${t} to JSON.`);
}

/**
 * Builds a `Response` whose body is written by `serializeJson` (raw, lossless
 * for number-typed money) instead of `c.json`. Use this on every money-bearing
 * route.
 */
export function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  const text = serializeJson(body);
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json');
  return new Response(text, { ...init, headers });
}
