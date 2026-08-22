# SOL-28 design revision 5 — engagement-scoped contracts and guarded money writes

**Author:** Backend Engineer. **Date:** 2026-08-22. **Status:** For re-review.
**Review:** SOL-43 review of revision `b4be57ab` returned `revise` on
2026-08-22 with three required changes: structurally safe and immutable raw
decimal tokens, mutation and subtype tests for raw-token handling, and a
complete wire map (invoice payment amounts) plus propagated native Decimal
changes. Revision 5 addresses all three. Everything else is unchanged from
revision 4.
**Parent issue:** SOL-28 (`5ab0e704-777b-464c-b017-461565ff7c5d`).
**Review child:** SOL-43 (`f79fe76a-c89f-4594-95f5-326b43cefaa4`).

## 0. What changes from revision 4, and what is preserved

Revision 4 was rejected for three defects, each reproduced by the reviewer or
re-verified against the vendored contract during this revision:

1. **`RawDecimal` allowed raw-fragment injection.** The reviewer reproduced
   `{"amount":0,"injected":true}` through a subclass overriding `serialize()`.
   Re-verification on this host confirms three live vectors in revision 4's
   shape: a subclass override of `serialize()`, a prototype patch of
   `serialize()`, and post-construction mutation of the public `value`
   property (`readonly` is TypeScript-only at runtime). All three emitted an
   unvalidated fragment as a bare JSON token.
2. **The claimed complete map omitted `ProjectFinanceInvoice.payments[].amount`.**
   The vendored contract declares it (`native-v1.yaml:8329`, `type: number`,
   inside the `payments[]` array of `ProjectFinanceInvoice`). Revision 5 adds
   the row and re-audits every money-bearing schema against the contract.
3. **M1-M4 omitted public quotation models that still decode `Double?`.**
   Revision 5 propagates every migration through the public model layer:
   `ProjectQuotation`, `ProjectQuotationFeeItem`,
   `ProjectQuotationPaymentMilestone` (all `ProjectQuotations.swift:11-64`),
   `ProjectOverviewFinance` (`ProjectOverview.swift:14-46`), and
   `ProjectBlueprint` (`ProjectBlueprints.swift:21`), plus their fixture
   readers and the one app-layer display consumer
   (`App/Numanta/ProjectSubmodules/ProjectScheduleSubmodule.swift:331-338`).
   The `percentage.rounded()` / `Int(percentage)` formatting call becomes a
   Decimal-safe equivalent.

Preserved from revision 4 (unchanged): the two-wire-form analysis (§1.1-1.3),
the lossless encoder contract (§1.4, now hardened), the corrected per-consumer
wire map (§1.5, now complete), the label-only table (§1.6), the route map and
retained invariants (§2), the end-to-end proof (§4), the test plan (§5,
extended), migration path (§6), concurrency summary (§7), and open questions
(§9). Invariant list per SOL-43 requirement 6:

1. `serializeJson` / `jsonResponse` stay the only writer on a money-bearing
   response, and the raw token comes only from the validated registry (§1.7).
2. Engagement-scoped routes under `/projects/{id}/engagements/{engId}/...`;
   project finance stays a read-only roll-up (§2).
3. D-033: only an approved variation order changes transaction price,
   atomically under `SERIALIZABLE`.
4. Capability / idempotency / entity-version guards on every guarded write.
5. Invoice draft and issue server-denied until SOL-25.
6. Payment recording permanent denial; capability-disabled no-op 403.
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

### 1.4 The one lossless encoder — `apps/server/src/money.ts` (rev 5: hardened)

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

### 1.5 Field-by-field money map (rev 5 — complete)

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
| `ProjectFinanceInvoice` | `outstandingAmount`, `paidAmount`, `totalAmount` | number | `NativeProjectFinanceInvoiceDTO` does NOT decode them — reads `*Label` only (`ProjectFinance.swift:901-937`) | LABEL-ONLY (§1.6) |
| `ProjectFinanceInvoice.payments[]` | `amount` | number | NO native consumer decodes it: `NativeInvoicePaymentDTO` (`BusinessAppFinance.swift:885-891`) reads `amountLabel` only; the contract requires the field (`native-v1.yaml:8329`) so the server MUST emit it losslessly via `RawDecimal` even though the current consumer is label-only | LABEL-ONLY (rev 5 addition) |
| `ProjectFinanceInvoice.receivableComponents[]` | `amount`, `outstandingAmount`, `settledAmount` | number | `NativeProjectFinanceInvoiceComponentDTO` does NOT decode them — reads `*Label` only | LABEL-ONLY (§1.6) |
| `ProjectFinanceSummary` | `actualCost`, `contractValue`, `effectiveContractValue`, `effectiveVariationValue`, `forecastAtCompletion`, `forecastToComplete`, `grossMargin`, `grossProfit`, `invoicedValue`, `netCashflow`, `originalContractValue`, `payables`, `quotedValue`, `receivables`, `recognizedRevenue`, `cashIn`, `cashOut`, `committedCost` | number | `NativeProjectFinanceSummaryDTO` does NOT decode them — reads `*Label` only (`ProjectFinance.swift:877-899`) | LABEL-ONLY (§1.6) |
| `ProjectMilestone` | `amount` | number | `NativeProjectMilestoneDTO` does NOT decode `amount` — reads `amountLabel` only (`ProjectMilestones.swift:672-703`) | LABEL-ONLY (§1.6) |
| `ProjectOverview.finance` | `contractValue`, `invoiced`, `outstanding`, `effectiveContractValue`, `effectiveVariationValue`, `originalContractValue` (all six declared `number|null`, schema `native-v1.yaml:7400-7460`) | number | `NativeProjectOverviewFinanceDTO` decodes only the first three as `Double?` (`ProjectOverview.swift:216-221`); the effective/original variants are not decoded today and are added as `Decimal?` in M5 for map completeness | MIGRATE (the three decoded; three added) |
| `SpecItemSummary.unitCost`, `SpecItemDetail.unitCost`, `SpecAlternate.unitCost` | `unitCost` | number | `NativeProjectSpecItemDTO.unitCost` — `Double?` (`ProjectSpecs.swift:392`, decodes list AND detail); `NativeSpecItemDTO.unitCost` / `NativeSpecAlternateDTO.unitCost` — `Double?` (`BusinessAppSpecs.swift:844,857`). `PurchaseOrderLineItem.unitCost` has no numeric native consumer (label-only, `BusinessAppProcurement.swift:1541+`) | MIGRATE |
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

### 1.7 Proof `serializeJson` cannot inject an unvalidated raw fragment (rev 5: structural)

Revision 4's proof relied on "the only raw emitter is a validated
`RawDecimal`" — but the emission went through `value.serialize()`, an
overridable method on a mutable instance. The reviewer exploited exactly that.
Revision 5 makes the safety **structural**, not procedural:

1. The raw token exists in exactly one place: the module-private `RAW_TOKENS`
   WeakMap, written once by the validating constructor.
2. `serializeJson` first requires `RAW_TOKENS.has(value)`, then emits
   `RAW_TOKENS.get(value)`. It never calls a method on the value, so subclass
   overrides and prototype patches are dead code for serialization purposes.
   A plain object with its prototype changed to `RawDecimal.prototype` has no
   registry entry. The writer must reject it with `TypeError`; it must never
   emit `undefined`, a raw fragment, or invalid JSON.
3. The instance is frozen. Post-construction mutation throws; `defineProperty`
   throws; added properties throw.
4. Every non-`RawDecimal` value is serialized with per-field `JSON.stringify`
   escaping, unchanged from revision 4.

Attack/proof matrix (all asserted in `apps/server/src/money.test.ts`, §5):

| Vector | Revision 4 result | Revision 5 result |
| --- | --- | --- |
| Subclass overriding `serialize()` returns `{"amount":0,"injected":true}` | injected: emitted raw | blocked: output is `{"amount":0.01}` |
| Prototype patch of `RawDecimal.prototype.serialize` | injected | blocked: serializer never calls it |
| Plain object with `RawDecimal.prototype` | not tested | blocked: no `RAW_TOKENS` entry, writer throws `TypeError` |
| `(d as {value:string}).value = fragment` after construction | injected (readonly was TS-only) | throws: frozen instance |
| `Object.defineProperty(d, 'value', ...)` | injectable | throws: frozen instance |
| String containing `"amount":0` as a plain value | escaped (unchanged) | escaped |
| `new RawDecimal('1.999')` (>2dp) | constructor throws | constructor throws (unchanged) |
| `new RawDecimal('1000000000000000000.00')` (out of range) | constructor throws | constructor throws (unchanged) |

The reviewer's reproduced payload `{"amount":0,"injected":true}` cannot be
produced by any of these vectors against the hardened writer.

## 2. Route map and retained invariants (unchanged from revision 3)

The engagement-scoped route map stands (§2 of revision 3):
`/projects/{id}/engagements/{engId}/contracts`, `/quotations`,
`/variation-orders`, `/invoices`; the derived read-only
`GET /projects/{id}/finance`; and the `410` deprecation shims. The route map is
unchanged because the reviewer's revise did not reject the route design.

## 3. Exact-decimal native migration plan for every current `Double` money decoder (rev 5: complete)

The migration now covers every decoder AND every public model the decoder
feeds, so no `Double` money value survives anywhere between wire and view.
Each step is mechanical: change the property type to `Decimal?`/`Decimal`,
change the `decodeIfPresent(Double.self, ...)` call to
`decodeIfPresent(Decimal.self, ...)`, and fix the compile errors that point at
the remaining float consumers. `Foundation` is already imported everywhere.

Wire decoders (DTO layer):

| # | File | Property | Current → Corrected |
| --- | --- | --- | --- |
| M1 | `Packages/BusinessAppProjects/Sources/ProjectQuotations.swift` (754-758, 771, 773) | `NativeProjectQuotationDTO.defaultRatePerSqm`, `discountAmount`, `discountPercent`, `subtotalAmount`, `totalAmount` | `Double?` → `Decimal?` |
| M2 | same (806-811) | `NativeProjectQuotationFeeItemDTO.lineTotal`, `ratePerSqm` (`area` stays `Double`) | `Double?` → `Decimal?` |
| M3 | same (816-821) | `NativeProjectQuotationPaymentMilestoneDTO.amount`, `percentage` | `Double?` → `Decimal?` |
| M4 | same (824-830) | `NativeProjectQuotationItemDTO.lineTotal`, `unitPrice` (`quantity` stays `Double`) | `Double?` → `Decimal?` |
| M5 | `Packages/BusinessAppProjects/Sources/ProjectOverview.swift` (216-221) | `NativeProjectOverviewFinanceDTO.contractValue`, `invoiced`, `outstanding`; add the undecoded contract fields `effectiveContractValue`, `effectiveVariationValue`, `originalContractValue` as `Decimal?` so the map is complete (schema `native-v1.yaml:7408-7436`, `additionalProperties: false`) | `Double?` → `Decimal?` |
| M6 | `Packages/BusinessAppProjects/Sources/ProjectSpecs.swift` (392) | `NativeProjectSpecItemDTO.unitCost` (decodes both `SpecItemSummary` list and `SpecItemDetail`) | `Double?` → `Decimal?` |
| M7 | `Packages/BusinessAppSpecs/Sources/BusinessAppSpecs.swift` (819-848: `NativeSpecItemDTO.unitCost`; 850-859: `NativeSpecAlternateDTO.unitCost`) | both spec DTOs (label-only consumers `BusinessAppProcurement` untouched) | `Double?` → `Decimal?` |
| M8 | `Packages/BusinessAppProjects/Sources/ProjectBlueprints.swift` (138) | `NativeProjectBlueprintDTO.defaultRatePerSqm` | `Double?` → `Decimal?` |
| M9 | `Packages/BusinessAppQuotations/Sources/QuotationFamilyAdapter.swift` (118, 144, 265, 336, 587) | `QuotationFeeItemProjection.ratePerSqm`, `QuotationPaymentMilestoneProjection.percentage`, `QuotationDetailProjection.discountPercent`, `QuotationSummaryProjection.discountPercent` (line 336), `QuotationDTO.discountPercent` decode at 587 | `Double?` → `Decimal?` |

Public model propagation (the revision 4 gap — these are what the app reads):

| # | File | Property | Change |
| --- | --- | --- | --- |
| P1 | `Packages/BusinessAppProjects/Sources/ProjectQuotations.swift` (11, 30, 60, 64) | `ProjectQuotationPaymentMilestone.percentage`, `ProjectQuotationFeeItem.ratePerSqm`, `ProjectQuotation.defaultRatePerSqm`, `ProjectQuotation.discountPercent` and their `init` signatures | `Double?` → `Decimal?` |
| P2 | `Packages/BusinessAppProjects/Sources/ProjectOverview.swift` (14-46) | `ProjectOverviewFinance.contractValue`, `.invoiced`, `.outstanding`; `billedFraction` computes `NSDecimalNumber` division and returns `Double` (display-only ratio, not money) | stored fields → `Decimal` |
| P3 | `Packages/BusinessAppProjects/Sources/ProjectBlueprints.swift` (21, 31) | `ProjectBlueprint.defaultRatePerSqm` + init | `Double?` → `Decimal?` |
| P4 | `Packages/BusinessAppProjects/Sources/ProjectQuotations.swift` (484-495, 526-537, 555-566) | `FixtureProjectQuotationsReader` / write-outcome fixtures that build `Double(item.ratePerSqm ?? "") ?? 0` and `Double(input.percentage)` | parse via `Decimal(string:)`, keep exact literals |
| P5 | `App/Numanta/ProjectSubmodules/ProjectScheduleSubmodule.swift` (331-338) | `paymentAmountLabel`: `percentage.rounded()` / `Int(percentage)` display formatting | compare with `NSDecimalNumber(roundingPerSystem:)` or format via `NumberFormatter`; no arithmetic change to money itself |

Explicitly NOT migrated (verified during this revision):

- `NativeProjectFinanceSummaryDTO`, `NativeProjectFinanceInvoiceDTO`,
  `NativeProjectFinanceInvoiceComponentDTO`,
  `NativeProjectFinanceInvoiceWithholdingDTO`
  (`ProjectFinance.swift:877-946`) — label-only (§1.6).
- `NativeInvoicePaymentDTO` (`BusinessAppFinance.swift:885-891`) and the whole
  portfolio invoice DTO family — label-only; `payments[].amountLabel` only.
- `NativePurchaseOrderLineItemDTO`
  (`BusinessAppProcurement.swift:1541+`) — does not decode numeric `unitCost`;
  `unitCostLabel` only.
- `NativeProjectMilestoneDTO` (`ProjectMilestones.swift:672+`) — label-only;
  its public write inputs (`ProjectMilestoneCreateInput.amount`,
  `ProjectMilestoneEditInput.amount`, lines 107-129) are already `String`.
- `area`, `quantity`, `progressPercent`, sort orders, counts — not money.

**Migration mechanics per file.** Switch the property to `Decimal?` and the
decode call to `decodeIfPresent(Decimal.self, ...)`. Add a migration test per
package that decodes the exact server bytes for `0.01`, `-0.01`, and
`999999999999999999.99` and asserts equality with
`NSDecimalNumber(string:)`. Verify with `swift build` and the package tests;
the app gate (`scripts/gate-native.sh`) runs before any native slice lands.

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
6. **Raw-token immutability** (rev 5, reviewer condition 2): subclass
   overriding `serialize()`, prototype patching `serialize()`,
   post-construction assignment, and `Object.defineProperty` on a token all
   fail to change the emitted bytes; each vector asserts the exact expected
   output (`{"amount":0.01}`) or the throw.
   A prototype-forged plain object also throws before JSON bytes are produced.
7. **Public-model propagation**: after P1-P5, decoding the large-value fixture
   through the PUBLIC models (`ProjectQuotation`,
   `ProjectQuotationPaymentMilestone`, `ProjectOverviewFinance`,
   `ProjectBlueprint`) preserves every digit.

## 6. Migration path and rollback (unchanged)

No data migration is required: the fix is code (the native decoder type change)
plus the already-registered server encoder. Roll back by restoring the
`Double?` properties; the server is unaffected. The payment denial and the
SOL-25 invoice gate are not reverted by a rollback.

## 7. Concurrency, consistency, and audit summary (unchanged)

`SERIALIZABLE` for money aggregation; `Idempotency-Key` (72h) and `If-Match`
(entity version) on every guarded write; immutable historical rows preserved.

## 8. Verification evidence and implementation boundary

All commands run on this host, 2026-08-22, against the hardened writer:

- `pnpm --filter @stdio/server test` → 37 tests pass: the existing money,
  `/me`, and raw-route baseline. This recovery did not alter server code.
- `pnpm --filter @stdio/server typecheck` → clean.
- `pnpm --filter @stdio/core test` → 51 money tests pass (unchanged).
- `scripts/sol28-money-native-proof.sh` → exact-byte + native-decoder proof
  (§4) re-run after hardening; server bytes unchanged
  (`{"small":0.01,"neg":-0.01,"big":999999999999999999.99}`); `Double?` still
  loses the large value, `Decimal?` still exact.
- `contracts/openapi/native-v1.yaml` is unchanged in this repository.

Revision 5 adds one required implementation test before code may land: a plain
object whose prototype is set to `RawDecimal.prototype` must make
`serializeJson` throw `TypeError`. The writer must use `RAW_TOKENS.has(value)`
before reading a token. The current 37-test baseline does not prove that new
vector. This document specifies the change only. It does not authorize or
perform a server, route, contract, or native-code implementation.

## 9. Open questions for the reviewer (unchanged from revision 4)

See revision 3 §12. The native migration in §3 (wire decoders M1-M9 and public
propagation P1-P5) is owned by the Founding Engineer (he owns the Swift
package). The hardened server change remains a proposal. It needs the
prototype-forgery guard and test in §8, a `concur` or `concur with conditions`
verdict, and then the CEO gate before any consequential implementation.
