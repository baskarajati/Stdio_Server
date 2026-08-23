/**
 * Timesheet entry routes (SOL-19 revision 6).
 *
 * Contract surface:
 *
 * - `GET /timesheet-entries` — tenant-scoped register (filters `q`,
 *   `projectId`, `userId`, `from`, `to`; `page` / `pageSize`).
 * - `POST /timesheet-entries` — guarded create (Idempotency-Key). The server
 *   snapshots `users.hourly_rate` into `effective_hourly_rate` at create time
 *   (proposal section 2.6); the client never sends or reads a rate (D-007).
 * - `GET /timesheet-entries/{id}` — detail.
 * - `PATCH /timesheet-entries/{id}` — guarded update (Idempotency-Key +
 *   If-Match). An APPROVED or VOID entry is locked: 409
 *   ENTITY_VERSION_CONFLICT with `details.draftPreserved: true`.
 * - `DELETE /timesheet-entries/{id}` — guarded soft void (Idempotency-Key +
 *   If-Match). Voiding an already-voided entry is a 200 no-op.
 *
 * Every supplied relation (`projectId`, `userId`) is resolved inside the
 * authenticated studio and one transaction (SOL-69 condition 3): a
 * cross-studio identifier returns a normal 404 and creates no row.
 *
 * `entryDate` is a plain calendar date (contract: the work day never shifts
 * across a timezone conversion). The server stores the date as the UTC
 * midnight instant and projects the UTC date back, so the wire date is
 * viewer-independent.
 */

import { schema } from '@stdio/db';
import { and, eq, gte, ilike, lt, sql } from 'drizzle-orm';
import type { Hono } from 'hono';
import type { Pool } from 'pg';

import type { ServerEnv } from '../app';
import { timesheetCapabilitiesFor } from '../capabilities';
import { type Db, withStudioTx } from '../context/db';
import { fingerprintFor, guardedWrite, parseIfMatch, requireIdempotencyKey } from '../guards';
import { etagFor, meta, problem, requestBuildOf } from '../http';
import { jsonResponse, moneyWire } from '../money';
import { dateLabel, statusLabel } from '../projections';

const { timesheetEntries, users, projects } = schema;

/** The contract `TimesheetHours` grammar: 0.00..24.00, exactly two digits. */
const HOURS_PATTERN = /^(?:(?:[0-9]|1[0-9]|2[0-3])\.[0-9]{2}|24\.00)$/;
/** The contract `format: date` grammar. */
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** UTC midnight of a calendar date string; the storage convention. */
function dateInstant(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

/** The calendar date of a stored instant, in UTC (viewer-independent). */
function dateOf(instant: Date): string {
  return instant.toISOString().slice(0, 10);
}

/** The presentation label for the hours, e.g. `7,50 jam`. */
function hoursLabel(hours: string | null | undefined): string | null {
  if (hours === null || hours === undefined) {
    return null;
  }
  const value = Number(hours);
  if (!Number.isFinite(value)) {
    return null;
  }
  const formatted = new Intl.NumberFormat('id-ID', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
  return `${formatted} jam`;
}

function isValidDate(date: string): boolean {
  if (!DATE_PATTERN.test(date)) {
    return false;
  }
  const instant = dateInstant(date);
  return !Number.isNaN(instant.getTime()) && dateOf(instant) === date;
}

type EntryRow = {
  id: string;
  userId: string;
  projectId: string;
  entryDate: Date;
  hours: string | null;
  notes: string | null;
  status: string;
  entityVersion: string;
  projectName?: string | null;
  userName?: string | null;
};

/** One `TimesheetEntry` wire object. No rate field ever appears (D-007). */
function projectEntry(
  row: EntryRow,
  role: Parameters<typeof timesheetCapabilitiesFor>[0],
): Record<string, unknown> {
  return {
    capabilities: timesheetCapabilitiesFor(role),
    entryDate: dateOf(row.entryDate),
    entryDateLabel: dateLabel(row.entryDate),
    entityVersion: row.entityVersion,
    hours: moneyWire(row.hours),
    hoursLabel: hoursLabel(row.hours),
    id: row.id,
    notes: row.notes,
    projectId: row.projectId,
    projectName: row.projectName ?? 'Unknown project',
    status: row.status,
    statusLabel: statusLabel(row.status) ?? row.status,
    user: { id: row.userId, name: row.userName ?? 'Unknown user' },
    userId: row.userId,
  };
}

/** Loads one entry with its project and user names, scoped to the studio. */
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
      projectName: projects.name,
      userName: users.name,
    })
    .from(timesheetEntries)
    .leftJoin(projects, and(eq(projects.id, timesheetEntries.projectId)))
    .leftJoin(users, and(eq(users.id, timesheetEntries.userId)))
    .where(eq(timesheetEntries.id, id))
    .limit(1);
  return rows[0] ?? null;
}

export function registerTimesheetRoutes(app: Hono<ServerEnv>, pool: Pool): void {
  // GET /timesheet-entries — the register.
  app.get('/timesheet-entries', async (c) => {
    const user = c.get('user');
    const q = c.req.query('q');
    const pageRaw = c.req.query('page');
    const pageSizeRaw = c.req.query('pageSize');
    const projectId = c.req.query('projectId');
    const userId = c.req.query('userId');
    const from = c.req.query('from');
    const to = c.req.query('to');
    const page = Math.max(1, Number(pageRaw) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(pageSizeRaw) || 10));
    const build = requestBuildOf(c);

    if (from !== undefined && !isValidDate(from)) {
      return problem(c, {
        status: 400,
        code: 'INVALID_DATE',
        title: 'Invalid from date',
        detail: 'The `from` filter must be a calendar date (YYYY-MM-DD).',
        requestId: c.get('requestId'),
      });
    }
    if (to !== undefined && !isValidDate(to)) {
      return problem(c, {
        status: 400,
        code: 'INVALID_DATE',
        title: 'Invalid to date',
        detail: 'The `to` filter must be a calendar date (YYYY-MM-DD).',
        requestId: c.get('requestId'),
      });
    }

    const result = await withStudioTx(pool, user, async (scoped) => {
      const conditions = [];
      if (q !== undefined && q.trim() !== '') {
        conditions.push(ilike(timesheetEntries.notes, `%${q.trim()}%`));
      }
      if (projectId !== undefined) {
        conditions.push(eq(timesheetEntries.projectId, projectId));
      }
      if (userId !== undefined) {
        conditions.push(eq(timesheetEntries.userId, userId));
      }
      if (from !== undefined) {
        conditions.push(gte(timesheetEntries.entryDate, dateInstant(from)));
      }
      if (to !== undefined) {
        conditions.push(
          lt(timesheetEntries.entryDate, new Date(dateInstant(to).getTime() + 86400000)),
        );
      }
      const filter = conditions.length > 0 ? and(...conditions) : sql`true`;

      const totalRows = await scoped.db
        .select({ value: sql<number>`count(*)::int` })
        .from(timesheetEntries)
        .where(filter);
      const totalItems = Number(totalRows[0]?.value ?? 0);
      const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));

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
          projectName: projects.name,
          userName: users.name,
        })
        .from(timesheetEntries)
        .leftJoin(projects, and(eq(projects.id, timesheetEntries.projectId)))
        .leftJoin(users, and(eq(users.id, timesheetEntries.userId)))
        .where(filter)
        .orderBy(sql`${timesheetEntries.entryDate} desc, ${timesheetEntries.updatedAt} desc`)
        .limit(pageSize)
        .offset((page - 1) * pageSize);

      return {
        entries: rows.map((row) => projectEntry(row, user.role)),
        pagination: { page, pageSize, totalItems, totalPages },
      };
    });

    return jsonResponse({
      data: { entries: result.entries },
      meta: meta(c.get('requestId'), { requestBuild: build, pagination: result.pagination }),
    });
  });

  // POST /timesheet-entries — guarded create.
  app.post('/timesheet-entries', async (c) => {
    const user = c.get('user');
    const capability = timesheetCapabilitiesFor(user.role).create;
    if (!capability.enabled) {
      return problem(c, {
        status: 403,
        code: 'CAPABILITY_DENIED',
        title: 'Capability disabled',
        detail: capability.reason,
        requestId: c.get('requestId'),
      });
    }
    const key = requireIdempotencyKey(c);
    if (typeof key !== 'string') {
      return key;
    }
    const rawBody = await c.req.text();
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      return problem(c, {
        status: 400,
        code: 'INVALID_JSON',
        title: 'Invalid JSON body',
        detail: 'The request body is not valid JSON.',
        requestId: c.get('requestId'),
      });
    }
    const entryDate = body.entryDate as string | undefined;
    const hours = body.hours as string | undefined;
    const projectId = body.projectId as string | undefined;
    const userId = body.userId as string | undefined;
    if (typeof entryDate !== 'string' || !isValidDate(entryDate)) {
      return problem(c, {
        status: 422,
        code: 'INVALID_ENTRY_DATE',
        title: 'Invalid entry date',
        detail: 'entryDate must be a calendar date (YYYY-MM-DD).',
        requestId: c.get('requestId'),
      });
    }
    if (typeof hours !== 'string' || !HOURS_PATTERN.test(hours)) {
      return problem(c, {
        status: 422,
        code: 'INVALID_HOURS',
        title: 'Invalid hours',
        detail:
          'hours must be a decimal string from 0.00 through 24.00 with two fractional digits.',
        requestId: c.get('requestId'),
      });
    }
    if (typeof projectId !== 'string') {
      return problem(c, {
        status: 422,
        code: 'INVALID_PROJECT',
        title: 'Invalid projectId',
        detail: 'projectId is required and must be a string.',
        requestId: c.get('requestId'),
      });
    }
    if (typeof userId !== 'string') {
      return problem(c, {
        status: 422,
        code: 'INVALID_USER',
        title: 'Invalid userId',
        detail: 'userId is required and must be a string.',
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
        // Tenant-scoped relation resolution (SOL-69 condition 3).
        const projectRows = await scoped.db
          .select({ id: projects.id })
          .from(projects)
          .where(eq(projects.id, projectId))
          .limit(1);
        if (!projectRows[0]) {
          return { status: 404, body: { code: 'PROJECT_NOT_FOUND' } };
        }
        const userRows = await scoped.db
          .select({ id: users.id, hourlyRate: users.hourlyRate })
          .from(users)
          .where(eq(users.id, userId))
          .limit(1);
        const person = userRows[0];
        if (!person) {
          return { status: 404, body: { code: 'USER_NOT_FOUND' } };
        }

        const inserted = await scoped.db
          .insert(timesheetEntries)
          .values({
            studioId: scoped.studioId,
            userId,
            projectId,
            entryDate: dateInstant(entryDate),
            hours,
            notes: body.notes === null ? null : ((body.notes as string | undefined) ?? null),
            status: 'LOGGED',
            // The labour-rate snapshot (proposal section 2.6): the person's
            // rate at create time, never sent by the client.
            effectiveHourlyRate: person.hourlyRate ?? null,
          })
          .returning({ id: timesheetEntries.id, entityVersion: timesheetEntries.entityVersion });
        const insertedRow = inserted[0];
        if (!insertedRow) {
          return { status: 500, body: { code: 'WRITE_FAILED' } };
        }
        const row = await loadEntry(scoped, insertedRow.id);
        if (!row) {
          return { status: 500, body: { code: 'WRITE_FAILED' } };
        }
        return {
          status: 201,
          etag: insertedRow.entityVersion,
          body: {
            data: { entry: projectEntry(row, user.role) },
            meta: { ...meta(c.get('requestId')), idempotentReplay: false },
          },
        };
      },
      {
        requestId: c.get('requestId'),
        method: 'POST',
        path: c.req.path,
        flipReplayIdempotent: true,
        replayStatus: 200,
      },
    );

    if (result.outcome === 'conflict') {
      return problem(c, {
        status: 409,
        code: 'IDEMPOTENCY_KEY_REUSED',
        title: 'Idempotency key reused',
        detail:
          'This Idempotency-Key was used for a different request. A key is bound to one request body.',
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
  });

  // GET /timesheet-entries/{id} — detail.
  app.get('/timesheet-entries/:id', async (c) => {
    const user = c.get('user');
    const id = c.req.param('id');
    const build = requestBuildOf(c);
    const result = await withStudioTx(pool, user, async (scoped) => {
      const row = await loadEntry(scoped, id);
      if (!row) {
        return { status: 404 as const };
      }
      return { status: 200 as const, row };
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
    return jsonResponse({
      data: { entry: projectEntry(result.row, user.role) },
      meta: meta(c.get('requestId'), { requestBuild: build }),
    });
  });

  // PATCH /timesheet-entries/{id} — guarded update.
  app.patch('/timesheet-entries/:id', async (c) => {
    const user = c.get('user');
    const id = c.req.param('id');
    const capability = timesheetCapabilitiesFor(user.role).edit;
    if (!capability.enabled) {
      return problem(c, {
        status: 403,
        code: 'CAPABILITY_DENIED',
        title: 'Capability disabled',
        detail: capability.reason,
        requestId: c.get('requestId'),
      });
    }
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
        detail: 'The update requires If-Match with the timesheet entry entity version.',
        requestId: c.get('requestId'),
      });
    }
    const [entryVersion] = ifMatch;
    const rawBody = await c.req.text();
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      return problem(c, {
        status: 400,
        code: 'INVALID_JSON',
        title: 'Invalid JSON body',
        detail: 'The request body is not valid JSON.',
        requestId: c.get('requestId'),
      });
    }
    const entryDate = body.entryDate as string | undefined;
    const hours = body.hours as string | undefined;
    if (entryDate !== undefined && (typeof entryDate !== 'string' || !isValidDate(entryDate))) {
      return problem(c, {
        status: 422,
        code: 'INVALID_ENTRY_DATE',
        title: 'Invalid entry date',
        detail: 'entryDate must be a calendar date (YYYY-MM-DD).',
        requestId: c.get('requestId'),
      });
    }
    if (hours !== undefined && (typeof hours !== 'string' || !HOURS_PATTERN.test(hours))) {
      return problem(c, {
        status: 422,
        code: 'INVALID_HOURS',
        title: 'Invalid hours',
        detail:
          'hours must be a decimal string from 0.00 through 24.00 with two fractional digits.',
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
        const current = await scoped.db
          .select({
            id: timesheetEntries.id,
            entityVersion: timesheetEntries.entityVersion,
            status: timesheetEntries.status,
          })
          .from(timesheetEntries)
          .where(eq(timesheetEntries.id, id))
          .for('update')
          .limit(1);
        const entry = current[0];
        if (!entry) {
          return { status: 404, body: { code: 'TIMESHEET_ENTRY_NOT_FOUND' } };
        }
        if (entry.entityVersion !== entryVersion) {
          return {
            status: 409,
            body: {
              type: 'urn:stdio:error',
              title: 'Entity version conflict',
              status: 409,
              code: 'ENTITY_VERSION_CONFLICT',
              detail:
                'The If-Match entity version does not match the current entity. Refetch and retry.',
              requestId: c.get('requestId'),
              details: { draftPreserved: true, currentEntityVersion: entry.entityVersion },
            },
          };
        }
        // The contract locks an approved entry: hours are never updated on an
        // APPROVED entry (409 ENTITY_VERSION_CONFLICT). A voided entry is
        // immutable too.
        if (entry.status === 'APPROVED' || entry.status === 'VOID') {
          return {
            status: 409,
            body: {
              type: 'urn:stdio:error',
              title: 'Entity version conflict',
              status: 409,
              code: 'ENTITY_VERSION_CONFLICT',
              detail:
                entry.status === 'APPROVED'
                  ? 'An approved timesheet entry is locked. Hours are never updated on an APPROVED entry.'
                  : 'A voided timesheet entry is locked.',
              requestId: c.get('requestId'),
              details: { draftPreserved: true, currentEntityVersion: entry.entityVersion },
            },
          };
        }
        const projectId = body.projectId as string | undefined;
        if (projectId !== undefined) {
          const projectRows = await scoped.db
            .select({ id: projects.id })
            .from(projects)
            .where(eq(projects.id, projectId))
            .limit(1);
          if (!projectRows[0]) {
            return { status: 404, body: { code: 'PROJECT_NOT_FOUND' } };
          }
        }
        const values: Record<string, unknown> = {};
        if (entryDate !== undefined) {
          values.entryDate = dateInstant(entryDate);
        }
        if (hours !== undefined) {
          values.hours = hours;
        }
        if ('notes' in body) {
          values.notes = body.notes === null ? null : ((body.notes as string | undefined) ?? null);
        }
        if (projectId !== undefined) {
          values.projectId = projectId;
        }
        const updated = await scoped.db
          .update(timesheetEntries)
          .set({ ...values, entityVersion: sql`gen_random_uuid()` })
          .where(eq(timesheetEntries.id, id))
          .returning({ id: timesheetEntries.id, entityVersion: timesheetEntries.entityVersion });
        const updatedRow = updated[0];
        if (!updatedRow) {
          return { status: 500, body: { code: 'WRITE_FAILED' } };
        }
        const row = await loadEntry(scoped, id);
        if (!row) {
          return { status: 500, body: { code: 'WRITE_FAILED' } };
        }
        return {
          status: 200,
          etag: updatedRow.entityVersion,
          body: {
            data: { entry: projectEntry(row, user.role) },
            meta: { ...meta(c.get('requestId')), idempotentReplay: false },
          },
        };
      },
      {
        requestId: c.get('requestId'),
        method: 'PATCH',
        path: c.req.path,
        flipReplayIdempotent: true,
        replayStatus: 200,
      },
    );

    if (result.outcome === 'conflict') {
      return problem(c, {
        status: 409,
        code: 'IDEMPOTENCY_KEY_REUSED',
        title: 'Idempotency key reused',
        detail:
          'This Idempotency-Key was used for a different request. A key is bound to one request body.',
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
  });

  // DELETE /timesheet-entries/{id} — guarded soft void.
  app.delete('/timesheet-entries/:id', async (c) => {
    const user = c.get('user');
    const id = c.req.param('id');
    const capability = timesheetCapabilitiesFor(user.role).void;
    if (!capability.enabled) {
      return problem(c, {
        status: 403,
        code: 'CAPABILITY_DENIED',
        title: 'Capability disabled',
        detail: capability.reason,
        requestId: c.get('requestId'),
      });
    }
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
        detail: 'The void requires If-Match with the timesheet entry entity version.',
        requestId: c.get('requestId'),
      });
    }
    const [entryVersion] = ifMatch;
    const rawBody = await c.req.text();
    const fingerprint = fingerprintFor(
      'DELETE',
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
        const current = await scoped.db
          .select({
            id: timesheetEntries.id,
            entityVersion: timesheetEntries.entityVersion,
            status: timesheetEntries.status,
          })
          .from(timesheetEntries)
          .where(eq(timesheetEntries.id, id))
          .for('update')
          .limit(1);
        const entry = current[0];
        if (!entry) {
          return { status: 404, body: { code: 'TIMESHEET_ENTRY_NOT_FOUND' } };
        }
        if (entry.entityVersion !== entryVersion) {
          return {
            status: 409,
            body: {
              type: 'urn:stdio:error',
              title: 'Entity version conflict',
              status: 409,
              code: 'ENTITY_VERSION_CONFLICT',
              detail:
                'The If-Match entity version does not match the current entity. Refetch and retry.',
              requestId: c.get('requestId'),
              details: { draftPreserved: true, currentEntityVersion: entry.entityVersion },
            },
          };
        }
        if (entry.status === 'VOID') {
          // Voiding an already-voided entry is a 200 no-op: the outcome the
          // client wants already holds.
          const row = await loadEntry(scoped, id);
          if (!row) {
            return { status: 500, body: { code: 'WRITE_FAILED' } };
          }
          return {
            status: 200,
            etag: entry.entityVersion,
            body: {
              data: { entry: projectEntry(row, user.role) },
              meta: { ...meta(c.get('requestId')), idempotentReplay: false },
            },
          };
        }
        const updated = await scoped.db
          .update(timesheetEntries)
          .set({ status: 'VOID', entityVersion: sql`gen_random_uuid()` })
          .where(eq(timesheetEntries.id, id))
          .returning({ id: timesheetEntries.id, entityVersion: timesheetEntries.entityVersion });
        const updatedRow = updated[0];
        if (!updatedRow) {
          return { status: 500, body: { code: 'WRITE_FAILED' } };
        }
        const row = await loadEntry(scoped, id);
        if (!row) {
          return { status: 500, body: { code: 'WRITE_FAILED' } };
        }
        return {
          status: 200,
          etag: updatedRow.entityVersion,
          body: {
            data: { entry: projectEntry(row, user.role) },
            meta: { ...meta(c.get('requestId')), idempotentReplay: false },
          },
        };
      },
      {
        requestId: c.get('requestId'),
        method: 'DELETE',
        path: c.req.path,
        flipReplayIdempotent: true,
        replayStatus: 200,
      },
    );

    if (result.outcome === 'conflict') {
      return problem(c, {
        status: 409,
        code: 'IDEMPOTENCY_KEY_REUSED',
        title: 'Idempotency key reused',
        detail:
          'This Idempotency-Key was used for a different request. A key is bound to one request body.',
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
  });
}
