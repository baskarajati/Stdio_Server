#!/usr/bin/env bash
# SOL-28 revision 4 evidence, condition 4:
#   end-to-end server-byte -> native-decoder tests for 0.01, -0.01, and
#   999999999999999999.99.
#
# Flow:
#   1. The server serializer (apps/server/src/money.ts serializeJson) emits the
#      exact response bytes for each money value (the raw decimal token).
#   2. A compiled Swift JSONDecoder decodes those exact bytes with the CURRENT
#      native money field type (Double?) and the CORRECTED type (Decimal?).
#   3. We print both so the reviewer sees the current consumer LOSES the large
#      value and the corrected consumer reads it exactly.
#
# The server bytes are emitted by a real tsx run of the real serializer, NOT a
# hand-typed fixture, so this is truly end-to-end.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

TMP_BYTES="$(mktemp)"
EMIT_TMP="$ROOT/.sol43-emit.ts"

cat > "$EMIT_TMP" <<'TS'
import { serializeJson, moneyNumber } from './apps/server/src/money';
const out = {
  small: moneyNumber('0.01', 'IDR'),
  neg: moneyNumber('-0.01', 'IDR'),
  big: moneyNumber('999999999999999999.99', 'IDR'),
};
process.stdout.write(serializeJson(out));
TS

TSX_BIN="$ROOT/apps/server/node_modules/.bin/tsx"
"$TSX_BIN" "$EMIT_TMP" > "$TMP_BYTES"
rm -f "$EMIT_TMP"

echo "SERVER-BYTE SAMPLES (raw decimal tokens from serializeJson):"
cat "$TMP_BYTES"
echo
echo

SWIFT_DIR="$(mktemp -d)"
cat > "$SWIFT_DIR/main.swift" <<'SWFT'
import Foundation

// These are the CURRENT native money field types on the contract-fed DTOs.
// NativeProjectQuotationDTO decodes money as Double? (ProjectQuotations.swift:754-831).
struct DoubleDTO: Decodable {
  let small: Double?
  let neg: Double?
  let big: Double?
  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    small = try c.decodeIfPresent(Double.self, forKey: .small)
    neg = try c.decodeIfPresent(Double.self, forKey: .neg)
    big = try c.decodeIfPresent(Double.self, forKey: .big)
  }
  enum CodingKeys: String, CodingKey { case small, neg, big }
}

// The CORRECTED type: Decimal (Foundation), an exact non-float value type.
struct DecimalDTO: Decodable {
  let small: Decimal?
  let neg: Decimal?
  let big: Decimal?
  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    small = try c.decodeIfPresent(Decimal.self, forKey: .small)
    neg = try c.decodeIfPresent(Decimal.self, forKey: .neg)
    big = try c.decodeIfPresent(Decimal.self, forKey: .big)
  }
  enum CodingKeys: String, CodingKey { case small, neg, big }
}

let data = FileHandle.standardInput.readDataToEndOfFile()

print("== CURRENT native consumer (Double?) ==")
do {
  let d = try JSONDecoder().decode(DoubleDTO.self, from: data)
  print("  0.01                  -> \(d.small.map { "\($0)" } ?? "nil")")
  print("  -0.01                 -> \(d.neg.map { "\($0)" } ?? "nil")")
  print("  999999999999999999.99 -> \(d.big.map { "\($0)" } ?? "nil")")
  if let b = d.big {
    let exact = NSDecimalNumber(string: "999999999999999999.99")
    let dd = NSDecimalNumber(value: b)
    print("  -> comparing Double? read to exact: \(dd == exact ? "EXACT" : "LOSSY (ROUNDED)")")
  }
} catch {
  print("  decode failed: \(error)")
}

print("\n== CORRECTED native consumer (Decimal?) ==")
do {
  let d = try JSONDecoder().decode(DecimalDTO.self, from: data)
  print("  0.01                  -> \(d.small.map { "\($0)" } ?? "nil")")
  print("  -0.01                 -> \(d.neg.map { "\($0)" } ?? "nil")")
  print("  999999999999999999.99 -> \(d.big.map { "\($0)" } ?? "nil")")
  if let b = d.big {
    let exact = NSDecimalNumber(string: "999999999999999999.99")
    let dd = NSDecimalNumber(decimal: b)
    print("  -> comparing Decimal? read to exact: \(dd == exact ? "EXACT" : "LOSSY")")
  }
} catch {
  print("  decode failed: \(error)")
}
SWFT

swiftc -O -o "$SWIFT_DIR/proof" "$SWIFT_DIR/main.swift" >/dev/null 2>&1 || { echo "swiftc failed"; sed -n '1,40p' "$SWIFT_DIR/main.swift" >&2; exit 1; }
echo "== NATIVE DECODE (server bytes -> native decoder) =="
"$SWIFT_DIR/proof" < "$TMP_BYTES"
rm -rf "$SWIFT_DIR" "$TMP_BYTES"
