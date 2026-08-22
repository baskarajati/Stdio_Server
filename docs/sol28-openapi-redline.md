# SOL-28 redlined OpenAPI diff — engagement-scoped contracts

**Issue:** SOL-28. **Author:** Backend Engineer. **Date:** 2026-08-21.
**Review:** SOL-35 condition 1 — a redlined OpenAPI diff mapping every SOL-27
resource and operation to its engagement-scoped replacement, preserving
`ContractSummary`, `ContractDetail`, quotation detail, variation-order detail,
invoice detail, and collection metadata shapes.

## Conventions

- **ENGAGEMENT-SCOPED** routes carry `/projects/{id}/engagements/{engagementId}`.
- **REPLACED** routes are the existing project-scoped money routes. Each maps
  to an engagement-scoped replacement. A project-scoped money route that has no
  engagement replacement (a blended read) is **DERIVED ROLL-UP**.
- **DEPRECATED** routes return `410 GONE` with problem code `DEPRECATED_ROUTE`
  and a `Link` header to the replacement.
- Every list/detail/write `data` carries `projectId`, `engagementId`,
  `entityVersion`, and the actor capability projection (condition 4).

## 1. Contracts lineage

| SOL-27 operation (project-scoped) | Status | Engagement-scoped replacement | Schema (preserved) |
| --- | --- | --- | --- |
| `GET /projects/{id}/contracts` — `getNativeProjectContracts` | REPLACED | `GET /projects/{id}/engagements/{engagementId}/contracts` | `ContractSummary[]` |
| `GET /projects/{id}/contracts/{contractId}` — `getNativeProjectContract` | REPLACED | `GET /projects/{id}/engagements/{engagementId}/contracts/{contractId}` | `ContractDetail` (revisions, evidence, partySnapshots, capabilities) |

Shapes preserved verbatim: `contractState`, `currentRevision`, `revisions[]`,
`partySnapshots[]`, `evidence[]`, `capabilities.read/write`,
`entityVersion`, `source` (`{href, type: contract}`), `projectCode`,
`projectName`, `engagementId`, `engagementKind`.

## 2. Quotation

| SOL-27 operation | Status | Engagement-scoped replacement | Schema |
| --- | --- | --- | --- |
| `GET /projects/{id}/quotations` — `getNativeProjectQuotations` | REPLACED | `GET .../engagements/{engId}/quotations` | `ProjectQuotation[]` |
| `POST /projects/{id}/quotations` — `createNativeProjectQuotation` | REPLACED | `POST .../engagements/{engId}/quotations` | `ProjectQuotationWriteResponse` |
| `POST /projects/{id}/quotations/{qid}/fee` | REPLACED | `POST .../quotations/{quotationId}/fee` | `ProjectQuotationWriteResponse` |
| `POST /projects/{id}/quotations/{qid}/payment-schedule` | REPLACED | `POST .../quotations/{quotationId}/payment-schedule` | `ProjectQuotationWriteResponse` |
| `POST /projects/{id}/quotations/{qid}/send` | REPLACED | `POST .../quotations/{quotationId}/send` | `ProjectQuotationWriteResponse` |
| `POST /projects/{id}/quotations/{qid}/acceptance` | REPLACED | `POST .../quotations/{quotationId}/acceptance` | `ProjectQuotationWriteResponse` |
| (new) quotation detail | ADDED | `GET .../quotations/{quotationId}` | `ProjectQuotation` |
| (new) guarded assignment | ADDED | `POST .../quotations/{quotationId}/assign` | `ProjectQuotationWriteResponse` |

Shapes preserved: `ProjectQuotation` (`feeItems`, `items`, `paymentMilestones`,
`discount*`, `defaultRatePerSqm`, `canReadFinance`, `engagementId`, nullable
per D-043). The `assign` operation is the only transition that sets
`engagement_id` (condition 2).

## 3. Variation order

| SOL-27 operation | Status | Engagement-scoped replacement | Schema |
| --- | --- | --- | --- |
| `GET /projects/{id}/variation-orders` — `getNativeProjectVariationOrders` | REPLACED | `GET .../engagements/{engId}/variation-orders` | `VariationOrder[]` |
| `GET /projects/{id}/variation-orders/{voId}` | REPLACED | `GET .../variation-orders/{voId}` | `VariationOrderDetailResponse` |
| `POST /projects/{id}/project-changes/{changeId}/variation-order` — `approveAndIssueNativeProjectVariationOrder` | REPLACED | `POST .../engagements/{engId}/project-changes/{changeId}/variation-order` | `VariationOrderWriteResponse` |

Shapes preserved: `VariationOrder` (before/after fee, BOQ, contract value,
`feeEffect`, `boqEffect`, approvals, `taxAmount`, `timeEffectDays`,
`explicitPostContractChange`). The write is atomic and locks the change + the
engagement roll-up under `SERIALIZABLE` (condition 3).

## 4. Invoice

| SOL-27 operation | Status | Engagement-scoped replacement | Schema |
| --- | --- | --- | --- |
| `GET /invoices` — `listNativeInvoices` | KEEP (portfolio) | — | `InvoiceSummary[]` |
| `GET /invoices/{id}` — `getNativeInvoice` | KEEP (portfolio) | — | `InvoiceDetailResponse` |
| `GET /projects/{id}/finance` — `getNativeProjectFinance` | DERIVED ROLL-UP | `GET /projects/{id}/finance` | `ProjectFinanceResponse` (read-only) |
| (new) engagement invoice list | ADDED | `GET .../engagements/{engId}/invoices` | `InvoiceSummary[]` |
| (new) engagement invoice detail | ADDED | `GET .../invoices/{invoiceId}` | `InvoiceDetailResponse` |
| `POST /projects/{id}/finance/invoices/{invoiceId}/collection` — `updateNativeProjectFinanceInvoiceCollection` | REPLACED | `POST .../invoices/{invoiceId}/collection` | `ProjectFinanceInvoiceWriteResponse` |
| `POST /projects/{id}/finance/invoices/{invoiceId}/issue` — `issueNativeProjectFinanceInvoice` | REPLACED (server-denied) | `POST .../invoices/{invoiceId}/issue` | `ProjectFinanceInvoiceWriteResponse` (403 until SOL-25) |
| (new) invoice draft | ADDED (server-denied) | `POST .../invoices/{invoiceId}/draft` | 403 until SOL-25 |
| `POST /projects/{id}/finance/invoices/{invoiceId}/payment` — `recordNativeProjectFinanceInvoicePayment` | REPLACED (permanent denial) | `POST .../invoices/{invoiceId}/payment` | 403, no-op |

Shapes preserved: `InvoiceSummary` (`capabilities`, `client`, `counts`,
`health`, `isOverdue`, `receivableComponents[]`, `source`, `status`,
`*Label` money). Collection metadata (`collectionStatus`, `collectionNote`,
`collectionOwnerId`, `collectionReminderDate`) is control data, not money.

## 5. Schedule of values, progress, milestones

The engagement-scoped replacement keeps these read shapes and adds the
engagement anchor. Writes (`issue`, `sign`, `supersede`, `void`) are gated by
the same SOL-25/review rules as invoice issue. They are listed here so the
redline is complete; their write enforcement follows §3.4 in the design.

| SOL-27 operation | Status | Engagement-scoped replacement |
| --- | --- | --- |
| `GET /projects/{id}/schedule-of-values` | REPLACED | `GET .../engagements/{engId}/schedule-of-values` |
| `createNativeProjectScheduleOfValues` / draft / issue | REPLACED | engagement-scoped; issue gated |
| `GET /projects/{id}/progress-claims` | REPLACED | `GET .../engagements/{engId}/progress-claims` |
| progress-claim create/draft/submit/reject/supersede/void | REPLACED | engagement-scoped |
| `GET /projects/{id}/progress-certificates` | REPLACED | `GET .../engagements/{engId}/progress-certificates` |
| progress-certificate create/draft/issue/sign/supersede/void | REPLACED | engagement-scoped |
| `GET /projects/{id}/milestones` | REPLACED | `GET .../engagements/{engId}/milestones` |
| milestone create/update/shift/progress | REPLACED | engagement-scoped |

## 6. Deprecation shims

Every replaced project-scoped money route (the project-scoped quotation,
variation-order, collection, issue milestone, payment, schedule-of-values,
progress claim, progress certificate routes) is registered and returns:

```text
410 GONE
Problem: { code: "DEPRECATED_ROUTE", detail: "Use the engagement-scoped route." }
Link: <the engagement-scoped replacement>
```

No project-scoped money route accepts a write (condition 5). The
portfolio registers (`/quotations`, `/invoices`) stay, with `engagementId`
populated and pagination bound to their own scope.

## 7. The only derived project roll-up

`GET /projects/{id}/finance` is the sole project-scoped money read. It is
derived by summing approved engagement `transaction_price` and engagement
invoices; it never returns a blended individual record and never accepts a
write (condition 5).

## 8. Schema preservation guarantee

No existing schema loses a required field. `ContractSummary`, `ContractDetail`,
`ProjectQuotation`, `VariationOrder`, `InvoiceSummary`, `InvoiceDetail`, and
`ProjectFinance` keep every required property **and every declared money
type**. No projection's money type is changed (design §1.2), because the native
consumer decoders split:

- `VariationOrder` / `ScheduleOfValuesLine` / progress declare
  `type: [string,"null"]` "Canonical 2dp money string" — native `String?` +
  `Decimal(string:)`.
- `ProjectQuotation` / `ProjectFinanceInvoice` / `ProjectFinanceSummary` /
  `ProjectMilestone.amount` declare `type: number` — native `Decimal?` decode
  from a JSON number. Swift's `JSONDecoder` rejects a string for `Decimal?`
  (empirically verified, design §1.1).

The `*Label` presentation variants are preserved and derived from the same
minor-unit value.

### 8.1 Lossless number-typed money (rev 3)

A number-typed money field is emitted as a **raw validated JSON number token**
by `serializeJson` (see `docs/sol28-design-v3.md` §1.4), built from the
`numeric(20,2)` column string through `RawDecimal` (BigInt only). It is never
constructed through `Number`, `parseFloat`, or `c.json`/`JSON.stringify`, any
of which would collapse `999999999999999999.99` to `1000000000000000000`. The
native `Decimal?` decoder reads the raw number token exactly and rejects a
canonical string (empirically verified, Swift 6). String-typed money stays a
canonical 2dp string via `moneyWire`. The exact-byte and native-decoder
evidence is in `docs/sol28-money-wire-evidence.md`.
