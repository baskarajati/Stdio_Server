import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { jsonResponse, moneyNumber } from './money';

// Prove that a money-bearing response is served with the lossless raw writer,
// not c.json (which would collapse 999999999999999999.99).
describe('raw money route', () => {
  it('serves an exact-byte number token', async () => {
    const app = new Hono();
    app.get('/finance', (_c) =>
      jsonResponse({ data: { amount: moneyNumber('999999999999999999.99', 'IDR') } }),
    );
    const res = await app.request('/finance');
    const text = await res.text();
    expect(text).toBe('{"data":{"amount":999999999999999999.99}}');
    expect(res.headers.get('content-type')).toContain('application/json');
  });

  it('serves exact bytes for 0.01 and -0.01 through the same route', async () => {
    const app = new Hono();
    app.get('/a', (_c) => jsonResponse({ amount: moneyNumber('0.01', 'IDR') }));
    app.get('/b', (_c) => jsonResponse({ amount: moneyNumber('-0.01', 'IDR') }));
    expect(await (await app.request('/a')).text()).toBe('{"amount":0.01}');
    expect(await (await app.request('/b')).text()).toBe('{"amount":-0.01}');
  });
});
