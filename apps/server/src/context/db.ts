/**
 * The request-scoped database transaction.
 *
 * ADR 0002: every request runs on the tenant path.
 *
 *   BEGIN
 *   SELECT set_config('app.studio_id', $1, true)
 *   SET LOCAL ROLE studio_app
 *   ... the query ...
 *   COMMIT
 *
 * `set_config(..., true)` scopes the setting to the transaction; `SET LOCAL
 * ROLE` scopes the role switch to the transaction. Both vanish at COMMIT, so
 * one pooled connection can serve many studios without a leak. The RLS
 * policies from SOL-23 then enforce the boundary at the database: a request
 * that forgets the studio id sees zero rows, not every row.
 */

import { schema } from '@stdio/db';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';

export type StudioRole = 'OWNER' | 'PM' | 'DESIGNER' | 'FINANCE' | 'PROCUREMENT';

/** The authenticated request identity, resolved from the bearer token. */
export type RequestUser = {
  readonly id: string;
  readonly studioId: string;
  readonly email: string;
  readonly name: string;
  readonly role: StudioRole;
};

/** The transaction-scoped drizzle client over one pool connection. */
export type TransactionDb = NodePgDatabase<typeof schema>;

/** A database handle scoped to one studio and one transaction. */
export interface Db {
  readonly studioId: string;
  readonly user: RequestUser;
  /** The transaction-scoped drizzle client (casing snake_case, schema bound). */
  readonly db: TransactionDb;
}

/**
 * Runs `fn` inside one tenant-scoped transaction. `fn` receives the scoped
 * db. The transaction is COMMIT when `fn` resolves, ROLLBACK when it throws.
 * The connection is returned to the pool either way.
 *
 * `isolation: 'SERIALIZABLE'` (SOL-28 revision 7) escalates the transaction
 * before the first query. The variation-order write needs it: the approve and
 * issue atomically locks the change and the engagement roll-up, and the D-033
 * transaction-price recompute must not interleave with a concurrent write.
 */
export async function withStudioTx<T>(
  pool: Pool,
  user: RequestUser,
  fn: (scoped: Db) => Promise<T>,
  options: { isolation?: 'SERIALIZABLE' } = {},
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (options.isolation === 'SERIALIZABLE') {
      await client.query('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');
    }
    await client.query('SELECT set_config($1, $2, true)', ['app.studio_id', user.studioId]);
    await client.query('SET LOCAL ROLE studio_app');

    const txDb = drizzle(client, { schema, casing: 'snake_case' });
    try {
      const result = await fn({ studioId: user.studioId, user, db: txDb });
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  } finally {
    client.release();
  }
}
