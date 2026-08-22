/**
 * Bearer-token resolution.
 *
 * The contract's security scheme `NativeAccessToken` is an opaque token
 * (`naa_` prefix, short-lived). SOL-28 ships token verification only: resolve
 * the token to a studio and a staff user, and project capabilities from the
 * user's role. The PKCE issue flow (`/auth/token`) and revocation belong to a
 * later authentication issue on the roadmap.
 *
 * Resolution is two steps because of Row-Level Security:
 *
 * 1. Look up the token row. `access_tokens` carries the `auth_token_lookup`
 *    policy (`USING true`) so a lookup can run before the tenant is known.
 *    The row yields `studio_id` and `user_id`.
 * 2. Set `app.studio_id` to that studio and switch to `studio_app`, then read
 *    the `users` row. Every other table only exposes rows through the
 *    `studio_isolation` policy, so the user read must happen inside the
 *    tenant-scoped transaction.
 *
 * The two steps are the only correct order: a JOIN first would be hidden by
 * RLS on `users`.
 */

import type { Pool } from 'pg';
import type { RequestUser, StudioRole } from './db';

const VALID_ROLES = new Set<StudioRole>(['OWNER', 'PM', 'DESIGNER', 'FINANCE', 'PROCUREMENT']);

export type TokenResolution =
  | { ok: true; user: RequestUser }
  | { ok: false; status: 401 | 403; reason: string };

function isValidRole(value: unknown): value is StudioRole {
  return typeof value === 'string' && VALID_ROLES.has(value as StudioRole);
}

/**
 * Resolves an opaque bearer token to a request user. Calls the query on the
 * admin connection but scopes the user read to the tenant. A revoked or
 * expired token is a 401. A user with an unrecognised role is a 403 (fail
 * closed, never fall through to read-only).
 */
export async function resolveToken(
  pool: Pool,
  rawToken: string | undefined,
): Promise<TokenResolution> {
  if (!rawToken) {
    return { ok: false, status: 401, reason: 'A bearer token is required.' };
  }
  const token = rawToken.trim();
  if (!token.startsWith('naa_')) {
    return { ok: false, status: 401, reason: 'The token format is not a native access token.' };
  }

  // Step 1: the token row, visible through the auth_token_lookup policy even
  // before the tenant is set.
  const tokenQuery = await pool.query(
    `SELECT user_id, studio_id, expires_at, revoked_at
     FROM access_tokens
     WHERE token = $1
       AND revoked_at IS NULL
       AND expires_at > now()`,
    [token],
  );
  const tokenRow = tokenQuery.rows[0] as { user_id: string; studio_id: string } | undefined;
  if (!tokenRow) {
    return { ok: false, status: 401, reason: 'The access token is unknown, revoked, or expired.' };
  }

  // Step 2: read the user inside the tenant scope. `users` only exposes rows
  // through the studio_isolation policy, so the tenant setting must be set.
  // The connection is released with reset so the `SET LOCAL ROLE` session
  // state cannot leak into the next pooled query (a leaked `studio_app`
  // connection later produces `22P02` on a parameterized query).
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', ['app.studio_id', tokenRow.studio_id]);
    await client.query('SET LOCAL ROLE studio_app');
    const userQuery = await client.query(
      `SELECT id, studio_id, email, name, role
       FROM users
       WHERE id = $1 AND studio_id = $2`,
      [tokenRow.user_id, tokenRow.studio_id],
    );
    await client.query('COMMIT');

    const userRow = userQuery.rows[0] as
      | { id: string; studio_id: string; email: string; name: string; role: string }
      | undefined;
    if (!userRow) {
      return { ok: false, status: 403, reason: 'The access token refers to an unknown user.' };
    }
    if (!isValidRole(userRow.role)) {
      return { ok: false, status: 403, reason: 'The user role is not a known staff role.' };
    }
    return {
      ok: true,
      user: {
        id: userRow.id,
        studioId: userRow.studio_id,
        email: userRow.email,
        name: userRow.name,
        role: userRow.role,
      },
    };
  } finally {
    // Force reset so the RLS role/setting state is discarded before the
    // connection returns to the shared pool.
    client.release(true);
  }
}
