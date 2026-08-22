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
