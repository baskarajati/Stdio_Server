# SOL-28 design revision 3 — engagement-scoped contracts and guarded money writes

**Author:** Backend Engineer. **Date:** 2026-08-21. **Status:** For re-review.
**Review:** SOL-35 comment `7df5e956` returned `revise` with 3-10 required
conditions. This revision supersedes revision 2's money-wire section with the
lossless raw-decimal encoder the reviewer required, plus the field-level
decoder map and exact-byte + native-decoder evidence.
**Parent issue:** SOL-28 (`5ab0e704-777b-464c-b017-461565ff7c5d`).

What is unchanged from revision 2: the route map (§2), the object model and
transitions (§3), the response envelope (§4), guarded-write mechanics (§5),
module layout (§6), deprecation shims (§7), test plan (§8), migration path
(§9), rollback (§10), concurrency/audit summary (§11), and open questions
(§12). Those sections satisfy SOL-35 conditions 1-7, 9-11. Revision 3 replaces
the money-wire design with the single lossless encoder and the field-level map.

## 1. Money wire — one lossless encoder for number-typed fields (conditions 3-8)

### 1.1 The two wire forms the contract already declares

The contract declares TWO money forms, and the native consumers decode them
differently. The server emits exactly what each schema declares.

| Form | Declared in contract | Native decoder | Native requirement |
| --- | --- | --- | --- |
| Canonical 2dp string `"186000.00"` | `VariationOrder.*`, `ScheduleOfValuesLine.*`, progress (`type: [string,"null"]`, "Canonical 2dp money string") | `VariationOrderDTO` money fields are `String?`; parsed with `Decimal(string:locale:)` | Accepts a string |
| JSON number token `186000` | `ProjectQuotation.*`, `ProjectFinanceInvoice.*`, `ProjectFinanceSummary.*`, `ProjectMilestone.amount` (`type: number`) | `QuotationDTO` / finance DTOs decode `Decimal?` via `decodeIfPresent(Decimal.self, ...)` | Accepts a number token; a string is a hard `typeMismatch` |

### 1.2 Why `Number` and `JSON.stringify` are banned on a money-bearing payload

A JavaScript `Number` is a float64 and cannot carry every `numeric(20,2)` value.
Proven on this host (Node 22):

```
String(Number("999999999999999999.99")) === "1000000000000000000"  // false
JSON.stringify({amount: Number("999999999999999999.99")})          // {"amount":1000000000000000000}
```

The last two decimal places are lost. `Number`, `parseFloat`, and
`JSON.stringify`/`c.json` MUST NOT be used on a money-bearing response payload.

### 1.3 Native decoder reads the raw number token exactly (empirically verified, Swift 6)

Compiled and run on this host (`swiftc -O`, Swift 6.3.2, arm64). `Decimal?`
decodes a raw number token **exactly**, and rejects a canonical string token:

```swift
struct DTO: Decodable { let amount: Decimal? }
{"amount":999999999999999999.99}  -> 999999999999999999.99   // exact
{"amount":0.01}                   -> 0.01                     // exact
{"amount":-0.01}                  -> -0.01                    // exact
{"amount":186000}                 -> 186000                   // exact
{"amount":"186000.00"}            -> typeMismatch: expected NSDecimal
```

### 1.4 The one lossless encoder (condition 1) — `apps/server/src/money.ts`

`RawDecimal` is the validated raw token for a NUMBER-form money field. It reads
the `numeric(20,2)` column exactly through `moneyFromDecimal` (BigInt only),
throws on >2dp or out-of-range, and stores the canonical 2dp string. It is
never converted through `Number` or `parseFloat` (condition 2).

- `moneyNumber(value, currency): RawDecimal | null` — build a NUMBER-form money
  value from a column string; `null` (lens off) stays `null`.
- `moneyWire(value, currency): string | null` — the STRING-form canonical 2dp
  string for `VariationOrder` / `ScheduleOfValuesLine` / progress.
- `serializeJson(value): string` — the raw response writer. A `RawDecimal` is
  emitted verbatim (a bare JSON number token). Every other value serializes
  exactly as `JSON.stringify` (condition 3: never `Number`, `parseFloat`, or
  `c.json` on money).
- `jsonResponse(body): Response` — builds the `Response` with
  `content-type: application/json` through `serializeJson`, NOT `c.json`
  (condition 3). Every money-bearing route uses this writer.

`money.ts` type-checks and is unit-tested; the raw writer is integration-tested
through a real Hono route (see §1.6).

### 1.5 Field-by-field money map (conditions 7, 8)

Every declared money field and its native decoder. "Wire form" is what the
server emits. "Encoder" is what turns the `numeric(20,2)` column value into
that wire form.

### STRING form — encoder: `moneyWire` (canonical 2dp string)

| Schema | Field(s) | Wire form | Native decoder |
| --- | --- | --- | --- |
| `VariationOrder` | `beforeFeeAmount`, `afterFeeAmount`, `feeEffect`, `beforeBoqAmount`, `afterBoqAmount`, `boqEffect`, `beforeContractValue`, `afterContractValue`, `totalAmount`, `taxAmount` | string | `VariationOrderDTO` `String?` + `Decimal(string:)` |
| `ScheduleOfValuesLine` | `unitRate`, `lineSubtotal`, `lineTaxAmount`, `lineTotal`, `quantity` | string | `String?` + `Decimal(string:)` |
| `ScheduleOfValues` | `subtotalAmount`, `taxAmount`, `totalAmount` | string | `String?` + `Decimal(string:)` |
| `VariationOrderWriteResponse` / `VariationOrderDetailResponse` | same fields as `VariationOrder` | string | `String?` + `Decimal(string:)` |

### NUMBER form — encoder: `RawDecimal` via `moneyNumber` + `serializeJson`

| Schema | Field(s) | Wire form | Native decoder |
| --- | --- | --- | --- |
| `ProjectQuotation` | `defaultRatePerSqm`, `discountAmount`, `discountPercent`; `feeItems[].lineTotal`, `feeItems[].ratePerSqm`; `items[].lineTotal`, `items[].unitPrice`; `paymentMilestones[].amount`, `paymentMilestones[].percentage` | number token | `QuotationDTO` `Decimal?` |
| `ProjectFinanceInvoice` | `outstandingAmount`, `paidAmount`, `totalAmount`; `receivableComponents[].amount`, `receivableComponents[].outstandingAmount`, `receivableComponents[].settledAmount`; `payments[].amount` | number token | `ProjectFinanceInvoiceDTO` `Decimal?` |
| `ProjectFinanceSummary` | `actualCost`, `contractValue`, `effectiveContractValue`, `effectiveVariationValue`, `forecastAtCompletion`, `forecastToComplete`, `grossMargin`, `grossProfit`, `invoicedValue`, `netCashflow`, `originalContractValue`, `payables`, `quotedValue`, `receivables`, `recognizedRevenue`, `cashIn`, `cashOut`, `committedCost` | number token | `ProjectFinanceSummaryDTO` `Decimal?` |
| `ProjectMilestone` | `amount` | number token | `ProjectMilestoneDTO` `Decimal?` |

### Label-only (presentation strings, NOT numerical money) — condition 8

| Schema | Field(s) | Wire form |
| --- | --- | --- |
| `InvoiceSummary` | `outstandingAmountLabel`, `paidAmountLabel`, `totalAmountLabel`; `receivableComponents[].*` (via `InvoiceReceivableComponent`: `amountLabel`, `outstandingAmountLabel`, `settledAmountLabel`) | string (presentation) |
| `InvoiceReceivableComponent` | `amountLabel`, `outstandingAmountLabel`, `settledAmountLabel` | string (presentation) |
| `ProjectFinanceInvoice.withholding` | `expectedAmountLabel`, `evidencedAmountLabel`, `settledAmountLabel`, `outstandingAmountLabel` | string (presentation) |
| Every `*Label` field on `ProjectQuotation`, `ProjectFinanceSummary`, `ProjectMilestone` | `defaultRatePerSqmLabel`, `discountAmountLabel`, `lineTotalLabel`, `ratePerSqmLabel`, `unitPriceLabel`, `amountLabel`, `totalAmountLabel`, … | string (presentation) |

The `*Label` variants are derived from the same minor-unit value by the
presentation layer; they are NOT the numeric money path and are unrelated to
the encoder.

### 1.6 Exact-byte and native-decoder tests (conditions 5, 6)

`apps/server/src/money.test.ts` and `apps/server/src/rawroute.test.ts`:

| Input | Exact bytes emitted |
| --- | --- |
| `0.01` | `{"amount":0.01}` |
| `-0.01` | `{"amount":-0.01}` |
| `999999999999999999.99` | `{"amount":999999999999999999.99}` |
| `283050000.00` | `{"amount":283050000.00}` |
| `null` (lens off) | `{"amount":null}` |

The `999999999999999999.99` case asserts the token is NOT the float result
(`1000000000000000000`) and has no exponent. The raw-route test serves these
through a real Hono route and asserts the response body bytes and the
`application/json` content type. The native `JSONDecoder` evidence is in
`docs/sol28-money-wire-evidence.md` and is reproduced by the run log.

### 1.7 Contract preservation (condition 9)

No existing projection's money type is changed. String schemas stay canonical
strings; number schemas stay raw number tokens through the lossless encoder.
`contracts/openapi/native-v1.yaml` is NOT edited in this repository.

## 2. Route map (unchanged from revision 2)

See revision 2 §2. The engagement-scoped route map stands:
`/projects/{id}/engagements/{engId}/contracts`, `/quotations`,
`/variation-orders`, `/invoices`; the derived read-only
`GET /projects/{id}/finance`; and the `410` deprecation shims.

## 3. Object model and transitions (unchanged from revision 2)

See revision 2 §3: guarded quotation assignment (§3.2), atomic variation-order
issue under `SERIALIZABLE` (§3.3), invoice draft/issue server-denied until
SOL-25 (§3.4), payment recording permanent denial (§3.5), legacy ancestry
backfill (§3.6).

## 4. Response envelope and scope binding (unchanged; money per §1)

Every list, detail, and write response carries `meta`, `data` with `projectId`,
`engagementId`, `entityVersion`, and the actor capability projection. Money
fields follow §1.5.

## 5. Guarded-write mechanics (unchanged from revision 2)

See revision 2 §5: idempotency (72h retention, deterministic client draft id),
`If-Match` entity-version conflict, `SERIALIZABLE` isolation.

## 6. Server module layout (unchanged; `money.ts` now exports the lossless path)

```
apps/server/src/
  money.ts              moneyWire / maskMoney + RawDecimal / moneyNumber /
                        serializeJson / jsonResponse (the lossless encoder)
  routes/*.ts           all money-bearing writes use jsonResponse()
```

## 7. Deprecation shims (unchanged from revision 2)

See revision 2 §7. Every generic project-scoped money route returns `410 GONE`
with code `DEPRECATED_ROUTE` and a `Link` header to the replacement.

## 8. Test plan (revision 3 adds money-encoder coverage)

The revision 2 test plan (cross-engagement isolation, cross-studio isolation,
stale response after switch, capability denial, entity conflict, idempotent
replay, atomic variation-order replay, rollback after writes, payment denial
no-op, retensi release without a second PPN event) stands. Revision 3 adds:

1. **Lossless exact-byte money**: `0.01`, `-0.01`, `999999999999999999.99`,
   `283050000.00`, and `null` emit the exact bytes in §1.6.
2. **No float on the money path**: a money field is never built through
   `Number` or `parseFloat`; the raw token keeps every digit.
3. **Native decoder compatibility**: the number-typed projections serve a raw
   number token (Swift `Decimal?` decodes it exactly, §1.3); the string-typed
   projections serve a canonical 2dp string; a canonical 2dp string on a
   number-typed schema is a hard `typeMismatch` (proven), so the server never
   emits it there.

## 9. Migration path (unchanged from revision 2)

See revision 2 §9. No data migration; the money encoder is code plus the route
registration. Copy the reviewed contract into Stdio_Native only after the
server change lands.

## 10. Rollback (unchanged from revision 2)

See revision 2 §10. The payment denial is not reverted by a rollback.

## 11. Concurrency, consistency, and audit summary (unchanged)

See revision 2 §11. `SERIALIZABLE` for money aggregation; `Idempotency-Key`
(72h) and `If-Match` (entity version) on every guarded write; immutable
historical rows preserved.

## 12. Open questions for the reviewer (unchanged from revision 2)

See revision 2 §12.
