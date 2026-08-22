/**
 * Timesheet routes (SOL-19 revision 6, surface G1).
 *
 * Five operations on `timesheet_entries`, tenant-scoped by RLS:
 *
 * - `GET /timesheet-entries` — list (filters `projectId`, `userId`, `from`,
 *   `to`, `q`; paginated). VOID entries are excluded from the register.
 * - `POST /timesheet-entries` — create (Idempotency-Key). The server
 *   snapshots the person's `users.labour_rate` into
 *   `effective_hourly_rate` for the budget report; the rate is never on the
 *   wire resource (D-007, FE item 7).
 * - `GET /timesheet-entries/{id}` — one entry (VOID entries stay readable).
 * - `PATCH /timesheet-entries/{id}` — update (Idempotency-Key + If-Match).
 *   An APPROVED entry is immutable (contract: server returns 409
 *   ENTITY_VERSION_CONFLICT); VOID entries are not editable either.
 * - `DELETE /timesheet-entries/{id}` — soft void (Idempotency-Key +
 *   If-Match). The row stays, status becomes VOID.
 *
 * Every mutation returns the typed `MutationConflict` 409 union
 * (`EntityVersionConflictProblem` / `IdempotencyKeyReusedProblem`) and the
 * `MutationMeta` envelope with `idempotentReplay`.
 *
 * Relation resolution (SOL-69 condition 6b): `userId` and `projectId` are
 * resolved inside the authenticated studio within the write transaction.
 * RLS scopes the reads; a cross-studio identifier resolves to no row and the
 * write returns 422 without creating anything. Hours are validated against
 * the contract `TimesheetHours` pattern (0.00..24.00, two fractional
 * digits); `entryDate` is a plain `YYYY-MM-DD` calendar date.
 *
 * Capabilities (D-007): the server projects all four timesheet capabilities
 * for every staff role — the register is team-internal and the wire never
 * carries a rate, so there is no money lens to gate.
 */

import { schema } from '@stdio/db';
import { and, eq, gte, like, lte, ne, or, sql } from 'drizzle-orm';
import type { Hono } from 'hono';
import type { Pool } from 'pg';
import type { ServerEnv } from '../app';
import { type Db, withStudioTx } from '../context/db';
import {
  entityConflictBody,
  fingerprintFor,
  guardedWrite,
  parseIfMatch,
  requireIdempotencyKey,
} from '../guards';
import { etagFor, meta, mutationMeta, problem } from '../http';
import { jsonResponse } from '../money';
import { dateLabel, statusLabel } from '../projections';

const { timesheetEntries, users, projects } = schema;

const HOURS_PATTERN = /^(?:(?:[0-9]|1[0-9]|2[0-3])\.[0-9]{2}|24\.00)$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
/** The studio default timezone; the seed and the studio default use it. */
const STUDIO_TIMEZONE = 'Asia/Jakarta';

type TimesheetCapabilities = {
  create: { enabled: boolean; reason: string };
  edit: { enabled: boolean; reason: string };
  read: { enabled: boolean; reason: string };
  void: { enabled: boolean; reason: string };
};

function timesheetCapabilities(): TimesheetCapabilities {
  return {
    create: { enabled: true, reason: '' },
    edit: { enabled: true, reason: '' },
    read: { enabled: true, reason: '' },
    void: { enabled: true, reason: '' },
  };
}

/** The calendar date of a stored timestamp in the studio timezone. */
function dateOnly(value: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: STUDIO_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(value);
}

type EntryRow = {
  id: string;
  userId: string;
  projectId: string;
  entryDate: Date;
  hours: string;
  notes: string | null;
  status: string;
  entityVersion: string;
  userName: string;
  projectName: string;
};

/** Loads one entry with its user and project names, tenant-scoped. */
async function loadEntry(scoped: Db, id: string): Promise<EntryRow | null> {
  const rows = await scoped.db
    .select({
      id: timesheetEntries.id,
      userId: timesheetEntries.userId,
      projectId: timesheetEntries.projectId,
      entryDate: timesheetEntries.entryDate,
      hours: timesheetEntries.hours,
      notes: timesheetEntries.notes,
      status: timesheetEntries.status,
      entityVersion: timesheetEntries.entityVersion,
      userName: users.name,
      projectName: projects.name,
    })
    .from(timesheetEntries)
    .innerJoin(users, eq(users.id, timesheetEntries.userId))
    .innerJoin(projects, eq(projects.id, timesheetEntries.projectId))
    .where(eq(timesheetEntries.id, id))
    .limit(1);
  return rows[0] ?? null;
}

/** Projects one entry row into the contract `TimesheetEntry` wire shape. */
function projectEntry(
  entry: EntryRow,
  capabilities: TimesheetCapabilities,
): Record<string, unknown> {
  return {
    capabilities,
    entryDate: dateOnly(entry.entryDate),
    entryDateLabel: dateLabel(entry.entryDate),
    entityVersion: entry.entityVersion,
    hours: entry.hours,
    hoursLabel: `${entry.hours} jam`,
    id: entry.id,
    notes: entry.notes ?? null,
    projectId: entry.projectId,
    projectName: entry.projectName,
    status: entry.status,
    statusLabel: statusLabel(entry.status),
    user: { id: entry.userId, name: entry.userName },
    userId: entry.userId,
  };
}

/** Emits a guarded-write result (completed body text) or the mapped error. */
function writeResponseOrError(
  c: Parameters<typeof requireIdempotencyKey>[0],
  result: Awaited<ReturnType<typeof guardedWrite>>,
): Response {
  if (result.outcome === 'conflict') {
    if (result.code === 'IDEMPOTENCY_KEY_REUSED') {
      return problem(c, {
        status: 409,
        code: 'IDEMPOTENCY_KEY_REUSED',
        title: 'Idempotency key reused',
        detail:
          'This Idempotency-Key was used for a different request. A key is bound to one request body.',
        requestId: c.get('requestId'),
      });
    }
    return problem(c, {
      status: result.status,
      code: result.code,
      title: 'Write rejected',
      detail: 'The timesheet write was rejected by the server.',
      requestId: c.get('requestId'),
    });
  }
  return new Response(result.bodyText, {
    status: result.status,
    headers: {
      'content-type': 'application/json',
      ...(result.etag ? { ETag: etagFor(result.etag) } : {}),
    },
  });
}

/** Registers the timesheet routes on `app`. */
export function registerTimesheetRoutes(app: Hono<ServerEnv>, pool: Pool): void {
  // GET /timesheet-entries — the tenant register (VOID excluded).
  app.get('/timesheet-entries', async (c) => {
    const user = c.get('user');
    const projectId = c.req.query('projectId');
    const userId = c.req.query('userId');
    const from = c.req.query('from');
    const to = c.req.query('to');
    const q = c.req.query('q');
    const page = Math.max(1, Number.parseInt(c.req.query('page') ?? '1', 10) || 1);
    const pageSize = Math.min(
      100,
      Math.max(1, Number.parseInt(c.req.query('pageSize') ?? '10', 10) || 10),
    );

    const result = await withStudioTx(pool, user, async (scoped) => {
      const conditions = [ne(timesheetEntries.status, 'VOID')];
      if (projectId) {
        conditions.push(eq(timesheetEntries.projectId, projectId));
      }
      if (userId) {
        conditions.push(eq(timesheetEntries.userId, userId));
      }
      if (from && DATE_PATTERN.test(from)) {
        conditions.push(gte(timesheetEntries.entryDate, new Date(`${from}T00:00:00Z`)));
      }
      if (to && DATE_PATTERN.test(to)) {
        conditions.push(lte(timesheetEntries.entryDate, new Date(`${to}T23:59:59.999Z`)));
      }
      if (q) {
        conditions.push(
          or(like(timesheetEntries.notes, `%${q}%`), like(users.name, `%${q}%`)) as ReturnType<
            typeof eq
          >,
        );
      }

      const rows = await scoped.db
        .select({
          id: timesheetEntries.id,
          userId: timesheetEntries.userId,
          projectId: timesheetEntries.projectId,
          entryDate: timesheetEntries.entryDate,
          hours: timesheetEntries.hours,
          notes: timesheetEntries.notes,
          status: timesheetEntries.status,
          entityVersion: timesheetEntries.entityVersion,
          userName: users.name,
          projectName: projects.name,
        })
        .from(timesheetEntries)
        .innerJoin(users, eq(users.id, timesheetEntries.userId))
        .innerJoin(projects, eq(projects.id, timesheetEntries.projectId))
        .where(and(...conditions))
        .orderBy(sql`${timesheetEntries.entryDate} desc`, sql`${timesheetEntries.createdAt} desc`)
        .limit(pageSize)
        .offset((page - 1) * pageSize);

      const countRows = await scoped.db
        .select({ count: sql<number>`count(*)::int` })
        .from(timesheetEntries)
        .innerJoin(users, eq(users.id, timesheetEntries.userId))
        .where(and(...conditions));
      const totalItems = countRows[0]?.count ?? 0;

      const capabilities = timesheetCapabilities();
      return {
        data: {
          entries: rows.map((row) => projectEntry(row, capabilities)),
        },
        meta: meta(c.get('requestId'), {
          pagination: {
            page,
            pageSize,
            totalItems,
            totalPages: Math.max(1, Math.ceil(totalItems / pageSize)),
          },
        }),
      };
    });

    return jsonResponse(result);
  });

  // POST /timesheet-entries — create (Idempotency-Key).
  app.post('/timesheet-entries', async (c) => {
    const user = c.get('user');
    const key = requireIdempotencyKey(c);
    if (typeof key !== 'string') {
      return key;
    }

    const rawBody = await c.req.text();
    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return problem(c, {
        status: 400,
        code: 'INVALID_JSON',
        title: 'Invalid JSON body',
        detail: 'The request body is not valid JSON.',
        requestId: c.get('requestId'),
      });
    }
    const fingerprint = fingerprintFor(
      'POST',
      c.req.path,
      c.req.header('Content-Type') ?? null,
      rawBody,
    );

    const result = await guardedWrite(
      pool,
      user,
      key,
      fingerprint,
      async (scoped) => {
        const req = body as Record<string, unknown>;

        const hours = req.hours;
        if (typeof hours !== 'string' || !HOURS_PATTERN.test(hours)) {
          return {
            status: 422,
            body: {
              code: 'INVALID_HOURS',
              detail: 'hours must be a decimal string from 0.00 through 24.00 with two digits.',
            },
          };
        }
        const entryDate = req.entryDate;
        if (typeof entryDate !== 'string' || !DATE_PATTERN.test(entryDate)) {
          return {
            status: 422,
            body: {
              code: 'INVALID_ENTRY_DATE',
              detail: 'entryDate must be a plain calendar date in YYYY-MM-DD form.',
            },
          };
        }
        const userId = req.userId;
        if (typeof userId !== 'string') {
          return { status: 422, body: { code: 'INVALID_USER', detail: 'userId is required.' } };
        }
        const projectId = req.projectId;
        if (typeof projectId !== 'string') {
          return {
            status: 422,
            body: { code: 'INVALID_PROJECT', detail: 'projectId is required.' },
          };
        }

        // SOL-69 condition 6b: resolve every supplied relation inside this
        // studio within the write transaction. RLS scopes the reads; a
        // cross-studio id finds no row and no entry is created.
        const person = await scoped.db
          .select({ id: users.id, labourRate: users.labourRate })
          .from(users)
          .where(eq(users.id, userId))
          .limit(1);
        if (!person[0]) {
          return {
            status: 422,
            body: { code: 'USER_NOT_FOUND', detail: 'The user does not exist in this studio.' },
          };
        }
        const project = await scoped.db
          .select({ id: projects.id })
          .from(projects)
          .where(eq(projects.id, projectId))
          .limit(1);
        if (!project[0]) {
          return {
            status: 422,
            body: {
              code: 'PROJECT_NOT_FOUND',
              detail: 'The project does not exist in this studio.',
            },
          };
        }

        const inserted = await scoped.db
          .insert(timesheetEntries)
          .values({
            studioId: scoped.studioId,
            userId,
            projectId,
            entryDate: new Date(`${entryDate}T00:00:00Z`),
            hours,
            // The per-entry rate snapshot for the budget report only
            // (SOL-19 section 2.6). Never on the wire resource.
            effectiveHourlyRate: person[0].labourRate ?? null,
            notes: req.notes == null ? null : String(req.notes),
            status: 'LOGGED',
          })
          .returning({ id: timesheetEntries.id, entityVersion: timesheetEntries.entityVersion });
        const row = inserted[0];
        if (!row) {
          return { status: 500, body: { code: 'WRITE_FAILED', detail: 'No row returned.' } };
        }

        const entry = await loadEntry(scoped, row.id);
        if (!entry) {
          return { status: 500, body: { code: 'WRITE_FAILED', detail: 'Reload failed.' } };
        }
        return {
          status: 201,
          etag: row.entityVersion,
          body: {
            data: { entry: projectEntry(entry, timesheetCapabilities()) },
            meta: mutationMeta(c.get('requestId')),
          },
        };
      },
      {
        method: 'POST',
        path: c.req.path,
        flipReplayIdempotent: true,
        replayStatus: 200,
      },
    );

    return writeResponseOrError(c, result);
  });

  // GET /timesheet-entries/{id} — one entry (VOID entries stay readable).
  app.get('/timesheet-entries/:id', async (c) => {
    const user = c.get('user');
    const id = c.req.param('id');
    const result = await withStudioTx(pool, user, async (scoped) => {
      const entry = await loadEntry(scoped, id);
      if (!entry) {
        return { status: 404 };
      }
      return {
        status: 200,
        data: {
          data: { entry: projectEntry(entry, timesheetCapabilities()) },
          meta: meta(c.get('requestId')),
        },
      };
    });

    if (result.status === 404) {
      return problem(c, {
        status: 404,
        code: 'TIMESHEET_ENTRY_NOT_FOUND',
        title: 'Timesheet entry not found',
        detail: 'The timesheet entry does not exist in this studio.',
        requestId: c.get('requestId'),
      });
    }
    return jsonResponse(result.data);
  });

  // PATCH /timesheet-entries/{id} — update (Idempotency-Key + If-Match).
  app.patch('/timesheet-entries/:id', async (c) => {
    const user = c.get('user');
    const id = c.req.param('id');
    const key = requireIdempotencyKey(c);
    if (typeof key !== 'string') {
      return key;
    }

    const ifMatch = parseIfMatch(c.req.header('If-Match'));
    if (!ifMatch || ifMatch.length < 1) {
      return problem(c, {
        status: 400,
        code: 'MISSING_IF_MATCH',
        title: 'Entity version required',
        detail: 'The timesheet update requires If-Match with the current entity version.',
        requestId: c.get('requestId'),
      });
    }
    const version = ifMatch[0];

    const rawBody = await c.req.text();
    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return problem(c, {
        status: 400,
        code: 'INVALID_JSON',
        title: 'Invalid JSON body',
        detail: 'The request body is not valid JSON.',
        requestId: c.get('requestId'),
      });
    }
    const fingerprint = fingerprintFor(
      'PATCH',
      c.req.path,
      c.req.header('Content-Type') ?? null,
      rawBody,
    );

    const result = await guardedWrite(
      pool,
      user,
      key,
      fingerprint,
      async (scoped) => {
        const req = body as Record<string, unknown>;

        const current = await scoped.db
          .select({
            id: timesheetEntries.id,
            status: timesheetEntries.status,
            entityVersion: timesheetEntries.entityVersion,
          })
          .from(timesheetEntries)
          .where(eq(timesheetEntries.id, id))
          .limit(1);
        const row = current[0];
        if (!row) {
          return { status: 404, body: { code: 'TIMESHEET_ENTRY_NOT_FOUND' } };
        }
        if (row.entityVersion !== version) {
          return {
            status: 409,
            body: entityConflictBody(c, row.entityVersion),
          };
        }
        // The contract: hours are never updated on an APPROVED entry (409
        // ENTITY_VERSION_CONFLICT). VOID entries are not editable either.
        if (row.status === 'APPROVED' || row.status === 'VOID') {
          return {
            status: 409,
            body: entityConflictBody(c, row.entityVersion),
          };
        }

        const hours = req.hours;
        if (hours !== undefined) {
          if (typeof hours !== 'string' || !HOURS_PATTERN.test(hours)) {
            return {
              status: 422,
              body: {
                code: 'INVALID_HOURS',
                detail: 'hours must be a decimal string from 0.00 through 24.00 with two digits.',
              },
            };
          }
        }
        const entryDate = req.entryDate;
        if (entryDate !== undefined) {
          if (typeof entryDate !== 'string' || !DATE_PATTERN.test(entryDate)) {
            return {
              status: 422,
              body: {
                code: 'INVALID_ENTRY_DATE',
                detail: 'entryDate must be a plain calendar date in YYYY-MM-DD form.',
              },
            };
          }
        }
        const projectId = req.projectId;
        if (projectId !== undefined) {
          if (typeof projectId !== 'string') {
            return {
              status: 422,
              body: { code: 'INVALID_PROJECT', detail: 'projectId must be a string.' },
            };
          }
          const project = await scoped.db
            .select({ id: projects.id })
            .from(projects)
            .where(eq(projects.id, projectId))
            .limit(1);
          if (!project[0]) {
            return {
              status: 422,
              body: {
                code: 'PROJECT_NOT_FOUND',
                detail: 'The project does not exist in this studio.',
              },
            };
          }
        }

        const updates: Record<string, unknown> = {
          entityVersion: sql`gen_random_uuid()`,
        };
        if (hours !== undefined) {
          updates.hours = hours;
        }
        if (entryDate !== undefined) {
          updates.entryDate = new Date(`${entryDate}T00:00:00Z`);
        }
        if (projectId !== undefined) {
          updates.projectId = projectId;
        }
        if (req.notes !== undefined) {
          updates.notes = req.notes == null ? null : String(req.notes);
        }

        await scoped.db.update(timesheetEntries).set(updates).where(eq(timesheetEntries.id, id));

        const entry = await loadEntry(scoped, id);
        if (!entry) {
          return { status: 500, body: { code: 'WRITE_FAILED', detail: 'Reload failed.' } };
        }
        return {
          status: 200,
          etag: entry.entityVersion,
          body: {
            data: { entry: projectEntry(entry, timesheetCapabilities()) },
            meta: mutationMeta(c.get('requestId')),
          },
        };
      },
      {
        method: 'PATCH',
        path: c.req.path,
        flipReplayIdempotent: true,
        replayStatus: 200,
      },
    );

    return writeResponseOrError(c, result);
  });

  // DELETE /timesheet-entries/{id} — soft void (Idempotency-Key + If-Match).
  app.delete('/timesheet-entries/:id', async (c) => {
    const user = c.get('user');
    const id = c.req.param('id');
    const key = requireIdempotencyKey(c);
    if (typeof key !== 'string') {
      return key;
    }

    const ifMatch = parseIfMatch(c.req.header('If-Match'));
    if (!ifMatch || ifMatch.length < 1) {
      return problem(c, {
        status: 400,
        code: 'MISSING_IF_MATCH',
        title: 'Entity version required',
        detail: 'The timesheet void requires If-Match with the current entity version.',
        requestId: c.get('requestId'),
      });
    }
    const version = ifMatch[0];

    const fingerprint = fingerprintFor(
      'DELETE',
      c.req.path,
      c.req.header('Content-Type') ?? null,
      '',
    );

    const result = await guardedWrite(
      pool,
      user,
      key,
      fingerprint,
      async (scoped) => {
        const current = await scoped.db
          .select({
            id: timesheetEntries.id,
            status: timesheetEntries.status,
            entityVersion: timesheetEntries.entityVersion,
          })
          .from(timesheetEntries)
          .where(eq(timesheetEntries.id, id))
          .limit(1);
        const row = current[0];
        if (!row) {
          return { status: 404, body: { code: 'TIMESHEET_ENTRY_NOT_FOUND' } };
        }
        if (row.entityVersion !== version) {
          return {
            status: 409,
            body: entityConflictBody(c, row.entityVersion),
          };
        }
        if (row.status !== 'VOID') {
          await scoped.db
            .update(timesheetEntries)
            .set({ status: 'VOID', entityVersion: sql`gen_random_uuid()` })
            .where(eq(timesheetEntries.id, id));
        }

        const entry = await loadEntry(scoped, id);
        if (!entry) {
          return { status: 500, body: { code: 'WRITE_FAILED', detail: 'Reload failed.' } };
        }
        return {
          status: 200,
          etag: entry.entityVersion,
          body: {
            data: { entry: projectEntry(entry, timesheetCapabilities()) },
            meta: mutationMeta(c.get('requestId')),
          },
        };
      },
      {
        method: 'DELETE',
        path: c.req.path,
        flipReplayIdempotent: true,
        replayStatus: 200,
      },
    );

    return writeResponseOrError(c, result);
  });
}
