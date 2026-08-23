/**
 * Per-studio document numbering (SOL-131; SOL-137 conditions C1, C2, C5, C6).
 *
 * Allocation happens inside the guarded write transaction. C1: the caller
 * locks the counter as the FIRST statement of the transaction — before the
 * SERIALIZABLE snapshot — so concurrent numbered writes serialize and the
 * second writer sees the first writer's committed counter and D-033 roll-up.
 * C2: the counter is an integer row in `studio_number_sequences`; formatting
 * to `VO-%04d` is presentation only. C5: each document type (VO, later INV,
 * QUO) has its own namespace row and never shares sequence. C6: the
 * increment rolls back with the transaction, so a rejected write consumes
 * no number; numbers are never reused.
 */

import { sql } from 'drizzle-orm';

import type { Db } from './context/db';

/**
 * Serializes every numbered write for one `(studioId, namespace)` pair.
 *
 * Runs as the FIRST statement of the transaction, before the SERIALIZABLE
 * snapshot, so a concurrent numbered write waits here and then reads the
 * previous writer's committed counter. `LOCK TABLE` is a utility statement
 * and takes NO snapshot — this is deliberate. `SELECT
 * pg_advisory_xact_lock(...)` and a `DO`-block variant both establish the
 * transaction snapshot at their statement start, BEFORE the lock wait, so
 * the waiter would keep a stale snapshot and abort with 40001 at the counter
 * upsert. With the table lock, the snapshot is fixed afterwards, at the
 * first read, and sees the winner's committed state.
 *
 * The lock is table-wide (all studios, all namespaces): fine at pilot scale,
 * where a numbered document write is a rare event. If contention ever
 * matters, replace with a per-tenant lock primitive that still precedes the
 * snapshot.
 */
export async function lockDocumentNumberSequence(scoped: Db): Promise<void> {
  await scoped.db.execute(sql`LOCK TABLE studio_number_sequences IN EXCLUSIVE MODE`);
}

/**
 * Hands out the next display number for `namespace`, e.g. `VO-0001`.
 *
 * The ON CONFLICT upsert increments the per-(studio, namespace) counter
 * atomically; under the sequence lock the row never contends, so no
 * serialization failure can fire. A rolled-back transaction undoes the
 * increment with everything else (gapless on abort, C6). Formatting pads to
 * four digits and expands past 9999 (`VO-10000`).
 */
export async function nextDocumentNumber(scoped: Db, namespace: string): Promise<string> {
  const result = await scoped.db.execute<{ used_number: number }>(
    sql`INSERT INTO studio_number_sequences (studio_id, namespace, next_value)
        VALUES (${scoped.studioId}, ${namespace}, 2)
        ON CONFLICT (studio_id, namespace)
        DO UPDATE SET next_value = studio_number_sequences.next_value + 1,
                      updated_at = now()
        RETURNING next_value - 1 AS used_number`,
  );
  const used = result.rows[0]?.used_number ?? 1;
  return `${namespace}-${String(used).padStart(4, '0')}`;
}
