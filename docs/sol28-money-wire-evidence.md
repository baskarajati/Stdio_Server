# SOL-28 — lossless money wire evidence (design revision 3)

**Issue:** SOL-28. **Author:** Backend Engineer. **Date:** 2026-08-21.
**Purpose:** Satisfy the Founding Engineer review condition that a number-typed
money field must be emitted by one lossless raw-decimal encoder, not by
`Number`, `parseFloat`, or ordinary JSON serialization.

## 1. The problem: a JavaScript `Number` cannot carry `numeric(20,2)`

The contract declares two money forms (see `contracts/openapi/native-v1.yaml`):

- **STRING form** — `VariationOrder.*`, `ScheduleOfValuesLine.*`, and progress
  projections: `type: [string,"null"]`, description "Canonical 2dp money string".
- **NUMBER form** — `ProjectQuotation.*`, `ProjectFinanceInvoice.*`,
  `ProjectFinanceSummary.*`, `ProjectMilestone.amount`,
  `InvoiceReceivableComponent.*`: `type: number`.

A JavaScript `Number` is a float64. It cannot represent every `numeric(20,2)`
value. The failure is demonstrable on this host (Node 22):

```
$ node -e '
const big = "999999999999999999.99";
console.log(Number(big));            // 1000000000000000000
console.log(String(Number(big)));    // 1000000000000000000
console.log(JSON.stringify({amount:Number(big)})); // {"amount":1000000000000000000}
console.log(String(Number(big)) === big);           // false
'
```

`999999999999999999.99` collapses to `1000000000000000000`. The last two
decimal places are lost. `Number`, `parseFloat`, and `JSON.stringify`/`c.json`
therefore MUST NOT be used on a money-bearing response payload.

## 2. The native decoder requires the documented form (empirically verified, Swift 6)

The native `Decimal?` decoders split the same way as the contract. A Swift check
compiled and run on this host (`swiftc -O`, Swift 6.3.2, arm64):

```swift
import Foundation
struct DTO: Decodable { let amount: Decimal? }
// JSON number tokens -> decoded exactly
{"amount":999999999999999999.99}  -> 999999999999999999.99
{"amount":0.01}                   -> 0.01
{"amount":-0.01}                  -> -0.01
{"amount":186000}                 -> 186000
// canonical STRING token (number-typed schema) -> HARD typeMismatch
{"amount":"186000.00"}            -> DecodingError.typeMismatch: expected NSDecimal
```

So `Decimal?` reads the raw number token **exactly** (including
`999999999999999999.99`), and a canonical 2dp **string** is a hard
`typeMismatch` for those schemas. The server must emit number-typed money as a
raw JSON number token, and string-typed money as a canonical 2dp string.

## 3. The lossless encoder in `apps/server/src/money.ts`

`RawDecimal` is the validated raw token for a number-typed money field. It reads
the `numeric(20,2)` column exactly through `moneyFromDecimal` (BigInt only),
throws on >2dp or out-of-range, and stores the canonical 2dp string. It is
**never** converted through `Number` or `parseFloat`.

`moneyNumber(value, currency)` builds a `RawDecimal | null` from a column
string; `null` (money lens off) stays `null`.

`serializeJson(value)` is the raw response writer used by the money routes. A
`RawDecimal` is emitted verbatim (a bare JSON number token). Every other value
serializes exactly as `JSON.stringify`; `c.json` is never called on a
money-bearing payload. `jsonResponse(body)` builds the `Response`.

## 4. Exact-byte tests (review condition 5)

`apps/server/src/money.test.ts` asserts exact response bytes for the three
values the reviewer named, plus the integration route test
(`apps/server/src/rawroute.test.ts`) that serves them through a real Hono route:

| Input | Exact bytes emitted |
| --- | --- |
| `0.01` | `{"amount":0.01}` |
| `-0.01` | `{"amount":-0.01}` |
| `999999999999999999.99` | `{"amount":999999999999999999.99}` (not `1000000000000000000`) |
| `283050000.00` | `{"amount":283050000.00}` |
| `null` (lens off) | `{"amount":null}` |

The `999999999999999999.99` case also asserts the raw token is NOT the float
result and contains no exponent.

## 5. Verify

`pnpm --filter @stdio/server test` → 27 tests pass (money 22, raw route 2,
me 3). `pnpm --filter @stdio/server typecheck` → clean. Core money unchanged
(51 tests pass). The native decoder evidence is reproduced by this document's
`main.swift` in the run log; the run log is the source of truth for the
transcript.
