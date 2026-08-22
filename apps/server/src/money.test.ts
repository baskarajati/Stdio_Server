/**
 * Tests for the lossless money wire serializer.
 *
 * The rule (ADR 0001, money.ts): every amount is integer minor units and the
 * database column is `numeric(20,2)`. The contract declares TWO wire forms:
 * a canonical 2dp STRING (`VariationOrder`, `ScheduleOfValuesLine`, progress)
 * and a JSON NUMBER (`ProjectQuotation`, `ProjectFinanceInvoice`,
 * `ProjectFinanceSummary`, `ProjectMilestone.amount`,
 * `InvoiceReceivableComponent`). A JavaScript `Number` cannot carry the full
 * `numeric(20,2)` range, so the NUMBER form must be emitted as a raw validated
 * decimal token by `serializeJson` — never `Number`, `parseFloat`, or `c.json`.
 */

import { describe, expect, it } from 'vitest';
import {
  jsonResponse,
  maskMoney,
  moneyNumber,
  moneyWire,
  RawDecimal,
  serializeJson,
} from './money';

describe('serializeJson — lossless raw decimal tokens', () => {
  // FE review condition 5: raw-response tests for 0.01, -0.01, and
  // 999999999999999999.99. Conditions 1-3: exact bytes, never Number/parseFloat.
  it('emits the exact bytes for 0.01', () => {
    const body = { amount: moneyNumber('0.01', 'IDR') };
    const text = serializeJson(body);
    expect(text).toBe('{"amount":0.01}');
    // The number token is NOT quoted and is NOT a rounded float.
    expect(text).not.toContain('"0.01"');
  });

  it('emits the exact bytes for -0.01', () => {
    const text = serializeJson({ amount: moneyNumber('-0.01', 'IDR') });
    expect(text).toBe('{"amount":-0.01}');
  });

  it('emits the exact bytes for 999999999999999999.99 (a value Number cannot carry)', () => {
    const text = serializeJson({ amount: moneyNumber('999999999999999999.99', 'IDR') });
    expect(text).toBe('{"amount":999999999999999999.99}');
    // A JavaScript Number collapses 999999999999999999.99 to 1000000000000000000
    // (proven: Number('999999999999999999.99') === 1000000000000000000). The
    // lossless token keeps every digit; no exponent, no rounding.
    expect(Number('999999999999999999.99')).toBe(1000000000000000000);
    expect(text).not.toContain('e+');
    expect(text).not.toContain('1000000000000000000');
  });

  it('never converts a money field through a JavaScript Number', () => {
    // The float path would collapse 999999999999999999.99 to 1000000000000000000
    // (proven: Number('999999999999999999.99') === 1e21). A lossless emitter is
    // a raw token, and serializeJson emits it verbatim.
    const text = serializeJson({ amount: moneyNumber('999999999999999999.99', 'IDR') });
    expect(text).toBe('{"amount":999999999999999999.99}');
    // Sanity: the exact-byte token is NOT what the float path produces.
    expect(text).not.toBe('{"amount":1000000000000000000}');
    expect(text).not.toContain('e+');
  });

  it('round-trips a canonical integer money token (trailing .00)', () => {
    const text = serializeJson({ amount: moneyNumber('283050000.00', 'IDR') });
    expect(text).toBe('{"amount":283050000.00}');
  });

  it('emits null for a null money field', () => {
    expect(serializeJson({ amount: moneyNumber(null, 'IDR') })).toBe('{"amount":null}');
  });

  it('does not leak decimal places past 2dp (validated losslessly)', () => {
    expect(() => moneyNumber('1.999', 'IDR')).toThrow(/more than two decimal places/);
  });

  it('rejects a value outside the numeric(20,2) column range', () => {
    expect(() => moneyNumber('1000000000000000000.00', 'IDR')).toThrow(/outside the numeric/);
  });

  it('preserves ordinary non-money JSON fields verbatim', () => {
    const body = {
      name: 'Alpha',
      count: 3,
      flag: true,
      nested: { ok: 'yes', n: [1, 2] },
      amount: moneyNumber('123.45', 'IDR'),
    };
    const text = serializeJson(body);
    expect(JSON.parse(text)).toEqual({
      name: 'Alpha',
      count: 3,
      flag: true,
      nested: { ok: 'yes', n: [1, 2] },
      amount: 123.45,
    });
  });

  it('emits a response with application/json content type', () => {
    const res = jsonResponse({ amount: moneyNumber('0.01', 'IDR') });
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(res.status).toBe(200);
  });
});

describe('RawDecimal', () => {
  it('validates and normalizes through BigInt only', () => {
    expect(new RawDecimal('186000', 'IDR').serialize()).toBe('186000.00');
  });

  it('currencies are validated by the core money rule', () => {
    expect(new RawDecimal('-25000000.00', 'IDR').serialize()).toBe('-25000000.00');
  });
});

describe('moneyWire — canonical 2dp string form', () => {
  it('serializes a numeric(20,2) value to a canonical decimal string', () => {
    const out = moneyWire('283050000.00', 'IDR');
    expect(out).toBe('283050000.00');
    expect(typeof out).toBe('string');
  });

  it('preserves cents exactly', () => {
    expect(moneyWire('123.45', 'IDR')).toBe('123.45');
  });

  it('normalizes an integer column form to two decimals', () => {
    expect(moneyWire('120000000', 'IDR')).toBe('120000000.00');
  });

  it('keeps negative reversals negative', () => {
    expect(moneyWire('-25000000.00', 'IDR')).toBe('-25000000.00');
  });

  it('returns null for null and undefined input', () => {
    expect(moneyWire(null, 'IDR')).toBeNull();
    expect(moneyWire(undefined, 'IDR')).toBeNull();
  });
});

describe('moneyNumber — number-form money', () => {
  it('builds a RawDecimal from a column string', () => {
    expect(moneyNumber('123.45', 'IDR')).toBeInstanceOf(RawDecimal);
    expect(moneyNumber('123.45', 'IDR')?.serialize()).toBe('123.45');
  });

  it('returns null for null and undefined', () => {
    expect(moneyNumber(null, 'IDR')).toBeNull();
    expect(moneyNumber(undefined, 'IDR')).toBeNull();
  });
});

describe('maskMoney', () => {
  it('returns the value when the finance lens is on', () => {
    expect(maskMoney(true, '123.00')).toBe('123.00');
  });

  it('masks the value when the finance lens is off', () => {
    expect(maskMoney(false, '123.00')).toBeNull();
  });

  it('passes through a null value', () => {
    expect(maskMoney(true, null)).toBeNull();
  });
});

describe('serializeJson — cannot inject an unvalidated raw fragment', () => {
  // FE review condition: prove serializeJson cannot inject unvalidated raw
  // fragments. The ONLY raw emitter is a validated RawDecimal; every plain
  // string, number, boolean, array, and object is JSON-escaped per field.
  it('a plain string with a quote is escaped, never emitted raw', () => {
    expect(serializeJson({ x: '", "amount": 0' })).toBe('{"x":"\\", \\"amount\\": 0"}');
  });

  it('a string that looks like a number is still quoted', () => {
    expect(serializeJson({ x: '0.01' })).toBe('{"x":"0.01"}');
  });

  it('a string that looks like a JSON literal is still quoted', () => {
    expect(serializeJson({ x: 'null' })).toBe('{"x":"null"}');
    expect(serializeJson({ x: 'false' })).toBe('{"x":"false"}');
    expect(serializeJson({ x: '{"a":1}' })).toBe('{"x":"{\\"a\\":1}"}');
  });

  it('a top-level string is quoted, so it cannot become a bare fragment', () => {
    expect(serializeJson('0.01')).toBe('"0.01"');
    expect(serializeJson('null')).toBe('"null"');
    expect(serializeJson('false')).toBe('"false"');
  });

  it('only a validated RawDecimal emits a raw token', () => {
    // RawDecimal validates via moneyFromDecimal (BigInt only) and throws on a
    // value with more than 2dp or outside the numeric(20,2) range, so its
    // serialized token is always a real numeric(20,2) value.
    expect(() => new RawDecimal('1.999', 'IDR')).toThrow(/more than two decimal places/);
    expect(() => new RawDecimal('1000000000000000000.00', 'IDR')).toThrow(/outside the numeric/);
    expect(serializeJson(new RawDecimal('0.01', 'IDR'))).toBe('0.01');
  });

  it('a nested object value with a quote is escaped', () => {
    expect(serializeJson({ nested: { x: '0', y: ']}' } })).toBe('{"nested":{"x":"0","y":"]}"}}');
  });
  // Rev 5 hardening (reviewer condition 2): the raw token is read from a
  // module-private registry, not from an overridable method or a writable
  // property. Each vector below is the exact attack the reviewer described.

  it('a subclass overriding serialize() cannot inject a raw fragment', () => {
    class Evil extends RawDecimal {
      override serialize(): string {
        return '{"amount":0,"injected":true}';
      }
    }
    const text = serializeJson({ amount: new Evil('0.01', 'IDR') });
    expect(text).toBe('{"amount":0.01}');
    expect(JSON.parse(text)).toEqual({ amount: 0.01 });
  });

  it('a prototype patch of serialize() cannot inject a raw fragment', () => {
    const original = RawDecimal.prototype.serialize;
    RawDecimal.prototype.serialize = function (this: RawDecimal) {
      return '999999999999999999.99,"x":"';
    };
    try {
      const text = serializeJson({ amount: new RawDecimal('0.01', 'IDR') });
      expect(text).toBe('{"amount":0.01}');
      expect(text).not.toContain('"x"');
    } finally {
      RawDecimal.prototype.serialize = original;
    }
  });

  it('a forged RawDecimal prototype without a validated token throws TypeError', () => {
    const forged = Object.create(RawDecimal.prototype);
    expect(() => serializeJson({ amount: forged })).toThrow(TypeError);
    expect(() => serializeJson({ amount: forged })).toThrow(
      'Cannot serialize an unvalidated RawDecimal.',
    );
  });

  it('post-construction mutation of an instance cannot change its token', () => {
    const d = new RawDecimal('0.01', 'IDR');
    // The instance is frozen: redefining `value` throws, adding a property
    // throws, and a reassigned serialize() is ignored because the serializer
    // reads the module-private registry.
    expect(() => {
      Object.defineProperty(d, 'value', { value: '{"amount":0,"injected":true}' });
    }).toThrow();
    const hostile = d as unknown as Record<string, unknown>;
    expect(() => {
      hostile.serialize = () => '{"amount":0,"injected":true}';
    }).toThrow();
    expect(serializeJson({ amount: d })).toBe('{"amount":0.01}');
  });

  it('a mutated instance keeps the exact token through jsonResponse too', () => {
    const d = new RawDecimal('123.45', 'IDR');
    const mutable = d as unknown as Record<string, unknown>;
    expect(() => {
      mutable.value = '9.99';
    }).toThrow();
    const res = jsonResponse({ amount: d });
    return res.text().then((t) => expect(t).toBe('{"amount":123.45}'));
  });
});
