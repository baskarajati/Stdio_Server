/**
 * Scratch-database lifecycle for integration suites.
 *
 * A suite that needs a real database creates its own database from the
 * `DATABASE_URL` admin credentials (`stdio` has CREATEDB), applies every
 * migration and the Studio Contoh seed, runs, and drops the database again.
 * Each run owns a uniquely named database, so two concurrent `pnpm verify`
 * runs cannot interfere (SOL-183). This is the same isolation pattern the
 * RLS and tax suites already use.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { seedDatabase } from '../seed';
import { applyMigrations } from './migrations';

export type ScratchDatabase = {
  /** The database name, unique per call. */
  name: string;
  /** Connection string for the scratch database itself. */
  url: string;
  /** Admin connection string used to create and drop the database. */
  adminUrl: string;
};

/**
 * Creates a uniquely named scratch database, applies every migration and
 * the Studio Contoh seed, and returns the handle.
 */
export async function createScratchDatabase(
  prefix: string,
  adminUrl: string,
): Promise<ScratchDatabase> {
  const name = `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  if (!/^[a-z0-9_]+$/.test(name)) {
    throw new Error(`Unsafe scratch database name: ${name}`);
  }
  const url = adminUrl.replace(/\/[^/]+$/, `/${name}`);

  const creator = new pg.Client({ connectionString: adminUrl });
  await creator.connect();
  try {
    await creator.query(`CREATE DATABASE ${name}`);
  } finally {
    await creator.end();
  }

  await applyMigrations(url);
  await seedDatabase(url);
  return { name, url, adminUrl };
}

/**
 * Drops the scratch database. Terminates its remaining backends first:
 * `stdio` is not a superuser, so `DROP DATABASE ... WITH (FORCE)` is not
 * available, and a role may always signal its own sessions.
 */
export async function dropScratchDatabase(db: ScratchDatabase): Promise<void> {
  const cleaner = new pg.Client({ connectionString: db.adminUrl });
  await cleaner.connect();
  try {
    await cleaner.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [db.name],
    );
    await cleaner.query(`DROP DATABASE IF EXISTS ${db.name}`);
  } finally {
    await cleaner.end();
  }
}
