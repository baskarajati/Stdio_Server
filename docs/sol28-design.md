# SOL-28 design — engagement-scoped contracts and guarded money writes

**Author:** Backend Engineer. **Date:** 2026-08-21.
**Status:** For review by the Founding Engineer (review gate).
**Parent issue:** SOL-28 (`5ab0e704-777b-464c-b017-461565ff7c5d`).

## 1. The problem

D-019 makes money and scope belong to the engagement. The contract
`contracts/openapi/native-v1.yaml` still serves quotations, variation orders,
finance, invoices, and payments through project-scoped routes
(`/projects/{id}/...`). SOL-6 cannot ship against that mismatch. The server
must change first.

Guard decisions (the source of truth for what this design may and may not do):

- **D-019** — money and scope belong to the engagement; the project rolls them
  up.
- **D-033 step 3** — only an approved variation order changes the transaction
  price. An unapproved variation order does not.
- **SOL-20 revision 1** — tax scope is launch/defer. `PPN_STANDARD_2025` is the
  only verified preset and it stays behind SOL-25. Custom tax is only an
  explicit unverified snapshot. Stdio never decides PKP eligibility,
  transaction classification, special DPP, PPnBM, PPh, input-credit, filing, or
  corrections.
- **A-010** — PPh timing on retained cash is left to an accountant. The current
  amount/date/method payment payload cannot represent cash, PPh, and retensi
  separately. No native payment write ships in this scope.
- **D-033** — contractual termin, retensi, uang muka, and rate snapshots are
  preserved on the billing chain.

## 2. Verified contract gaps

The listed schemas are from `contracts/openapi/native-v1.yaml`, read at the
version in this repository (byte-identical to the Stdio_Native vendored copy).

1. `ProjectFinanceInvoiceIssueRequest` has **one property**: `taxEvidence`.
   It carries no billing basis, due date, currency, tax rule snapshot,
   applicability confirmations, or immutable historical values. It cannot meet
   SOL-28 requirement 3.
2. `ProjectFinanceInvoicePaymentRequest` carries **only** `amount`, `date`,
   `paymentMethod`. It cannot represent cash, PPh, and retensi separately
   (A-010). It must be capability-disabled in this scope.
3. `ProjectFinanceSummary` money fields are **`number`** on the wire. ADR 0001
   and `packages/core/src/money.ts` require integer minor units carried as a
   string. `number` loses cents on an integer above 2^53 and is the exact
   failure the money rule forbids.
4. Every money route is **project-scoped** (`/projects/{id}/...`). The schemas
   carry `engagementId`, but the routes do not scope reads or writes by
   engagement. Cross-engagement isolation is not enforceable on the wire today.

## 3. The proposed design

### 3.1 Route shape — engagement becomes the scope key

All money-and-scope read and write routes move to an engagement anchor. The
project maintains a separate read-only money roll-up.

Reads and writes scoped by engagement:

```text
GET  /projects/{id}/engagements/{engagementId}/quotations          read quotations
POST /projects/{id}/engagements/{engagementId}/quotations          create draft quotation
POST /projects/{id}/engagements/{engagementId}/quotations/{quotationId}/fee
POST /projects/{id}/engagements/{engagementId}/quotations/{quotationId}/payment-schedule
POST /projects/{id}/engagements/{engagementId}/quotations/{quotationId}/send
POST /projects/{id}/engagements/{engagementId}/quotations/{quotationId}/acceptance

GET  /projects/{id}/engagements/{engagementId}/variation-orders    list
GET  /projects/{id}/engagements/{engagementId}/variation-orders/{variationOrderId}
POST /projects/{id}/engagements/{engagementId}/project-changes/{changeId}/variation-order
```

Project-level read-only roll-up:

```text
GET /projects/{id}/finance      read-only roll-up across engagements
GET /projects/{id}/contracts    read-only contract lineage across engagements
```

Invoice **reads** and **collection metadata** are engagement-scoped. Invoice
**draft and issue writes** follow the same engagement anchor and carry the full
billing/tax snapshot contract (requirement 3) — but their enforcement is gated
by the review outcome and by SOL-25.

### 3.2 Guarded write contract (all money writes)

Every guarded write carries:

- **`Idempotency-Key`** — scope `(studioId, key)` for 24 hours after
  completion. Fingerprint = SHA-256 of method + normalized path +
  content-type + exact body bytes. Same key + same fingerprint → replay of the
  original status/body/etag with no mutation. Same key + different fingerprint
  → `409 IDEMPOTENCY_KEY_REUSED`.
- **`If-Match`** — the entity's `entityVersion` (a UUID, serialized as a weak
  ETag). A mismatch returns `409` and the current entity, never a blind
  overwrite.
- **capability projection** — the server computes `Capability {enabled,
  reason}` from the actor's role and the entity state. The client never
  decides permission; the client renders the `reason` when disabled.

Storage: `packages/db/src/schema/idempotency.ts` already models the store.
The version guard is the row's `entity_version` UUID column; a guarded write
starts a transaction, reads the row `FOR UPDATE`, compares the submitted
version, and aborts on mismatch.

### 3.3 Variation-order priority

The variation order is a first-class, immutable object. `project_changes`
records the proposed change; `variation_orders` is the issued outcome.

Status flow: `PROPOSED -> ELIGIBLE -> (approveAndIssue) -> CONSUMED` on the
change, and `ISSUED` on the variation order. `REJECTED` never mints a
variation order. The write is **atomic**: it approves the eligible change and
mints the issued variation order in one transaction, then recomputes the
engagement `transaction_price` from the sum of the base contract value plus
the sum of approved `fee_effect` (the fee effect only, per D-033 step 3 — the
BOQ and contract-value effects feed reporting, not the price).

Only an approved variation order changes the transaction price. An unapproved
variation order is never reflected in the roll-up.

### 3.4 Invoice draft and issue — the snapshot contract

An invoice draft and issue write records, and an issued invoice freezes,
these values: engagement ancestry (`engagementId`, `projectId`), billing basis
(`MILESTONE | PROGRESS_CERTIFICATE | MANUAL`), due date, currency, tax rule
identity, effective date, applicability confirmations, rounding result, audit
actor, entity version, and idempotency key. Historical values are immutable
after issue.

The tax snapshot honors SOL-25's launch scope:

- `taxMode` is `NONE`, `CUSTOM_UNVERIFIED`, or `PPN_STANDARD_2025`.
- `PPN_STANDARD_2025` is **gated behind SOL-25**; it is not enabled by this
  issue.
- `CUSTOM_UNVERIFIED` stores the user's exact rational rate or fixed amount
  plus an unverified marker. Stdio never decides eligibility for it.

The granted scope for this issue is: **invoice draft and issue writes carry the
snapshot contract fields and are capability-projected**. Whether those writes
are enabled for a real studio is decided by the review outcome and by SOL-25's
completion, and is reported in the capability `reason`.

### 3.5 Payment writes — deferred

No native payment write ships in this scope. `recordNativeProjectFinanceInvoicePayment`
is present in the contract but its capability is projected `enabled: false`
with `reason` naming SOL-20 and A-010. The client shows the reason, never a
silent grey control (D-042). Collection metadata updates
(`updateNativeProjectFinanceInvoiceCollection`) carry control fields only —
`collectionStatus`, `collectionNote`, `collectionOwnerId`,
`collectionReminderDate` — and are separate from money writes.

### 3.6 Money on the wire

The response serialization uses the integer-minor-units-as-string rule from
ADR 0001 and `packages/core/src/money.ts`. `ProjectFinanceSummary` `number`
fields are replaced by the string form. The backend converts
`numeric(20,2)` to minor units with `packages/core/src/money-decimal.ts` and
serializes as a string; it never emits a float.

### 3.7 Tenant isolation

Every query runs inside a per-request transaction that:
`BEGIN`, `SELECT set_config('app.studio_id', $1, true)`,
`SET LOCAL ROLE studio_app`, then the query, then `COMMIT`. The RLS policies
from SOL-23 enforce the studio boundary at the database. The engagement scope
is enforced in the application by requiring `engagementId` to belong to the
same `projectId` and `studioId`. A cross-engagement reference is rejected by a
404 for the engagement, never a cross-studio read.

## 4. The alternative

**Keep project-scoped routes and thread `engagementId` as a query or body
parameter.** This is less code today. It is rejected because it leaves the
route shape misaligned with D-019, and a project-scoped write can silently
carry a foreign engagement id. The engagement anchor is the durable, costly
to reverse choice; the project-scoped filter is the cheap, easy to get wrong
choice. SOL-6 depends on real engagement isolation.

## 5. Migration path

1. Add the engagement scope to the route registration (new
   `apps/server` routes). Keep the existing project-scoped read routes as thin
   wrappers that delegate to the engagement implementation while SOL-6
   migrates. No persisted table moves.
2. Land money-as-string on the wire for the new engagement routes. The schema
   columns are already `numeric(20,2)`, so no data migration is required.
3. Flip `recordNativeProjectFinanceInvoicePayment` capability to disabled.
4. Copy the reviewed contract into Stdio_Native through the normal
   two-repository flow only after this server change lands.

## 6. Rollback

None of these changes migrate data. Reverting the route shape restores project
scoping without a schema rollback. The capability flags revert to enabled in
the projection function. The idempotency store and version guards are additive
columns and tables; dropping them is a simple migration.

## 7. Long-term effects

The engagement anchor is the durable identity for money. Any future
budget-versus-actual report, sync protocol, or offline cache keys on it. The
string-money wire rule is permanent and matches the Founding Engineer's
downstream consumer expectation. The idempotency and version-guard contract is
the standard every later write follows.

## 8. Open questions for the reviewer

1. Should the project-scoped routes be removed in this issue or kept as
   wrappers through the SOL-6 migration?
2. Is the invoice draft/issue write **enabled** in this issue (with a
   capability projection) or **gated entirely** until SOL-25 lands? The issue
   says "enforce the approved SOL-20 tax scope and reference SOL-25 contract
   fields", which argues for enabled-with-gating, not absent.
3. Should the variation-order write accept any project change, or only a change
   whose `status = ELIGIBLE` and whose `engagementId` matches the route? I
   propose the latter (strict).
