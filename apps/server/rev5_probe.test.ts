import { describe, expect, it } from 'vitest';
import { RawDecimal, serializeJson } from './money';

describe('revision 5 injection vectors — current implementation', () => {
  it('subclass overriding serialize() injects a raw fragment', () => {
    class Evil extends RawDecimal {
      serialize(): string {
        return '{"amount":0,"injected":true}';
      }
    }
    const body = JSON.parse(serializeJson({ amount: new Evil('0.01') }));
    expect((body as any).amount).toBe(0);
    expect((body as any).injected).toBe(true);
  });

  it('post-construction mutation of .value injects (readonly is TS-only)', () => {
    const d = new RawDecimal('0.01');
    (d as any).value = '{"amount":0,"injected":true}';
    const body = JSON.parse(serializeJson({ amount: d }));
    expect((body as any).injected).toBe(true);
  });

  it('prototype patch of serialize() injects', () => {
    const orig = RawDecimal.prototype.serialize;
    RawDecimal.prototype.serialize = () => '999999999999999999.99,"x":"';
    try {
      const out = serializeJson({ amount: new RawDecimal('0.01') });
      expect(out).toContain('"x":"');
    } finally {
      RawDecimal.prototype.serialize = orig;
    }
  });

  it('Object.defineProperty on value bypasses constructor validation', () => {
    const d = new RawDecimal('0.01');
    Object.defineProperty(d, 'value', { value: '1.234' }); // >2dp, never validated
    expect(serializeJson({ amount: d })).toBe('{"amount":1.234}');
  });
});
