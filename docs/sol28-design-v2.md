# SOL-28 design revision 2 — engagement-scoped contracts and guarded money writes

**Author:** Backend Engineer. **Date:** 2026-08-21. **Status:** For re-review.
**Review:** SOL-35 comment `596af8e3` returned `revise` with 11 required
conditions. This revision addresses every condition. The engagement anchor,
server capability projection, atomic variation-order action, and payment
deferral stand; the route map, versioning, idempotency, money wire form, and
legacy-ancestry handling are revised below.
**Parent issue:** SOL-28 (`5ab0e704-777b-464c-b017-461565ff7c5d`).

## 0. How this revision maps to the review conditions

| # | Condition | Where addressed |
| --- | --- | --- |
| 1 | Redlined OpenAPI diff; map every SOL-27 resource/operation to its engagement-scoped replacement; preserve contract/quotation/variation/invoice detail + collection shapes | §2, §3, §7 |
| 2 | Guarded quotation-to-engagement assignment transition; require version, capability, idempotency, same project + studio ancestry | §3.2, §5.2 |
| 3 | Name each mutation concurrency target; VO issue locks change + engagement roll-up; serializable/conflict-safe | §3.3, §5.3 |
| 4 | Mandatory `projectId`, `engagementId`, entity version, capability projection in every list/detail/write; bind cursors to scope | §4 |
| 5 | Remove generic project-scoped money wrappers; keep only derived roll-up; clear migration response for deprecated routes | §3.5, §7 |
| 6 | Backfill report; quarantine records with missing/conflicting ancestry; never expose/mutate via engagement routes | §3.6 |
| 7 | Idempotency retention for the durable offline retry period OR deterministic client draft id; add replay, delayed-replay, fingerprint-conflict tests | §5.1, §8 |
| 8 | Name the exact money wire form; add native decoder compatibility tests; never emit JSON number for money | §4.1 |
| 9 | Invoice draft and issue server-denied until SOL-25 publishes the approved snapshot fields and tests; allow only reads + guarded collection metadata | §3.4 |
| 10 | Payment denial permanent for this release; test no-op on receivable/retensi/PPN | §3.5, §8 |
| 11 | Tests: two engagements, stale responses after switch, cross-studio/cross-engagement ids, capability denial, entity conflict, atomic VO replay, rollback after writes, retensi release without second PPN | §8 |

Open-question answers (from the reviewer): no project-scoped quotation,
variation-order, invoice, or collection wrappers; invoice draft/issue fully
gated until SOL-25 and the reviewed contract; accept only an `ELIGIBLE`
project change whose project and engagement match the route.

## 1. The money wire form (condition 8) — per-schema, verified against the native decoder

Stdio uses the ratified money rule (ADR 0001, `packages/core/src/money.ts`):
every amount is integer minor units; the column is `numeric(20,2)`. The
**transport form is NOT one uniform shape**. The contract already declares two
forms, and the native consumers decode them differently. The server must emit
exactly what each schema declares; it must not force one form on all.

### 1.1 The two wire forms the contract already declares

| Form | Declared in contract | Native decoder | Native requirement |
| --- | --- | --- | --- |
| Canonical 2dp string `"186000.00"` | `VariationOrder.*`, `ScheduleOfValuesLine.*` (`type: [string,"null"]`, description "Canonical 2dp money string") | `VariationOrderDTO` money fields are `String?`; parsed with `Decimal(string:locale:)` | Accepts a string (not a number) |
| JSON number `186000` | `ProjectQuotation.*`, `ProjectFinanceInvoice.*`, `ProjectFinanceSummary.*`, `ProjectMilestone.amount` (`type: number`) | `QuotationDTO` / finance DTOs decode `Decimal?` via `decodeIfPresent(Decimal.self, ...)` | Accepts a number; a string is a hard `typeMismatch` |

**Empirical proof** (compiled and run on this host, Swift 6):

```swift
struct DTO: Decodable { let amount: Decimal? }
JSONDecoder().decode(DTO.self, from: Data(#"{"amount":186000}"#.utf8))  // OK
JSONDecoder().decode(DTO.self, from: Data(#"{"amount":"186000"}"#.utf8)) // throws typeMismatch: expected NSDecimal
```

So the canonical 2dp string **cannot** be served on `ProjectQuotation`,
`ProjectFinanceInvoice`, `ProjectFinanceSummary`, or `ProjectMilestone.amount`
without breaking the native `Decimal?` decoder. The README statement "the JSON
transport type is a string" is **aspirational and wrong** for those
projections; the contract schema is authoritative and declares `number`.

### 1.2 Rules for the server

- Each projection emits the form its schema declares, **unchanged**. No
  existing projection's money type is changed without native-decoder
  compatibility evidence (condition 8).
- `moneyWire()` emits a canonical 2dp string — used only for string-typed
  projections (`VariationOrder`, `ScheduleOfValuesLine`).
- A **number** projection emits the value as a JSON number derived from the
  `numeric(20,2)` column (integer minor units divided to major units) with no
  float on the path; the presentation `*Label` variant is a string.
- Write **inputs** (`MoneyInput`) accept string OR number, normalized to
  integer minor units via `parseMoneyInput` (already tested).
- A null money value (finance lens off) is `null` in either form.

### 1.3 Contract-compatibility conflict surfaced for the reviewer (condition 8)

The FE condition 8 says "never emit JSON number for money." That is **not
compatible** with the native `Decimal?` decoders in `QuotationDTO`,
`ProjectFinanceInvoice`/`InvoiceSummary`, `ProjectFinanceSummary`, and
`ProjectMilestone` — a string there is a hard `typeMismatch`. Two resolutions:

1. **Keep per-schema forms (recommended, zero native change).** The server
   emits number for the number-declared projections and string for the
   string-declared projections. The README's blanket "transport is a string"
   is corrected to "per-schema." No native decoder change; the contract schema
   is already correct.
2. **Unify all money to a canonical 2dp string (native decode change).** Requires
   changing the native `Decimal?` decoders to `String?` + `Decimal(string:)` and
   changing the contract's `type: number` fields to `type: [string,"null"]`.
   This is a breaking native change the Founding Engineer must own and schedule.

**Recommendation:** option 1. It matches the already-reviewed contract schema,
requires no native change, and is the lowest-risk path for SOL-6.

- Condition 8's "native decoder compatibility tests" are covered by the
  empirical matrix in §1.1 plus `apps/server/src/money.test.ts` (round-trips,
  cents, negatives, null) and the §8 decoder tests.

## 2. The route map — every SOL-27 resource to its engagement replacement

Placeholder: the exact redline diff is attached as a separate artifact. The
shape below is the contract the server implements.

### 2.1 Engagement-scoped money and scope (replaces project-scoped money routes)

```text
GET  /projects/{id}/engagements/{engId}/contracts              list contract summaries
GET  /projects/{id}/engagements/{engId}/contracts/{contractId} contract detail
GET  /projects/{id}/engagements/{engId}/quotations             list quotations
GET  /projects/{id}/engagements/{engId}/quotations/{quotationId}  quotation detail
POST /projects/{id}/engagements/{engId}/quotations             create draft quotation
POST /projects/{id}/engagements/{engId}/quotations/{quotationId}/fee
POST /projects/{id}/engagements/{engId}/quotations/{quotationId}/payment-schedule
POST /projects/{id}/engagements/{engId}/quotations/{quotationId}/send
POST /projects/{id}/engagements/{engId}/quotations/{quotationId}/acceptance
POST /projects/{id}/engagements/{engId}/quotations/{quotationId}/assign   guarded assignment (2.3)

GET  /projects/{id}/engagements/{engId}/variation-orders       list
GET  /projects/{id}/engagements/{engId}/variation-orders/{voId}  immutable detail
POST /projects/{id}/engagements/{engId}/project-changes/{changeId}/variation-order

GET  /projects/{id}/engagements/{engId}/invoices               list invoice summaries
GET  /projects/{id}/engagements/{engId}/invoices/{invoiceId}   invoice detail
POST /projects/{id}/engagements/{engId}/invoices/{invoiceId}/collection  collection metadata
POST /projects/{id}/engagements/{engId}/invoices/{invoiceId}/draft       server-denied (3.4)
POST /projects/{id}/engagements/{engId}/invoices/{invoiceId}/issue       server-denied (3.4)
```

### 2.2 Portfolio cross-project registers (unchanged shapes)

```text
GET /quotations                 listNativeQuotations
GET /quotations/{id}            getNativeQuotation
GET /invoices                   listNativeInvoices
GET /invoices/{id}              getNativeInvoice
```

These are cross-project entry points (SOL-27 §3). They return the existing
`QuotationSummary` / `InvoiceSummary` shapes with `projectId` and
`engagementId` populated and bound to the same pagination scope as §4.

### 2.3 Project-level read-only roll-up (the only project-scoped money read)

```text
GET /projects/{id}/finance      read-only derived roll-up across engagements
```

This is the ONLY project-scoped money read. It is **derived**, never a stored
blend, and never returns or mutates individual engagement records. It does not
accept a write. Every deprecated project-scoped money route
(`/projects/{id}/quotations`, `/projects/{id}/variation-orders`,
`/projects/{id}/projects/{...}/finance/invoices/{...}/issue`, …) returns a
`410 GONE` with a `deprecated` problem code and a `location` header pointing to
the engagement-scoped replacement (condition 5).

## 3. Object model and transitions

### 3.1 Engagement (the scope key)

`engagementId` is `NOT NULL` on every money/scope resource in the new routes.
The project is read from the engagement (`project_engagements.project_id`), so
the route `/projects/{id}/engagements/{engId}/...` verifies the engagement
belongs to `id`; a mismatch is `404 NOT_FOUND` (never a cross-engagement read).

### 3.2 Quotation — nullable engagement + guarded assignment (condition 2)

A quotation may exist before the engagement opens. The contract keeps
`engagementId` nullable on the quotation **resourc e** until assignment. The
server enforces the transition:

- **State A (unassigned):** `quotation.engagement_id IS NULL`. The quotation is
  visible in the portfolio registers only; it is not in any engagement's
  contract list until assigned.
- **Guarded assignment** (`POST .../quotations/{quotationId}/assign`): requires
  `If-Match` on the quotation `entity_version`, an `Idempotency-Key`, the
  capability `canWriteQuotation`, and verifies the target `engagementId`
  belongs to the same `projectId` **and** same `studioId` as the quotation.
  On success it sets `engagement_id` and bumps `entity_version`.
- The assignment is the only transition that sets `engagement_id`; no other
  write may do so.

### 3.3 Variation order — version targets (condition 3)

The approve-and-issue write (`POST .../project-changes/{changeId}/variation-order`)
is atomic and must **lock**:

- the `project_changes` row (the eligible change),
- the `project_engagements` row (the engagement roll-up),
- and compute the new `transaction_price` under `SERIALIZABLE` isolation.

Inputs: the `entity_version` of the eligible change (`If-Match`) and the
`entity_version` of the engagement roll-up (`If-Match`), the idempotency key,
and `VariationOrderApprovalRequest`. The write accepts only a change whose
`status = 'ELIGIBLE'` AND whose `project_id` and `engagement_id` match the
route. A stale version is `409`. On success: change → `CONSUMED`, engagement
`transaction_price` recomputed, variation order `ISSUED`, all in one
transaction. Only an approved (issued) variation order changes the
`transaction_price`; the BOQ and contract-value effects feed reporting only.

### 3.4 Invoice draft and issue — server-denied (conditions 9)

`POST .../invoices/{invoiceId}/draft` and `.../issue` are **registered but
server-denied**: they return `403` with capability `canWriteInvoiceDraft` /
`canIssueInvoice` set to `{ enabled: false, reason }`. They are not enabled
until (a) SOL-25 publishes the approved tax snapshot fields and tests, and (b)
this reviewed contract is complete. Invoice **reads** and **collection
metadata** (status, note, owner, reminder date) are allowed; collection is
control metadata, not a money write.

### 3.5 Payment recording — permanent denial (conditions 5, 10)

`POST .../invoices/{invoiceId}/payment` is registered but permanently denied
for this release. `recordNativeProjectFinanceInvoicePayment` returns `403`
with capability `canRecordInvoicePayment = { enabled: false, reason }` naming
SOL-20 and A-010. It performs **no write**: no receivable, retensi, or PPN
state changes. Test §8 proves the no-op.

### 3.6 Legacy ancestry backfill (condition 6)

Before any legacy record is exposed through an engagement route, the server
verifies `project_id`, `studio_id`, and `engagement_id` ancestry (the
engagement's `project_id` and `studio_id` must match the record's). A record
with missing or conflicting ancestry is **quarantined**: it is not exposed or
mutable through engagement routes and is reported in a backfill report
(`docs/sol28-backfill.md`) listing record id, table, missing/conflicting field,
and disposition. The backfill report is produced before the engagement routes
serve those records; it is part of the deliverable.

## 4. Response envelope and scope binding (condition 4)

Every list, detail, and write response carries:

- `meta` (`apiVersion`, `compatibility`, `requestId`, `pagination` when a
  list).
- `data` carrying `projectId`, `engagementId`, `entityVersion`, and the full
  capability projection for the actor.
- List cursors are bound to the same `engagementId` scope: a cursor from one
  engagement cannot page into another.

### 4.1 Money fields

Each projection emits the wire form its schema declares (§1.2): a canonical
2dp string for `VariationOrder` / `ScheduleOfValuesLine`, a JSON number for
`ProjectQuotation` / `ProjectFinanceInvoice` / `InvoiceSummary` /
`ProjectFinanceSummary` / `ProjectMilestone.amount`. The `*Label` variants are
presentation strings. `canReadFinance` masks every money field to `null` when
the lens is off (D-007). No existing projection's money type changes without
native-decoder compatibility evidence (§1.2).

## 5. Guarded-write mechanics

### 5.1 Idempotency (condition 7)

- Scope `(studioId, Idempotency-Key)`. Fingerprint = SHA-256 of method +
  normalized path + content-type + exact body bytes.
- **Retention:** the record is retained for the durable offline retry period,
  **72 hours** (not 24). A matching retry after completion returns the original
  status/body/etag with no mutation. A delayed replay inside the window returns
  the original result. Same key + different fingerprint → `409
  IDEMPOTENCY_KEY_REUSED`.
- Offline draft creation: the client MUST send a deterministic draft identifier
  in the `Idempotency-Key` (or a `clientDraftId` field) so a replayed create
  does not mint a second draft. The server requires the key for every guarded
  create; a missing key is `400`.
- Storage: `packages/db/src/schema/idempotency.ts` (add a non-completed expiry
  index and a 72h retention note).

### 5.2 Conflict (If-Match / entity version)

Every guarded write requires `If-Match` with the resource `entity_version`. A
mismatch returns `409` and the current entity. The version guard is the
`entity_version` UUID column; the write reads the row `FOR UPDATE`, compares,
and aborts on mismatch.

### 5.3 Isolation (condition 3)

Money aggregation (variation-order issue, engagement roll-up recompute) runs in
`SERIALIZABLE` isolation so two concurrent mutation attempts cannot produce a
lost-update. A serialization conflict aborts one with `409`.

## 6. Server module layout

```
apps/server/src/
  app.ts                Hono app, route registration, request-id + auth
  capabilities.ts       projectCapabilities(role) -> CapabilitySet
  money.ts              moneyWire / maskMoney (canonical 2dp string)
  http.ts               problem + meta envelopes, pagination
  context/
    db.ts               withStudioTx (tenant transaction)
    token.ts            resolveToken (two-step RLS-aware)
  routes/
    contracts.ts        engagement-scoped contract reads
    quotations.ts       quotation reads + writes + assign
    variation-orders.ts VO reads + approve-and-issue
    invoices.ts         invoice reads + collection + denied draft/issue/payment
    finance.ts          project roll-up read + deprecated 410 shims
```

## 7. Deprecation shims (condition 5)

Every generic project-scoped money route returns `410 GONE` with problem code
`DEPRECATED_ROUTE` and a `Link` header to the engagement-scoped replacement.
Native clients (SOL-27) are updated to the engagement routes; the shim is the
migration response. No project-scoped money route accepts a write.

## 8. Test plan (conditions 7, 9, 10, 11)

`apps/server/src/**/*.test.ts` and `packages/db/src/rls.test.ts` cover:

1. **Cross-engagement isolation**: two engagements on one project; a request
   for engagement A never returns or mutates engagement B records; a cursor
   from A cannot page into B.
2. **Cross-studio isolation**: studio A cannot read or write studio B rows
   (RLS, already proven; repeated at the engagement route).
3. **Stale response after switch**: switching engagements invalidates prior
   cursors/ETags; a stale entity version is `409`.
4. **Capability denial**: non-finance role gets `canReadFinance` false and
   masked money; money writes disabled for every role until review/SOL-25.
5. **Entity conflict**: `If-Match` mismatch → `409` with current entity.
6. **Idempotent replay**: matching retry → original result, no mutation;
   delayed replay → original result; fingerprint conflict → `409
   IDEMPOTENCY_KEY_REUSED`.
7. **Atomic variation-order replay**: `SERIALIZABLE` contention aborts one with
   `409`; only an `ELIGIBLE` change with matching project/engagement is
   consumed; `transaction_price` changes only after issue.
8. **Rollback after writes**: a failed write rolls back all writes.
9. **Payment denial no-op**: `recordNativeProjectFinanceInvoicePayment` returns
   `403` and changes no receivable, retensi, or PPN state.
10. **Retensi release without a second PPN event**: releasing retensi never
    creates a second PPN entry.
11. **Money decoder compatibility**: per-schema form matches the contract
    (`string` for `VariationOrder`/`ScheduleOfValuesLine`, `number` for the
    quotation/finance/invoice/milestone projections); a canonical 2dp string
    round-trips; the native `Decimal?` decoder rejects a string (empirically
    proven in §1.1), so the server never emits a string on a number-typed
    projection; no float on any money path.

## 9. Migration path

1. Add the engagement anchor to the route registration. Keep the portfolio
   registers unchanged.
2. Produce the backfill report; quarantine records with bad ancestry.
3. Register the deprecated project-scoped money routes as `410` shims.
4. Add the 72h idempotency retention note (no schema change; the columns
   already exist).
5. Copy the reviewed contract into Stdio_Native through the normal
   two-repository flow only after this server change lands.

## 10. Rollback

None of these changes migrate data; the route shape and projection are code.
Rolling back restores project-scoped shims without a schema rollback. **The
payment denial is not reverted by a rollback** (condition 10): the denial is a
permanent release-level fact, and the capability function and tests keep it
disabled even if the routes revert. Historical audit rows are preserved.

## 11. Concurrency, consistency, and audit summary

- Money aggregation uses `SERIALIZABLE`.
- All writes require `Idempotency-Key` (72h) and `If-Match` (entity version).
- Invoice issue (when it ships) freezes tax, billing, and audit snapshots;
  historical rows are never edited in place.
- `transaction_price` is derived from the base contract value plus approved
  variation-order `fee_effect`; it is recomputed under the same transaction as
  the issue.

## 12. Open questions for the reviewer

1. Should the assignment transition be a separate endpoint, or a flag on the
   create request? I propose the separate endpoint so it is independently
   guarded and idempotent.
2. The money `*Label` variants carry presentation; confirm the `canReadFinance`
   lens masks the money value in its declared form (string or number), not the
   label, when off.
3. Quarantine disposition: reject on read, or return a `quarantined`
   capability so the client can render it? I propose a `quarantined` read
   capability so the client sees the record as unavailable but not absent.
