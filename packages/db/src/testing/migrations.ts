import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const packageRoot = fileURLToPath(new URL('../..', import.meta.url));

/**
 * Applies every SQL migration in `drizzle/` to the database, in journal
 * order. A migration file is a list of statements separated by
 * `--> statement-breakpoint`, which is the format drizzle-kit writes.
 *
 * The tests use this on a scratch database they own, so the suite needs no
 * external migration runner.
 */
export async function applyMigrations(connectionString: string): Promise<void> {
  const drizzleDir = join(packageRoot, 'drizzle');
  const journal = JSON.parse(readFileSync(join(drizzleDir, 'meta', '_journal.json'), 'utf8')) as {
    entries: Array<{ tag: string }>;
  };
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    for (const entry of journal.entries) {
      const sql = readFileSync(join(drizzleDir, `${entry.tag}.sql`), 'utf8');
      for (const statement of sql.split('--> statement-breakpoint')) {
        const trimmed = statement.trim();
        if (trimmed.length > 0) {
          await client.query(trimmed);
        }
      }
    }
  } finally {
    await client.end();
  }
}

/** Names every migration file, for diagnostics. */
export function migrationTags(): string[] {
  return readdirSync(join(packageRoot, 'drizzle'))
    .filter((name) => name.endsWith('.sql'))
    .sort();
}

const BACKEND_DRAIN_POLL_MS = 300;
const BACKEND_DRAIN_TIMEOUT_MS = 15_000;
const DROP_RETRY_MS = 300;
const DROP_RETRY_TIMEOUT_MS = 5_000;

/**
 * Drops the scratch database that a test suite owns.
 *
 * A freshly migrated database attracts autovacuum workers, and a worker
 * reports `usename = NULL` and is owned by no role. A non-superuser can
 * never signal it, so `pg_terminate_backend` over `pg_stat_activity` for
 * the database errors with "permission denied to terminate process" and
 * the drop that follows never runs. That leaked scratch databases under
 * parallel `turbo run test` (SOL-165).
 *
 * The teardown therefore (1) terminates only `client backend` rows, which
 * a role may always signal for its own sessions, (2) waits, with a bounded
 * poll, until no backend remains attached to the database — autovacuum
 * workers finish their short `VACUUM ANALYZE` pass and leave on their
 * own, and (3) retries the drop briefly, because concurrent DDL on the
 * shared cluster can still collide.
 */
export async function dropScratchDatabase(adminUrl: string, testDb: string): Promise<void> {
  const cleaner = new pg.Client({ connectionString: adminUrl });
  await cleaner.connect();
  try {
    const drainDeadline = Date.now() + BACKEND_DRAIN_TIMEOUT_MS;
    for (;;) {
      await cleaner
        .query(
          `SELECT pg_terminate_backend(pid)
             FROM pg_stat_activity
            WHERE datname = $1
              AND pid <> pg_backend_pid()
              AND backend_type = 'client backend'`,
          [testDb],
        )
        .catch(() => {
          // A backend can vanish between the scan and the signal, and one
          // owned by another role stays un-signalable. Neither is fatal:
          // the poll below decides when the database is free.
        });
      const attached = await cleaner.query(
        `SELECT pid FROM pg_stat_activity
          WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [testDb],
      );
      if (attached.rowCount === 0) break;
      if (Date.now() > drainDeadline) {
        throw new Error(
          `scratch database ${testDb} still has ${attached.rowCount} attached backend(s) after ${BACKEND_DRAIN_TIMEOUT_MS}ms`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, BACKEND_DRAIN_POLL_MS));
    }
    const dropDeadline = Date.now() + DROP_RETRY_TIMEOUT_MS;
    for (;;) {
      try {
        await cleaner.query(`DROP DATABASE IF EXISTS ${testDb}`);
        return;
      } catch (err) {
        if (Date.now() > dropDeadline) throw err;
        await new Promise((resolve) => setTimeout(resolve, DROP_RETRY_MS));
      }
    }
  } finally {
    await cleaner.end();
  }
}
