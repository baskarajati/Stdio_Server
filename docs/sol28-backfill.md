# SOL-28 legacy ancestry backfill report

**Issue:** SOL-28. **Author:** Backend Engineer. **Date:** 2026-08-21.
**Review:** SOL-35 condition 6 — quarantine records with missing or conflicting
ancestry; never expose or mutate them through engagement routes.

## The ancestry rule

A money/scope record (`quotation`, `invoice`, `variation_order`,
`project_change`) is **exposable through an engagement route** only when its
`engagement_id` is present AND the engagement's `project_id` and `studio_id`
match the record's `project_id` and `studio_id`:

```sql
EXISTS (
  SELECT 1 FROM project_engagements pe
  WHERE pe.id = <record>.engagement_id
    AND pe.project_id = <record>.project_id
    AND pe.studio_id   = <record>.studio_id
)
```

A record that fails this is **unassigned** (`engagement_id IS NULL`) or
**conflicting** (the engagement exists but points at a different project or
studio). Both are quarantined: not exposed, not mutable, through engagement
routes.

## Scan of `stdio_dev` (2026-08-21, tenant `Studio Contoh`)

| Table | total | unassigned (eng NULL) | conflicting (eng present, mismatched) |
| --- | --- | --- | --- |
| `quotations` | 1 | 1 | 0 |
| `invoices` | 1 | 1 | 0 |
| `variation_orders` | 1 | 0 | 0 |
| `project_changes` | 1 | 0 | 0 |

## Findings

### Q-001 — `quotations.QUO-001` is unassigned

`quotations` row `00000000-0000-4000-8000-000000000006` has `project_id` set
but `engagement_id IS NULL`. It is a legacy draft quotation authored before the
engagement anchor existed.

**Disposition:** Quarantined from engagement routes. It remains visible in the
portfolio registers (`GET /quotations`, `GET /quotations/{id}`), which resolve
the project and engagement by reference. A guarded assignment transition
(`POST .../quotations/{quotationId}/assign`) is required before it appears in
an engagement contract list.

### Q-002 — `invoices.INV-001` is unassigned

`invoices` row `00000000-0000-4000-8000-000000000008` has `project_id` set and
`engagement_id IS NULL`. The seed source intends `engagement_id =
buildEngagement`, but the migrated row predates that column being populated
(the seed's `ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status` does not
update `engagement_id`).

**Disposition:** Quarantined from engagement routes. It remains readable (with
the legacy seed values) through the portfolio invoice register. It is **not**
draft/issue/payment writable in any case (SOL-28 §3.4/§3.5). Restoring
`engagement_id` requires a guarded assignment or a migration; no migration is
run in this issue.

### Clean records

`variation_orders.VO-001` and `project_changes.PC-001` have `engagement_id`
present and consistent ancestry — both belong to the build engagement. They are
exposable through their engagement routes.

## Quarantine behavior

- A quarantined record is **not returned** by engagement-scoped list/detail
  routes.
- A quarantined record is **not mutable** by engagement-scoped writes: the
  write resolves the engagement first, finds no matching record, and returns
  `404 NOT_FOUND`.
- The portfolio registers return the record with a `quarantined` read
  capability for the actor, so the client renders it as unavailable but not
  absent.
- The quarantine is a read/mutation gate only; the underlying rows are not
  deleted or rewritten.

## Follow-up (outside this issue)

- SOL-25 completes the invoice draft/issue snapshot fields; until then invoice
  writes are server-denied.
- The seed should be corrected so re-running it backfills `engagement_id` on
  `INV-001` (the source already intends it). This is a seed-only fix and is
  reported here rather than silently changed.
