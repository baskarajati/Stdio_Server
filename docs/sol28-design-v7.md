# SOL-28 contract design revision 7 — complete money wire map (purchase orders, variance, contracts, claims)

**Author:** Backend Engineer. **Date:** 2026-08-22. **Status:** For Founding Engineer review.

Revision 7 replaces revision 6 (document revision `07c830ac`). The revision-6
review returned `revise` on 2026-08-22T11:09Z with one required change: add the
omitted purchase-order fields and the `amountVariance` classification to the
exact wire map. Revision 7 adds them and re-audits the map so every
money-bearing field of every native v1 response path in the SOL-28 surface is
classified by wire form and by native consumer.

## 0. Change from revision 6

The corrected field map (§1) adds the purchase-order projection family and the
`amountVariance` classification. The re-audit also found and classified four
adjacent omissions, so the map is now complete rather than patched once more:

1. `ContractRevisionSummary.contractValue` — a NUMBER-form money field on the
   SOL-28 contracts surface that no Swift type decodes yet.
2. `QuotationSummary.totalAmount` — the quotation register item; the native
   register reads `totalAmountLabel` only.
3. `ProjectSpecItem.unitCost` — served by the same DTO as the existing spec
   rows (`NativeProjectSpecItemDTO`, ProjectSpecs.swift:392); added to that row
   so the schema column names every spec schema that carries `unitCost`.
4. The `ProgressClaim`, `ProgressClaimLine`, and `ProgressCertificate` money
   fields — the contract declares them as canonical 2dp money STRINGS; no Swift
   type decodes them yet.

Everything that passed in revision 6 is preserved unchanged: the closed
`RAW_TOKENS.has(value)` registry guard with `TypeError`, the forged-prototype
regression test, the `ProjectFinanceInvoice.payments[].amount` row, the native
exact-decimal migration plan M1-M9 / P1-P5, the two wire forms, the banned
`Number`/`JSON.stringify` path, the engagement-scoped route map, the D-033
variation-order transaction-price behaviour, capability / idempotency /
entity-version guards, invoice-write denial until SOL-25, and permanent
payment-write denial.

## 1. The complete corrected money wire map (rev 7)

Every money-bearing field of every schema referenced by a native v1 response
path in the SOL-28 surface is listed below. Rows marked `NEW` were added in
revision 7. All other rows are unchanged from revision 6.

### 1.1 NUMBER form — encoder: `RawDecimal` via `moneyNumber` + `serializeJson`

The server emits a validated raw JSON decimal token. The contract declares
`type: number`. The native consumer decodes a JSON number token; a string is a
hard `typeMismatch`.

| Schema | Field(s) | Wire form | CURRENT native consumer | Status |
| --- | --- | --- | --- | --- |
| `ProjectQuotation` | `defaultRatePerSqm`, `discountAmount`, `discountPercent` | number | `NativeProjectQuotationDTO.defaultRatePerSqm`/`discountAmount`/`discountPercent` — `Double?` (`ProjectQuotations.swift:754-758`) | MIGRATE |
| `ProjectQuotation` | `subtotalAmount`, `totalAmount` | number | `NativeProjectQuotationDTO.subtotalAmount`/`totalAmount` — `Double?` (771, 773) | MIGRATE |
| `ProjectQuotation.feeItems[]` | `lineTotal`, `ratePerSqm` | number | `NativeProjectQuotationFeeItemDTO.lineTotal`/`ratePerSqm` — `Double?` (809, 811) | MIGRATE |
| `ProjectQuotation.paymentMilestones[]` | `amount`, `percentage` | number | `NativeProjectQuotationPaymentMilestoneDTO.amount`/`percentage` — `Double?` (816, 821) | MIGRATE (see note) |
| `ProjectQuotation.items[]` | `lineTotal`, `unitPrice` | number | `NativeProjectQuotationItemDTO.lineTotal`/`unitPrice` — `Double?` (827, 830) | MIGRATE |
| `QuotationSummary` | `totalAmount` | number | `QuotationWorkspaceItem` reads `totalAmountLabel` only (`BusinessAppQuotations.swift:68, 362`); no numeric decode | LABEL-ONLY; server MUST emit losslessly (`native-v1.yaml:10889`) — NEW |
| `ProjectFinanceInvoice` | `outstandingAmount`, `paidAmount`, `totalAmount` | number | `NativeProjectFinanceInvoiceDTO` does NOT decode them — reads `*Label` only (`ProjectFinance.swift:901-937`) | LABEL-ONLY (§1.3) |
| `ProjectFinanceInvoice.payments[]` | `amount` | number | NO native consumer decodes it: `NativeInvoicePaymentDTO` (`BusinessAppFinance.swift:885-891`) reads `amountLabel` only; the contract requires the field (`native-v1.yaml:8329`) so the server MUST emit it losslessly via `RawDecimal` even though the current consumer is label-only | LABEL-ONLY (rev 5 addition) |
| `ProjectFinanceInvoice.receivableComponents[]` | `amount`, `outstandingAmount`, `settledAmount` | number | `NativeProjectFinanceInvoiceComponentDTO` does NOT decode them — reads `*Label` only | LABEL-ONLY (§1.3) |
| `ProjectFinanceSummary` | `actualCost`, `contractValue`, `effectiveContractValue`, `effectiveVariationValue`, `forecastAtCompletion`, `forecastToComplete`, `grossMargin`, `grossProfit`, `invoicedValue`, `netCashflow`, `originalContractValue`, `payables`, `quotedValue`, `receivables`, `recognizedRevenue`, `cashIn`, `cashOut`, `committedCost` | number | `NativeProjectFinanceSummaryDTO` does NOT decode them — reads `*Label` only (`ProjectFinance.swift:877-899`) | LABEL-ONLY (§1.3) |
| `ProjectMilestone` | `amount` | number | `NativeProjectMilestoneDTO` does NOT decode `amount` — reads `amountLabel` only (`ProjectMilestones.swift:672-703`) | LABEL-ONLY (§1.3) |
| `ProjectOverview.finance` | `contractValue`, `invoiced`, `outstanding`, `effectiveContractValue`, `effectiveVariationValue`, `originalContractValue` | number | `NativeProjectOverviewFinanceDTO` decodes only the first three as `Double?` (`ProjectOverview.swift:216-221`); the effective/original variants are not decoded today and are added as `Decimal?` in M5 for map completeness | MIGRATE (three decoded; three added) |
| `SpecItemSummary.unitCost`, `SpecItemDetail.unitCost`, `SpecAlternate.unitCost`, `ProjectSpecItem.unitCost` | `unitCost` | number | `NativeSpecItemDTO.unitCost` / `NativeSpecAlternateDTO.unitCost` — `Double?` (`BusinessAppSpecs.swift:844, 857`); `NativeProjectSpecItemDTO.unitCost` — `Double?` (`ProjectSpecs.swift:392`, decodes the `ProjectSpecItem` list AND status detail) | MIGRATE (`ProjectSpecItem` added to this row — NEW) |
| `NativeProjectBlueprintDTO` | `defaultRatePerSqm` | number | `Double?` (`ProjectBlueprints.swift:138`) | MIGRATE |
| `ContractRevisionSummary` | `contractValue` | number | NO native consumer yet: no Swift type decodes the contracts surface (`native-v1.yaml:10122`); the server MUST still emit it losslessly | Server emits via `RawDecimal`; no migration needed — NEW |
| `PurchaseOrderSummary` | `totalAmount` | number | `NativePurchaseOrderDTO` does NOT decode it — reads `totalLabel` only (`BusinessAppProcurement.swift:1515-1539`); required by contract (`native-v1.yaml:12296`) | LABEL-ONLY; server MUST emit losslessly — NEW |
| `PurchaseOrderDetail` | `totalAmount` | number | same DTO (`native-v1.yaml:12413`) | LABEL-ONLY; server MUST emit losslessly — NEW |
| `PurchaseOrderLineItem` | `lineTotal` | number | `NativePurchaseOrderLineItemDTO` does NOT decode it — reads `lineTotalLabel` only (`BusinessAppProcurement.swift:1541-1556`); required (`native-v1.yaml:12106`) | LABEL-ONLY; server MUST emit losslessly — NEW |
| `PurchaseOrderLineItem` | `unitCost` | number | same DTO — reads `unitCostLabel` only (`native-v1.yaml:12138`) | LABEL-ONLY; server MUST emit losslessly — NEW |
| `ProjectPurchaseOrderCandidateSpecItem` | `lineCost` | number | `ProjectPurchaseOrderCandidateSpec` reads `lineCostLabel` only (`ProjectPurchaseOrders.swift:60-76`); required (`native-v1.yaml:14618`) | LABEL-ONLY; server MUST emit losslessly — NEW |

**Note on rates and percentages:** `percentage`, `discountPercent`,
`ratePerSqm`, and `unitCost` are money *rates* (a per-unit price or a
percentage) that the app presents as a number. They are not a monetary total,
but they ARE declared `type: number` and come from the same `numeric` money
path on the server. They follow the same exact-decimal migration (§2). Where
the value is a pure ratio the migration is to `Decimal?` for consistency and
to avoid a float in any money-shaped field; there is no billing impact because
it is not a monetary amount.

### 1.2 STRING form — encoder: `moneyWire` (canonical 2dp string)

The server emits a canonical 2dp decimal string. The native consumer decodes
`String?` (parsed with `Decimal(string:locale:)` where arithmetic is needed).

| Schema | Field(s) | Wire form | Native consumer | Status |
| --- | --- | --- | --- | --- |
| `VariationOrder` | `beforeFeeAmount`, `afterFeeAmount`, `feeEffect`, `beforeBoqAmount`, `afterBoqAmount`, `boqEffect`, `beforeContractValue`, `afterContractValue`, `totalAmount`, `taxAmount` | string | `VariationOrderDTO` `String?` + `Decimal(string:locale:)` | Correct — keep |
| `ScheduleOfValuesLine` | `unitRate`, `lineSubtotal`, `lineTaxAmount`, `lineTotal`, `quantity` | string | `String?` + `Decimal(string:locale:)` | Correct — keep |
| `ScheduleOfValues` | `subtotalAmount`, `taxAmount`, `totalAmount` | string | `String?` + `Decimal(string:locale:)` | Correct — keep |
| `PurchaseOrderChangeControl` | `amountVariance` | string | `NativePurchaseOrderChangeControlDTO.amountVariance` — `String?` (`BusinessAppProcurement.swift:1558-1571`); presentation reads `amountVarianceLabel` (gated behind `canReadFinance`, line 896); required (`native-v1.yaml:12167`) | Correct — keep — NEW |
| `ProgressClaimLine` | `cumulativeAmount`, `currentAmount`, `unitRateSnapshot`, `quantityClaimed` | string | NO native consumer yet; contract declares "canonical 2dp money string when `canReadFinance` is true; null when the native money lens is off" (`native-v1.yaml:9431-9445`) | Correct — keep — NEW |
| `ProgressClaim` | `claimedSubtotal`, `claimedTax`, `claimedTotal` | string | NO native consumer yet; same declared semantics (`native-v1.yaml:9456-9462`) | Correct — keep — NEW |
| `ProgressCertificate` | `advanceRecoveryAmount`, `baseSubtotal`, `baseTax`, `baseTotal`, `cashDueAmount`, `certifiedSubtotal`, `certifiedTax`, `certifiedTotal`, `priorTaxedAdvanceAmount`, `retentionAmount`, `roundingResult`, `taxBasis` | string | NO native consumer yet; same declared semantics (`native-v1.yaml:9591-9656`); `fxRate` (`9624`) is a canonical 8dp exchange-rate string, kept on the same `moneyWire` path | Correct — keep — NEW |

The lens-off behaviour is explicit in the contract for these fields: the money
string is `null` when `canReadFinance` is false. That is exactly
`maskMoney` + `moneyWire` on the server.

### 1.3 Label-only native consumers

The following native consumers read a presentation `*Label`, not a raw number.
They do NOT decode the contract's numeric money fields. The label is computed
by the server from the exact `numeric(20,2)` value, so the label is correct
even though the consumer never sees the raw number. This is NOT a money
correctness risk on the native side. The numeric twins listed in §1.1 are
still REQUIRED on the wire and MUST be emitted losslessly via `RawDecimal`.

| Native consumer | Reads | Does NOT read | Contract source |
| --- | --- | --- | --- |
| `NativeProjectFinanceSummaryDTO` (`ProjectFinance.swift:877-899`) | `cashInLabel`, `cashOutLabel`, `contractValueLabel`, `grossMarginLabel`, `grossProfitLabel`, `payablesLabel`, `quotedValueLabel`, `receivablesLabel` | the numeric summary fields | `ProjectFinanceSummary` |
| `NativeProjectFinanceInvoiceDTO` (`ProjectFinance.swift:901-937`) | `outstandingAmountLabel`, `paidAmountLabel`, `totalAmountLabel`, component `*Label`, withholding `*Label`, `dueDateLabel`, `statusLabel`, `collectionStatusLabel` | the numeric `outstandingAmount`, `paidAmount`, `totalAmount`, component `amount` | `ProjectFinanceInvoice` |
| `NativeProjectFinanceInvoiceComponentDTO` (`ProjectFinance.swift:940-946`) | `amountLabel`, `outstandingAmountLabel`, `settledAmountLabel` | the numeric `amount`, `outstandingAmount`, `settledAmount` | `receivableComponents[]` |
| `NativeProjectMilestoneDTO` (`ProjectMilestones.swift:672-703`) | `amountLabel`, `invoiceSummary.invoicedAmountLabel` | the numeric `amount` | `ProjectMilestone` |
| `InvoiceSummary` / `InvoiceDetail` / `InvoiceReceivableComponent` (contract) | `outstandingAmountLabel`, `paidAmountLabel`, `totalAmountLabel`, `amountLabel`, `settledAmountLabel` | (the contract declares ONLY `*Label`, no numeric) | `InvoiceSummary`, `InvoiceDetail`, `InvoiceReceivableComponent` |
| `QuotationWorkspaceItem` (`BusinessAppQuotations.swift:68, 362`) | `totalAmountLabel` | the numeric `totalAmount` | `QuotationSummary` — NEW |
| `NativePurchaseOrderDTO` (`BusinessAppProcurement.swift:1515-1539`) | `totalLabel` | the numeric `totalAmount` | `PurchaseOrderSummary` / `PurchaseOrderDetail` — NEW |
| `NativePurchaseOrderLineItemDTO` (`BusinessAppProcurement.swift:1541-1556`) | `lineTotalLabel`, `unitCostLabel` | the numeric `lineTotal`, `unitCost` | `PurchaseOrderLineItem` — NEW |
| `NativePurchaseOrderChangeControlDTO` (`BusinessAppProcurement.swift:1558-1571`) | `amountVarianceLabel`, `currentTotalLabel`, `confirmedTotalLabel` | (the numeric twin of `amountVariance` is STRING form, decoded as `String?`; the totals have no numeric twin) | `PurchaseOrderChangeControl` — NEW |
| `ProjectPurchaseOrderCandidateSpec` (`ProjectPurchaseOrders.swift:60-76`) | `lineCostLabel` | the numeric `lineCost` | `ProjectPurchaseOrderCandidateSpecItem` — NEW |

**Critical correction vs revision 3 (unchanged from revision 5):** revision 3
listed `NativeProjectFinanceInvoiceDTO`, `NativeProjectFinanceSummaryDTO`, and
`NativeProjectMilestoneDTO` in the NUMBER-form table as `Decimal?` decoders.
That was wrong. They are label-only. The only `Double?` money decoders on the
native side are in `NativeProjectQuotationDTO`,
`NativeProjectOverviewFinanceDTO`, `NativeProjectSpecDTO`,
`NativeSpecDTO`/`NativeSpecAlternateDTO`, and `NativeProjectBlueprintDTO`. The
`BusinessAppQuotations.QuotationDTO` family already decodes the money totals to
`Decimal?` (migrated); only its `ratePerSqm`/`percentage`/`discountPercent`
remain `Double?` (money-shaped rates). The purchase-order DTO family and the
contracts / progress-claim / progress-certificate surfaces have no numeric
money decode at all.

## 2. Exact-decimal native migration plan (unchanged from revision 5, complete)

Wire decoders (DTO layer) M1-M9 and public model propagation P1-P5 from
revision 5 are preserved unchanged. They cover every current `Double?` money
decoder: quotation DTOs and public models (`ProjectQuotation`,
`ProjectQuotationFeeItem`, `ProjectQuotationPaymentMilestone`,
`ProjectQuotationItem`, `ProjectOverviewFinance`, `ProjectBlueprint`), spec
DTOs (`NativeProjectSpecItemDTO`, `NativeSpecItemDTO`,
`NativeSpecAlternateDTO`), and the `QuotationFamilyAdapter` projections.

Explicitly NOT migrated (no `Double?` money decode exists):

- `NativeProjectFinanceSummaryDTO`, `NativeProjectFinanceInvoiceDTO`,
  `NativeProjectFinanceInvoiceComponentDTO`,
  `NativeProjectFinanceInvoiceWithholdingDTO`
  (`ProjectFinance.swift:877-946`) — label-only (§1.3).
- `NativeInvoicePaymentDTO` (`BusinessAppFinance.swift:885-891`) and the whole
  portfolio invoice DTO family — label-only; `payments[].amountLabel` only.
- `NativeProjectMilestoneDTO` (`ProjectMilestones.swift:672+`) — label-only;
  its public write inputs (`ProjectMilestoneCreateInput.amount`,
  `ProjectMilestoneEditInput.amount`, lines 107-129) are already `String`.
- `QuotationWorkspaceItem` (`BusinessAppQuotations.swift:68, 362`) — reads
  `totalAmountLabel` only — NEW.
- `NativePurchaseOrderDTO`, `NativePurchaseOrderLineItemDTO`,
  `NativePurchaseOrderChangeControlDTO` (`BusinessAppProcurement.swift:1515-1571`)
  — no numeric money decode; labels and `String?` only — NEW.
- `ProjectPurchaseOrderCandidateSpec` (`ProjectPurchaseOrders.swift:60-76`) —
  `lineCostLabel` only — NEW.
- `ContractRevisionSummary` (contracts surface), `ProgressClaim`,
  `ProgressClaimLine`, `ProgressCertificate` — no native consumer exists yet;
  there is nothing to migrate — NEW.
- `area`, `quantity`, `progressPercent`, sort orders, counts — not money.

## 3. Verification (re-run 2026-08-22 on this host, revision 7 evidence)

Revision 7 changes the proposal document only. No server, route, OpenAPI
contract, Swift source, schema, migration, or deployment code changed, so the
revision-6 code evidence is re-verified unchanged:

- `pnpm --filter @stdio/server test` passed: 38 tests (money 33, rawroute 2,
  me 3).
- `pnpm --filter @stdio/server typecheck` passed.
- `pnpm --filter @stdio/core test` passed: 51 tests.
- `scripts/sol28-money-native-proof.sh` passed. Server bytes:
  `{"small":0.01,"neg":-0.01,"big":999999999999999999.99}`. `Double?` reads
  the large value as `1e+18` (LOSSY). `Decimal?` reads
  `999999999999999999.99` (EXACT).
- `contracts/openapi/native-v1.yaml` is unchanged in this repository.

## 4. Boundary and gate

No route, OpenAPI contract, native Swift source, database schema, migration, or
deployment changed. This revision does not authorise consequential
implementation.

The Founding Engineer must record `concur` or `concur with conditions` for
this exact document revision. Only then may a CEO confirmation target this
same revision. A later `revise` verdict invalidates that confirmation.
