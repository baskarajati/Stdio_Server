# SOL-28 design revision 4 — engagement-scoped contracts and guarded money writes

**Author:** Backend Engineer. **Date:** 2026-08-22. **Status:** For re-review.
**Review:** SOL-28 comments `90e97f89` and `803a397b` returned `revise`. This
revision supersedes revision 3's money-wire section. It corrects the
field-level wire map (revision 3 wrongly claimed the native quotation decoder
uses `Decimal?`; it uses `Double?`), marks label-only consumers, provides the
exact-decimal native migration plan, adds end-to-end server-byte to
native-decoder proof, and proves `serializeJson` cannot inject unvalidated raw
fragments.
**Parent issue:** SOL-28 (`5ab0e704-777b-464c-b017-461565ff7c5d`).
**Review child:** SOL-43 (`f79fe76a-c89f-4594-95f5-326b43cefaa4`).

## 0. What changes from revision 3, and what is preserved

Revision 3 was rejected for one load-bearing factual error. The reviewer
verified with a real `swiftc -O` run that `JSONDecoder().decode(Double.self,
from: Data("999999999999999999.99".utf8))` returns `1000000000000000000.00`.
The native quotation decoder reads money as `Double?`, not `Decimal?`.
Revision 3's map said `Decimal?` and claimed losslessness. That claim was false.

This revision fixes the money-wire section and adds the missing native
compatibility plan and proof. It preserves every other section exactly: the
engagement-scoped route map, the object model and transitions, the
response envelope, guarded-write mechanics, module layout, deprecation shims,
test plan, migration path, rollback, concurrency/audit summary, and the
open questions. Those sections satisfy the earlier review conditions.

Preserved invariants (SOL-43 requirement 6 — explicit, unchanged:
1. `RawDecimal` response writer: `serializeJson` / `jsonResponse` stay the only
   writer on a money-bearing response (§1.4, §1.7).
2. Engagement-scoped route design: quotations, variation-orders, invoices under
   `/projects/{id}/engagements/{engId}/...`; project finance is a read-only
   roll-up (§2).
3. D-033 variation-order transaction-price behavior: only an approved
   variation order changes transaction price, atomically under `SERIALIZABLE`
   (§3.3, §5).
4. Capability / idempotency / entity-version guards on every guarded write
   (§4, §5).
5. Invoice draft and issue server-denied until SOL-25 (§3.4, §4).
6. Payment recording permanent denial; the route is a no-op 403 with capability
   `canRecordInvoicePayment = { enabled: false, reason }` (§3.5).
7. `contracts/openapi/native-v1.yaml` is NOT edited in this repository.

## 1. The money wire — corrected, field-level, per-consumer

### 1.1 The two wire forms the contract declares

The contract declares TWO money wire forms, and the native consumers decode
them differently (verified below):

| Form | Declared in contract | Correct native consumer | Native requirement |
| --- | --- | --- | --- |
| Canonical 2dp string | `VariationOrder.*`, `ScheduleOfValuesLine.*`, progress | `VariationOrderDTO` money fields `String?`, parsed with `Decimal(string:locale:)` | Accepts a string |
| JSON number token | `ProjectQuotation.*`, `ProjectFinanceInvoice.*`, `ProjectFinanceSummary.*`, `ProjectMilestone.amount`, `ProjectOverview.finance.*`, `SpecItemSummary.unitCost` | See §1.5 — many are `Double?` (LOSSY) and MUST be migrated | Accepts a number token; a string is a hard `typeMismatch` |

### 1.2 Why `Number` / `JSON.stringify` are banned on a money payload

A JavaScript `Number` is a float64 and cannot carry every `numeric(20,2)` value.
Proven on this host (Node 22):

```
String(Number("999999999999999999.99")) === "1000000000000000000"  // false
JSON.stringify({amount: Number("999999999999999999.99")})          // {"amount":1000000000000000000}
```

The last two decimal places are lost. `Number`, `parseFloat`, and
`JSON.stringify`/`c.json` MUST NOT be used on a money-bearing response payload.

### 1.3 The reviewer's native evidence is confirmed (Swift 6, arm64, 2026-08-22)

Compiled and run on this host. The CURRENT native money field type `Double?`
loses the large value; the CORRECTED type `Decimal?` reads it exactly:

```swift
struct Q: Decodable { let amount: Double? }   // CURRENT NativeProjectQuotationDTO
struct D: Decodable { let amount: Decimal? }  // CORRECTED
```

| JSON token | `Double?` (current) | `Decimal?` (corrected) |
| --- | --- | --- |
| `0.01` | `0.01` | `0.01` |
| `-0.01` | `-0.01` | `-0.01` |
| `999999999999999999.99` | `1e+18` == `1000000000000000000` (LOSSY) | `999999999999999999.99` (EXACT) |
| `186000` | `186000.0` | `186000` |

`Double("999999999999999999.99")` renders as `1000000000000000000.00`. The
current decoder changes the stated value before the app presents it. That is
the money-correctness violation.

### 1.4 The one lossless encoder — `apps/server/src/money.ts` (unchanged from rev3)

`RawDecimal` is the validated raw token for a number-form money field. It reads
the `numeric(20,2)` column exactly through `moneyFromDecimal` (BigInt only),
throws on >2dp or out-of-range, and stores the canonical 2dp string. It is
never converted through `Number` or `parseFloat`.

- `moneyNumber(value, currency): RawDecimal | null` — build a NUMBER-form money
  value from a column string; `null` (lens off) stays `null`.
- `moneyWire(value, currency): string | null` — the STRING-form canonical 2dp
  string.
- `serializeJson(value): string` — the raw response writer. A `RawDecimal` is
  emitted verbatim (a bare JSON number token). Every other value serializes
  exactly as `JSON.stringify` per field (see §1.7 safety proof).
- `jsonResponse(body): Response` — builds the `Response` with
  `content-type: application/json` through `serializeJson`, never `c.json`.

### 1.5 Field-by-field money map (rev 4 — corrected)

This is the corrected map. Every declared money-bearing field across the
contract's quotation, finance, invoice, milestone, overview, and spec
projections is listed with its exact native consumer property.

#### NUMBER form — encoder: `RawDecimal` via `moneyNumber` + `serializeJson`

| Schema | Field(s) | Wire form | CURRENT native consumer | Status |
| --- | --- | --- | --- | --- |
| `ProjectQuotation` | `defaultRatePerSqm`, `discountAmount`, `discountPercent` | number | `NativeProjectQuotationDTO.defaultRatePerSqm`/`discountAmount`/`discountPercent` — `Double?` (`ProjectQuotations.swift:754-758`) | MIGRATE |
| `ProjectQuotation` | `subtotalAmount`, `totalAmount` | number | `NativeProjectQuotationDTO.subtotalAmount`/`totalAmount` — `Double?` (771, 773) | MIGRATE |
| `ProjectQuotation.feeItems[]` | `lineTotal`, `ratePerSqm` | number | `NativeProjectQuotationFeeItemDTO.lineTotal`/`ratePerSqm` — `Double?` (809, 811) | MIGRATE |
| `ProjectQuotation.paymentMilestones[]` | `amount`, `percentage` | number | `NativeProjectQuotationPaymentMilestoneDTO.amount`/`percentage` — `Double?` (816, 821) | MIGRATE (see note) |
| `ProjectQuotation.items[]` | `lineTotal`, `unitPrice` | number | `NativeProjectQuotationItemDTO.lineTotal`/`unitPrice` — `Double?` (827, 830) | MIGRATE |
| `ProjectFinanceInvoice` | `outstandingAmount`, `paidAmount`, `totalAmount` | number | `NativeProjectFinanceInvoiceDTO` does NOT decode them — reads `*Label` only | LABEL-ONLY (see §1.6) |
| `ProjectFinanceInvoice.receivableComponents[]` | `amount`, `outstandingAmount`, `settledAmount` | number | `NativeProjectFinanceInvoiceComponentDTO` does NOT decode them — reads `*Label` only | LABEL-ONLY (§1.6) |
| `ProjectFinanceSummary` | `actualCost`, `contractValue`, `effectiveContractValue`, `effectiveVariationValue`, `forecastAtCompletion`, `forecastToComplete`, `grossMargin`, `grossProfit`, `invoicedValue`, `netCashflow`, `originalContractValue`, `payables`, `quotedValue`, `receivables`, `recognizedRevenue`, `cashIn`, `cashOut`, `committedCost` | number | `NativeProjectFinanceSummaryDTO` does NOT decode them — reads `*Label` only (`ProjectFinance.swift:877-899`) | LABEL-ONLY (§1.6) |
| `ProjectMilestone` | `amount` | number | `NativeProjectMilestoneDTO` does NOT decode `amount` — reads `amountLabel` only (`ProjectMilestones.swift:672-703`) | LABEL-ONLY (§1.6) |
| `ProjectOverview.finance` | `contractValue`, `invoiced`, `outstanding`, `effectiveContractValue`, `effectiveVariationValue`, `originalContractValue` | number | `NativeProjectOverviewFinanceDTO.contractValue`/`invoiced`/`outstanding` — `Double?` (`ProjectOverview.swift:216-221`); the effective/original variants are NOT decoded | MIGRATE (the three decoded) |
| `SpecItemSummary.unitCost` | `unitCost` | number | `NativeProjectSpecDTO.unitCost` — `Double?` (`ProjectSpecs.swift:392`); `NativeSpecDTO`/`NativeSpecAlternateDTO.unitCost` — `Double?` (`BusinessAppSpecs.swift:844,857`) | MIGRATE |
| `NativeProjectBlueprintDTO` | `defaultRatePerSqm` | number | `Double?` (`ProjectBlueprints.swift:138`) | MIGRATE |

**Note on `percentage` / `discountPercent` / `ratePerSqm`:** these are money
*rates* (a per-unit price or a percentage) that the app presents as a number.
They are not a monetary total, but they ARE declared `type: number` and come
from the same `numeric` money path on the server. For full correctness on the
large-value edge they must follow the same exact-decimal migration; see the
migration plan (§3). Where the value is a pure ratio (e.g. a discount
percentage) the migration is to `Decimal?` for consistency and to avoid a
float in any money-shaped field; there is no billing impact because it is not
a monetary amount.

#### STRING form — encoder: `moneyWire` (canonical 2dp string)

| Schema | Field(s) | Wire form | Native consumer | Status |
| --- | --- | --- | --- | --- |
| `VariationOrder` | `beforeFeeAmount`, `afterFeeAmount`, `feeEffect`, `beforeBoqAmount`, `afterBoqAmount`, `boqEffect`, `beforeContractValue`, `afterContractValue`, `totalAmount`, `taxAmount` | string | `VariationOrderDTO` `String?` + `Decimal(string:locale:)` | Correct — keep |
| `ScheduleOfValuesLine` | `unitRate`, `lineSubtotal`, `lineTaxAmount`, `lineTotal`, `quantity` | string | `String?` + `Decimal(string:locale:)` | Correct — keep |
| `ScheduleOfValues` | `subtotalAmount`, `taxAmount`, `totalAmount` | string | `String?` + `Decimal(string:locale:)` | Correct — keep |

### 1.6 Label-only native consumers (rev 4 — explicitly labelled)

The following native consumers read a **presentation label**, not a raw
number. They do NOT decode the contract's numeric money fields, so the server
must NOT be expected to feed them a `RawDecimal`, and the label fields are
derived from the same minor-unit value by the presentation layer. These are
marketed label-only because `*Label` is a formatted string, not a numeric.

| Native consumer | Reads | Does NOT read | Contract source |
| --- | --- | --- | --- |
| `NativeProjectFinanceSummaryDTO` (`ProjectFinance.swift:877-899`) | `cashInLabel`, `cashOutLabel`, `contractValueLabel`, `grossMarginLabel`, `grossProfitLabel`, `payablesLabel`, `quotedValueLabel`, `receivablesLabel` | the numeric summary fields | `ProjectFinanceSummary` |
| `NativeProjectFinanceInvoiceDTO` (`ProjectFinance.swift:901-937`) | `outstandingAmountLabel`, `paidAmountLabel`, `totalAmountLabel`, component `*Label`, withholding `*Label`, `dueDateLabel`, `statusLabel`, `collectionStatusLabel` | the numeric `outstandingAmount`, `paidAmount`, `totalAmount`, component `amount` | `ProjectFinanceInvoice` |
| `NativeProjectFinanceInvoiceComponentDTO` (`ProjectFinance.swift:940-946`) | `amountLabel`, `outstandingAmountLabel`, `settledAmountLabel` | the numeric `amount`, `outstandingAmount`, `settledAmount` | `receivableComponents[]` |
| `NativeProjectMilestoneDTO` (`ProjectMilestones.swift:672-703`) | `amountLabel`, `invoiceSummary.invoicedAmountLabel` | the numeric `amount` | `ProjectMilestone` |
| `InvoiceSummary` / `InvoiceDetail` / `InvoiceReceivableComponent` (contract) | `outstandingAmountLabel`, `paidAmountLabel`, `totalAmountLabel`, `amountLabel`, `settledAmountLabel` | (the contract declares ONLY `*Label`, no numeric) | `InvoiceSummary`, `InvoiceDetail`, `InvoiceReceivableComponent` |

The label-only consumers take a formatted string from the server. The server
computes the label from the exact `numeric(20,2)` value via the core money
formatter, so the label is correct even when the consumer never sees the raw
number. This is NOT a money correctness risk on the native side because the
native side never decodes a raw number into a float here.

**Critical correction vs revision 3:** revision 3 listed
`NativeProjectFinanceInvoiceDTO`, `NativeProjectFinanceSummaryDTO`, and
`NativeProjectMilestoneDTO` in the NUMBER-form table as `Decimal?` decoders.
That was wrong. They are label-only. The only `Double?` money decoders on the
native side are in `NativeProjectQuotationDTO`,
`NativeProjectOverviewFinanceDTO`, `NativeProjectSpecDTO`,
`NativeSpecDTO`/`NativeSpecAlternateDTO`, and `NativeProjectBlueprintDTO`. The
`BusinessAppQuotations.QuotationDTO` family already decodes the money totals to
`Decimal?` (migrated); only its `ratePerSqm`/`percentage`/`discountPercent`
remain `Double?` (money-shaped rates).

### 1.7 Proof `serializeJson` cannot inject an unvalidated raw fragment

The only value that is emitted raw (unquoted) by `serializeJson` is a
`RawDecimal` instance. A `RawDecimal` is constructed solely through its
constructor, which calls `moneyFromDecimal` (BigInt only). A value with more
than two decimal places throws `money must have no more than two decimal
places`; a value outside the `numeric(20,2)` range throws `value outside the
numeric` range. Therefore every raw token emitted is a real validated
`numeric(20,2)` value.

Every other value — string, boolean, number, array, object — is serialized
with per-field `JSON.stringify`, so quotes, brackets, and braces are escaped
and can never become a loose fragment. Tests prove this:

- `serializeJson({ x: '", "amount": 0' })` → `{"x":"\", \"amount\": 0"}` (quote escaped)
- `serializeJson({ x: '0.01' })` → `{"x":"0.01"}` (string stays quoted)
- `serializeJson({ x: '{"a":1}' })` → `{"x":"{\"a\":1}"}`
- `serializeJson('null')` → `"null"` (top-level string quoted; cannot become a JSON literal)
- `serializeJson(new RawDecimal('0.01','IDR'))` → `0.01` (only validated path)

These assertions live in `apps/server/src/money.test.ts` (§5). There is no
code path that copies a raw string or an unvalidated fragment into the output.

## 2. Route map and retained invariants (unchanged from revision 3)

The engagement-scoped route map stands (§2 of revision 3):
`/projects/{id}/engagements/{engId}/contracts`, `/quotations`,
`/variation-orders`, `/invoices`; the derived read-only
`GET /projects/{id}/finance`; and the `410` deprecation shims. The route map is
unchanged because the reviewer's revise did not reject the route design.

## 3. Exact-decimal native migration plan for every current `Double` money decoder

This is the plan that makes the native app read every money value exactly. It
is the fix for the reviewer's central finding. Each migration is mechanical:
change the decoder property type from `Double?` (or `Double`) to `Decimal?`
(or `Decimal`) and update the `init(from:)`/`decodeIfPresent` call. `Foundation`
is already imported in every affected file, so `Decimal` is available with no
new dependency. `area`, `quantity`, `progressPercent`, and other
non-money geometry/ratio/percent-of-100 fields stay `Double`/`Int` and are not
part of this plan.

| # | File | Property | Current type | Corrected type |
| --- | --- | --- | --- | --- |
| M1 | `Packages/BusinessAppProjects/Sources/ProjectQuotations.swift` | `NativeProjectQuotationDTO.defaultRatePerSqm`, `discountAmount`, `discountPercent`, `subtotalAmount`, `totalAmount` | `Double?` | `Decimal?` |
| M2 | same | `NativeProjectQuotationFeeItemDTO.lineTotal`, `ratePerSqm` | `Double?` | `Decimal?` |
| M3 | same | `NativeProjectQuotationPaymentMilestoneDTO.amount`, `percentage` | `Double?` | `Decimal?` |
| M4 | same | `NativeProjectQuotationItemDTO.lineTotal`, `unitPrice` | `Double?` | `Decimal?` |
| M5 | `Packages/BusinessAppProjects/Sources/ProjectOverview.swift` | `NativeProjectOverviewFinanceDTO.contractValue`, `invoiced`, `outstanding` | `Double?` | `Decimal?` |
| M6 | `Packages/BusinessAppProjects/Sources/ProjectSpecs.swift` | `NativeProjectSpecDTO.unitCost` | `Double?` | `Decimal?` |
| M7 | `Packages/BusinessAppSpecs/Sources/BusinessAppSpecs.swift` | `NativeSpecDTO.unitCost`, `NativeSpecAlternateDTO.unitCost` | `Double?` | `Decimal?` |
| M8 | `Packages/BusinessAppProjects/Sources/ProjectBlueprints.swift` | `NativeProjectBlueprintDTO.defaultRatePerSqm` | `Double?` | `Decimal?` |
| M9 | `Packages/BusinessAppQuotations/Sources/QuotationFamilyAdapter.swift` | `QuotationFeeItemProjection.ratePerSqm`, `QuotationPaymentMilestoneProjection.percentage`, `QuotationDetailProjection.discountPercent`, `QuotationDTO.discountPercent` | `Double?` | `Decimal?` |

Notes:
- **M1-M9** are the only money-shaped `Double` decoders. `ProjectOverview.swift`
  maps `contractValue`/`invoiced`/`outstanding` into a public
  `ProjectOverviewFinance` model whose fields are also `Double`; that model and
  its `FixtureProjectOverviewReader` (lines 15-19) must change to `Decimal`
  too, and the fixture literals must stay exact.
- **M9** is optional for correctness of *monetary totals* (those are already
  `Decimal?`), but is required for a fully float-free money-shaped surface. It
  is listed because `ratePerSqm` is a money rate and `percentage` /
  `discountPercent` are money-shaped ratios. The FE review asked for "every
  money-bearing `Double` decoder", so these are included.
- **Do NOT change** `NativeProjectFinanceSummaryDTO`,
  `NativeProjectFinanceInvoiceDTO`, `NativeProjectMilestoneDTO` — they are
  label-only (§1.6) and have no numeric money decoder to migrate.
- **`area`, `quantity`, `progressPercent`, sort order, variation count** are not
  money and stay numeric.

**Migration mechanics per file.** Switch the property to `Decimal?` and the
`decode` call to `decodeIfPresent(Decimal.self, ...)`. Add a migration test
that decodes the exact server bytes for `0.01`, `-0.01`, and
`999999999999999999.99` and asserts equality with `NSDecimalNumber(string:)`.
Verify the whole package with `swift build` and run the package tests.

## 4. End-to-end server-byte → native-decoder tests (condition 4)

The reproducible proof is `scripts/sol28-money-native-proof.sh`. It:

1. Emits the server response bytes with the real `serializeJson` +
   `moneyNumber` (via `tsx` on `apps/server/src/money.ts`), so the bytes are
   the literal server output, not a hand-typed fixture.
2. Compiles a Swift program that decodes those exact bytes with the CURRENT
   native money type (`Double?`) and the CORRECTED type (`Decimal?`).
3. Prints both so the loss is visible.

Run on this host (2026-08-22):

```
SERVER-BYTE SAMPLES (raw decimal tokens from serializeJson):
{"small":0.01,"neg":-0.01,"big":999999999999999999.99}

== CURRENT native consumer (Double?) ==
  0.01                  -> 0.01
  -0.01                 -> -0.01
  999999999999999999.99 -> 1e+18
  -> comparing Double? read to exact: LOSSY (ROUNDED)

== CORRECTED native consumer (Decimal?) ==
  0.01                  -> 0.01
  -0.01                 -> -0.01
  999999999999999999.99 -> 999999999999999999.99
  -> comparing Decimal? read to exact: EXACT
```

This is the end-to-end proof the reviewer required: the server emits the exact
token, the current consumer loses it, the corrected consumer reads it exactly.
The three named values (`0.01`, `-0.01`, `999999999999999999.99`) are covered.
A unit test in `apps/server/src/money.test.ts` asserts the exact bytes
(`{"amount":0.01}`, `{"amount":-0.01}`, `{"amount":999999999999999999.99}`) and
that the large token is not the float result and has no exponent.

## 5. Test plan

The revision-3 test plan stands (cross-engagement isolation, cross-studio
isolation, stale response after switch, capability denial, entity conflict,
idempotent replay, atomic variation-order replay, rollback after writes,
payment denial no-op, retensi release without a second PPN event). Revision 4
adds the money-correctness tests:

1. **Lossless exact-byte money**: `0.01`, `-0.01`, `999999999999999999.99`,
   `283050000.00`, and `null` emit the exact bytes (§4).
2. **No float on the money path**: a money field is never built through
   `Number` or `parseFloat`.
3. **Tokenizer safety** (§1.7): a malicious or accidental string is always
   JSON-escaped and can never become a raw fragment; only a validated
   `RawDecimal` is emitted raw.
4. **Native decoder compatibility**: the number-typed projections serve a raw
   number token; the corrected `Decimal?` decoder reads it exactly; the current
   `Double?` decoder is shown to lose the large value (so the native migration
   in §3 is required before the app is correct).
5. **JSON safety**: `serializeJson` output is valid JSON for every combination
   (asserted via `JSON.parse` round-trip).

## 6. Migration path and rollback (unchanged)

No data migration is required: the fix is code (the native decoder type change)
plus the already-registered server encoder. Roll back by restoring the
`Double?` properties; the server is unaffected. The payment denial and the
SOL-25 invoice gate are not reverted by a rollback.

## 7. Concurrency, consistency, and audit summary (unchanged)

`SERIALIZABLE` for money aggregation; `Idempotency-Key` (72h) and `If-Match`
(entity version) on every guarded write; immutable historical rows preserved.

## 8. Verification evidence

- `pnpm --filter @stdio/server test` → 28 money tests pass (incl. the 6 new
  injection-safety asserts) + 2 raw-route + 3 `/me` = 33 tests.
- `pnpm --filter @stdio/server typecheck` → clean.
- `pnpm --filter @stdio/core test` → 51 money tests pass (unchanged).
- `scripts/sol28-money-native-proof.sh` → exact-byte + native-decoder proof
  (§4), run on 2026-08-22.
- `contracts/openapi/native-v1.yaml` is unchanged in this repository.

## 9. Open questions for the reviewer (unchanged from revision 3)

See revision 3 §12. The native migration in §3 is owned by the Founding
Engineer (he owns the Swift package); the server change is ready to implement
once this revision records `concur` or `concur with conditions`.
