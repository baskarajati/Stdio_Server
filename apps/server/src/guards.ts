/**
 * Guarded-write machinery (SOL-28 revision 7).
 *
 * Every money write carries the SOL-28 guard contract:
 *
 * - `Idempotency-Key`: scope `(studioId, key)`, 72h retention. Fingerprint is
 *   SHA-256 of method + normalized path + content-type + exact body bytes. A
 *   matching retry replays the original status/body/etag with no mutation; a
 *   different fingerprint on the same key is `409 IDEMPOTENCY_KEY_REUSED`.
 * - `If-Match`: the row `entity_version` (a UUID, weak ETag). A mismatch is
 *   `409 ENTITY_VERSION_CONFLICT` with `details.currentEntityVersion` and
 *   `details.draftPreserved: true`. `If-Match` is NOT part of the
 *   fingerprint, so a first write with a stale version consumes the key: the
 *   `409 ENTITY_VERSION_CONFLICT` is stored as COMPLETED, and a same-key
 *   retry with a corrected `If-Match` replays the original 409. After a
 *   version conflict the client MUST use a new `Idempotency-Key` on the
 *   retry. The key stays bound to one request body.
 * - Capability projection: the server decides permission from the actor role;
 *   a disabled capability is `403` with the capability `reason`.
 *
 * Concurrency: the write transaction takes a session-scoped advisory lock
 * keyed by `(studioId, key)` FIRST, so two concurrent requests with the same
 * key serialize; the loser reads the committed winner and replays.
 *
 * Money replay exactness: the completed response body is stored as TEXT (see
 * `packages/db/src/schema/idempotency.ts`) and replayed verbatim, so the
 * large `numeric(20,2)` tokens never round-trip through a float.
 */

import { createHash } from 'node:crypto';
import { schema } from '@stdio/db';
import { and, eq, sql } from 'drizzle-orm';
import type { Context } from 'hono';
import type { Pool } from 'pg';

import type { Capability } from './capabilities';
import { type Db, type RequestUser, withStudioTx } from './context/db';
import { lockDocumentNumberSequence } from './document-numbers';
import { problem } from './http';
import { serializeJson } from './money';

const { idempotencyKeys } = schema;

const IDEMPOTENCY_KEY_MIN = 8;
const IDEMPOTENCY_KEY_MAX = 200;

/**
 * Computes the request fingerprint: SHA-256 over method + normalized path +
 * content-type + exact body bytes. Two requests with the same key must
 * produce the same fingerprint only when every byte matches.
 */
export function fingerprintFor(
  method: string,
  path: string,
  contentType: string | null,
  body: string,
): string {
  const normalizedPath = path.split('?')[0] ?? path;
  const hash = createHash('sha256');
  hash.update(method);
  hash.update('\n');
  hash.update(normalizedPath);
  hash.update('\n');
  hash.update(contentType ?? '');
  hash.update('\n');
  hash.update(body);
  return hash.digest('hex');
}

/**
 * The advisory-lock key for one `(studioId, Idempotency-Key)` pair. The full
 * SHA-256 digest does not fit a bigint, so the first 8 bytes become the key;
 * a collision only wastes a wait, never skips the fingerprint check.
 */
function lockKey(studioId: string, key: string): number {
  const hash = createHash('sha256');
  hash.update(studioId);
  hash.update(':');
  hash.update(key);
  const hex = hash.digest('hex').slice(0, 16);
  return Number(BigInt.asIntN(64, BigInt(`0x${hex}`)));
}

/** Reads the Idempotency-Key header, enforcing the contract length range. */
export function requireIdempotencyKey(c: Context): string | Response {
  const key = c.req.header('Idempotency-Key');
  if (!key) {
    return problem(c, {
      status: 400,
      code: 'MISSING_IDEMPOTENCY_KEY',
      title: 'Idempotency key required',
      detail: 'Every guarded write requires an Idempotency-Key header.',
      requestId: c.get('requestId'),
    });
  }
  if (key.length < IDEMPOTENCY_KEY_MIN || key.length > IDEMPOTENCY_KEY_MAX) {
    return problem(c, {
      status: 400,
      code: 'INVALID_IDEMPOTENCY_KEY',
      title: 'Invalid idempotency key',
      detail: `The Idempotency-Key must be ${IDEMPOTENCY_KEY_MIN}-${IDEMPOTENCY_KEY_MAX} characters.`,
      requestId: c.get('requestId'),
    });
  }
  return key;
}

/**
 * Parses an `If-Match` header. The variation-order write submits two versions
 * (the change and the engagement) as a comma-separated list of entity tags.
 * Returns the bare version strings, or null when the header is missing.
 */
export function parseIfMatch(header: string | undefined): string[] | null {
  if (!header || header.trim().length === 0) {
    return null;
  }
  return header
    .split(',')
    .map((part) =>
      part
        .trim()
        .replace(/^(W\/)?"/, '')
        .replace(/"$/, ''),
    )
    .filter((part) => part.length > 0);
}

/**
 * Writes the `409 ENTITY_VERSION_CONFLICT` problem the contract declares
 * (details carry `draftPreserved: true` and the current version to refetch).
 */
export function entityConflict(c: Context, currentEntityVersion: string | null): Response {
  return problem(c, {
    status: 409,
    code: 'ENTITY_VERSION_CONFLICT',
    title: 'Entity version conflict',
    detail: 'The If-Match entity version does not match the current entity. Refetch and retry.',
    requestId: c.get('requestId'),
    details: { draftPreserved: true, currentEntityVersion },
  });
}

/** Writes the `409 IDEMPOTENCY_KEY_REUSED` problem the contract declares. */
export function idempotencyReused(c: Context): Response {
  return problem(c, {
    status: 409,
    code: 'IDEMPOTENCY_KEY_REUSED',
    title: 'Idempotency key reused',
    detail:
      'This Idempotency-Key was used for a different request. A key is bound to one request body.',
    requestId: c.get('requestId'),
  });
}

/** Writes a `403` from a disabled capability; the client renders `reason`. */
export function capabilityDenied(c: Context, capability: Capability): Response {
  return problem(c, {
    status: 403,
    code: 'CAPABILITY_DENIED',
    title: 'Capability disabled',
    detail: capability.reason,
    requestId: c.get('requestId'),
  });
}

/**
 * The title/detail defaults for handler-level error codes (SOL-146). A
 * handler that returns a bare `{code, ...}` body keeps its own `detail` when
 * present; these defaults cover the codes the guarded-write routes emit.
 */
const HANDLER_PROBLEM_SPECS: Record<string, { title: string; detail: string }> = {
  ENGAGEMENT_NOT_FOUND: {
    title: 'Engagement not found',
    detail: 'The engagement does not exist on this project.',
  },
  PROJECT_CHANGE_NOT_FOUND: {
    title: 'Project change not found',
    detail: 'The project change does not exist on this engagement.',
  },
  PROJECT_CHANGE_NOT_ELIGIBLE: {
    title: 'Project change not eligible',
    detail: 'Only ELIGIBLE changes can be approved and issued.',
  },
  QUOTATION_NOT_FOUND: {
    title: 'Quotation not found',
    detail: 'The quotation does not exist on this engagement.',
  },
  USER_NOT_FOUND: {
    title: 'User not found',
    detail: 'The user does not exist in this studio.',
  },
  CLIENT_NOT_FOUND: {
    title: 'Client not found',
    detail: 'The client does not exist in this studio.',
  },
  VENDOR_NOT_FOUND: {
    title: 'Vendor not found',
    detail: 'The vendor does not exist in this studio.',
  },
  PROJECT_NOT_FOUND: {
    title: 'Project not found',
    detail: 'The project does not exist in this studio.',
  },
  SPEC_ITEM_NOT_FOUND: {
    title: 'Spec item not found',
    detail: 'The spec item does not exist in this studio.',
  },
  TIMESHEET_ENTRY_NOT_FOUND: {
    title: 'Timesheet entry not found',
    detail: 'The timesheet entry does not exist in this studio.',
  },
  INVALID_CLIENT: {
    title: 'Invalid client',
    detail: 'The client reference is invalid.',
  },
  WRITE_FAILED: {
    title: 'Write failed',
    detail: 'The write did not complete; the server could not apply the change.',
  },
  ENTITY_VERSION_CONFLICT: {
    title: 'Entity version conflict',
    detail: 'The If-Match entity version does not match the current entity. Refetch and retry.',
  },
};

/**
 * Wraps a handler-level error result into the contract `Problem` envelope
 * (SOL-146). The guard helpers (`entityConflict`, `idempotencyReused`,
 * `capabilityDenied`) already emit the full envelope; a handler that returns
 * a bare `{code, detail?, ...}` body on a non-2xx status used to be emitted
 * verbatim. This wraps it so every non-2xx guarded-write body carries
 * type/title/status/detail/code/requestId, with the remaining fields under
 * `details`. A body that is already a full Problem passes through unchanged;
 * success bodies (status < 400) pass through unchanged.
 */
export function handlerProblem(requestId: string, status: number, body: unknown): unknown {
  if (status < 400) {
    return body;
  }
  if (typeof body !== 'object' || body === null) {
    return body;
  }
  const record = body as Record<string, unknown>;
  if (
    record.type === 'urn:stdio:error' &&
    typeof record.code === 'string' &&
    typeof record.requestId === 'string'
  ) {
    return body;
  }
  const code = typeof record.code === 'string' ? record.code : 'INTERNAL_ERROR';
  const spec = HANDLER_PROBLEM_SPECS[code];
  const details: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (
      key === 'code' ||
      key === 'detail' ||
      key === 'status' ||
      key === 'requestId' ||
      key === 'title' ||
      key === 'type'
    ) {
      continue;
    }
    details[key] = value;
  }
  if (code === 'ENTITY_VERSION_CONFLICT') {
    // The contract's EntityVersionConflictProblem requires both fields.
    details.draftPreserved = true;
    if (!('currentEntityVersion' in details)) {
      details.currentEntityVersion = null;
    }
  }
  return {
    type: 'urn:stdio:error',
    title: spec?.title ?? 'Request failed',
    status,
    detail:
      typeof record.detail === 'string'
        ? record.detail
        : (spec?.detail ?? 'The request could not be completed.'),
    code,
    requestId,
    ...(Object.keys(details).length > 0 ? { details } : {}),
  };
}

/**
 * Verifies an engagement belongs to the route's project inside this studio.
 * RLS already scopes the row to the studio; the application check binds the
 * engagement to the route project so a cross-engagement id is a 404, never a
 * cross-engagement read.
 */
export async function resolveEngagement(
  scoped: Db,
  projectId: string,
  engagementId: string,
): Promise<{ id: string; projectId: string; entityVersion: string } | null> {
  const rows = await scoped.db
    .select({
      id: schema.projectEngagements.id,
      projectId: schema.projectEngagements.projectId,
      entityVersion: schema.projectEngagements.entityVersion,
    })
    .from(schema.projectEngagements)
    .where(
      and(
        eq(schema.projectEngagements.id, engagementId),
        eq(schema.projectEngagements.projectId, projectId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export type GuardedWriteResult =
  | {
      outcome: 'completed';
      status: number;
      etag: string | null;
      /** The exact response body bytes, ready to emit verbatim. */
      bodyText: string;
      replay: boolean;
    }
  | { outcome: 'conflict'; status: number; code: string };

export type GuardedWriteHandler = (scoped: Db) => Promise<{
  status: number;
  etag?: string | null;
  body: unknown;
}>;

/**
 * Runs one guarded write under the idempotency contract.
 *
 * One tenant transaction wraps the advisory lock, the row check, the handler,
 * and the completed-row insert. A handler throw rolls back the transaction —
 * including the idempotency row — so a failed write never blocks a correct
 * retry. The completed body is stored as TEXT and returned verbatim, so a
 * replay emits the original bytes (money tokens included) exactly.
 */
export async function guardedWrite(
  pool: Pool,
  user: RequestUser,
  key: string,
  fingerprint: string,
  handler: GuardedWriteHandler,
  options: {
    /** The request id for the Problem envelope on handler-level errors (SOL-146). */
    requestId: string;
    isolation?: 'SERIALIZABLE';
    /** The request method stored on the idempotency row (default POST). */
    method?: string;
    /** The request path stored on the idempotency row (default '/'). */
    path?: string;
    /**
     * SOL-25 revision 24: NativeWriteMeta.idempotentReplay must be true on a
     * replay and false on the first execution. The completed body is stored
     * with `false`; a replay flips that exact token to `true` in the TEXT —
     * money tokens are untouched, so replay stays byte-exact.
     */
    flipReplayIdempotent?: boolean;
    /**
     * The status a replay returns (contract: "200 — Idempotent replay
     * returned the original ..."). Defaults to the stored original status,
     * which the contract reserves for the first execution (201).
     */
    replayStatus?: number;
    /**
     * SOL-137 C1: a document-type namespace (`VO`, later `INV`, `QUO`). When
     * set, the write locks the document counter FIRST — before any query,
     * and therefore before the SERIALIZABLE snapshot — so concurrent
     * numbered writes serialize end to end. The handler then allocates the
     * number via `nextDocumentNumber`.
     */
    numberingNamespace?: string;
    /**
     * SOL-137 C1: max attempts for the write transaction. A concurrent mint
     * can abort once with 40001 at the counter upsert even behind the
     * numbering lock; the retry re-runs from a fresh snapshot and commits.
     * Defaults to 1 (no retry) for every other guarded write.
     */
    retrySerialization?: number;
  },
): Promise<GuardedWriteResult> {
  return withStudioTx(
    pool,
    user,
    async (scoped) => {
      // SOL-137 C1: serialize numbered writes BEFORE the snapshot is
      // fixed by the first read, so a concurrent numbered write sees the
      // previous writer's committed counter and roll-up.
      if (options.numberingNamespace) {
        await lockDocumentNumberSequence(scoped);
      }
      await scoped.db.execute(
        sql`SELECT pg_advisory_xact_lock(${lockKey(scoped.studioId, key)}::bigint)`,
      );

      const prior = await scoped.db
        .select()
        .from(idempotencyKeys)
        .where(and(eq(idempotencyKeys.studioId, scoped.studioId), eq(idempotencyKeys.key, key)))
        .limit(1);

      const existing = prior[0];
      if (existing) {
        if (existing.fingerprint !== fingerprint) {
          return { outcome: 'conflict', status: 409, code: 'IDEMPOTENCY_KEY_REUSED' };
        }
        const bodyText = options.flipReplayIdempotent
          ? (existing.responseBody ?? 'null').replace(
              '"idempotentReplay":false',
              '"idempotentReplay":true',
            )
          : (existing.responseBody ?? 'null');
        return {
          outcome: 'completed',
          status: Number(options.replayStatus ?? existing.responseStatus ?? 200),
          etag: existing.responseEtag ?? null,
          bodyText,
          replay: true,
        };
      }

      const result = await handler(scoped);
      // SOL-146: a handler-level error result is wrapped into the contract
      // Problem envelope before it is stored, so the stored row and any
      // replay carry the identical full envelope.
      const responseBody = handlerProblem(options.requestId, result.status, result.body);
      const bodyText = serializeJson(responseBody);
      await scoped.db.insert(idempotencyKeys).values({
        studioId: scoped.studioId,
        key,
        fingerprint,
        method: options.method ?? 'POST',
        path: options.path ?? '/',
        status: 'COMPLETED',
        responseStatus: String(result.status),
        responseBody: bodyText,
        responseEtag: result.etag ?? null,
        completedAt: new Date(),
      });

      return {
        outcome: 'completed',
        status: result.status,
        etag: result.etag ?? null,
        bodyText,
        replay: false,
      };
    },
    {
      ...(options.isolation ? { isolation: options.isolation } : {}),
      ...(options.retrySerialization ? { retrySerialization: options.retrySerialization } : {}),
    },
  );
}
