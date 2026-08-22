# ADR 0002 — The multi-tenant data model

- **Status:** Accepted
- **Date:** 2026-08-21
- **Issue:** SOL-23
- **Author:** The Backend Engineer

## The decision

The Stdio data model lives in `packages/db/src/schema/`. One SQL migration
per change lives in `packages/db/drizzle/`. Migration `0000` creates the
tables from the Drizzle schema. Migration `0001` is hand-written: it adds the
tenant boundary and the contract rules.

### Every table is tenant-scoped

Every table carries `studio_id NOT NULL`. Every table has
`ENABLE ROW LEVEL SECURITY` and `FORCE ROW LEVEL SECURITY`, plus one policy:

```sql
CREATE POLICY studio_isolation ON "<table>"
  USING ("studio_id" = current_setting('app.studio_id', true)::uuid)
  WITH CHECK ("studio_id" = current_setting('app.studio_id', true)::uuid);
```

The same policy covers reads, updates and inserts. `FORCE` applies the rule
to the table owner too. The application role is `studio_app`: `NOLOGIN` and
not a superuser. The server reaches it with `SET LOCAL ROLE studio_app`
inside the request transaction, after `set_config('app.studio_id', …, true)`.
Superusers bypass RLS by design; the migration role `stdio` stays below that
line. A forgotten tenant setting returns zero rows instead of every row:
the boundary fails closed.

`packages/db/src/rls.test.ts` proves the boundary on a scratch database built
from zero: studio A cannot see, update, delete or insert rows of studio B,
and a session without a tenant setting sees nothing.

### Money is `numeric(20,2)`, never a float

SOL-23 mandates `numeric(20,2)` for money columns. ADR 0001 names the wire
and arithmetic rule: integer minor units. Both hold at once: the database
stores `numeric(20,2)`, and `packages/core/src/money-decimal.ts` converts
exactly between the column form and integer minor units with BigInt only.
No float sits on that path. Quantities (`PurchaseOrderLineItem.quantity`)
travel as decimal strings in the contract, so they are `numeric(20,4)`, not
float either.

### The domain objects

| Object            | Tables                                                                                       |
| ----------------- | -------------------------------------------------------------------------------------------- |
| Studio (tenant)   | `studios`                                                                                    |
| Staff user        | `users`                                                                                      |
| Client            | `clients`                                                                                    |
| Project           | `projects`, `project_engagements`                                                            |
| Quote             | `quotations`, `quotation_items`, `quotation_payment_milestones`                              |
| Variation order   | `variation_orders`, `variation_order_approvals`                                              |
| Invoice           | `invoices`, `invoice_payments`, `invoice_receivable_components`                              |
| Purchase order    | `purchase_orders`, `purchase_order_items`, `vendors`, `goods_receipts`, `goods_receipt_lines`|
| Timesheet entry   | `timesheet_entries`                                                                          |

The variation order is a first-class object. It stores the before/after fee,
BOQ and contract-value snapshot and both effects, because that is where a
studio loses money. Budget-versus-actual stays a report, not a table.

The contract calls the tenant "company" (`MeResponse.data.company`). The
database names it `studios` after the mandate; the server maps between the
two names.

### Contract enums are CHECK constraints

`users.role`, `variation_orders.status`, `variation_order_approvals.decision`,
`quotation_items.line_type`, `purchase_orders.status`,
`purchase_order_items.receiving_state` and `goods_receipts.kind` are pinned
by CHECK constraints to the exact value sets of
`contracts/openapi/native-v1.yaml`. The contract wins every argument; an
invalid value is a database error, not a silent row.

### Numbers are unique inside one studio

`(studio_id, client_number)`, `(studio_id, project_code)`,
`(studio_id, quotation_number, version)`, `(studio_id, invoice_number)`,
`(studio_id, vendor_code)` and `(studio_id, purchase_order_number)` are
unique. A register shows one number per document.

### Derived money is not stored

`paid_amount` and `outstanding_amount` are not columns. The server derives
them from `invoice_payments` and `invoice_receivable_components`. Stored
derived numbers drift; sums of source rows do not.

## Reproducibility

One command chain takes a machine from zero to a seeded, tested database:

```bash
psql -h localhost -d postgres -f packages/db/scripts/bootstrap-dev.sql
pnpm db:migrate
pnpm db:seed
pnpm verify
```

The CI workflow runs the same chain against a `postgres:16-alpine` service.
The RLS test builds its own scratch database, applies every migration from
zero and drops the database afterwards. The suite needs no shared state.

## What this ADR does not decide

- Authentication, sessions and permissions (SOL-23 step 4 of the mandate).
- The idempotency store and the version-guard tables for the guarded writes.
- Timesheet rates and the budget-versus-actual report. SOL-19 owns the
  timesheet contract change (gap G1).
