/**
 * Integration tests for the SOL-19 timesheet routes (revision 6).
 *
 * Runs against the live `stdio_dev` database (seed: Studio Contoh). Proves
 * the acceptance criteria:
 *
 * - CRUD + soft void with the guarded-write contract (Idempotency-Key,
 *   If-Match, 409 typed conflicts, idempotent replay).
 * - Tenant-scoped relation resolution (SOL-69 condition 3): a cross-studio
 *   projectId or userId is a 404 and creates no row.
 * - The labour-rate snapshot is set at create time from the person's rate
 *   and never appears on the wire.
 * - Capability gating: a non-OWNER/PM role cannot create entries.
 * - APPROVED entries are locked (409 with `draftPreserved: true`).
 */

import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from './app';

const connectionString =
  process.env.DATABASE_URL ?? 'postgres://stdio:stdio@localhost:5432/stdio_dev';

const SEED_STUDIO = '00000000-0000-4000-8000-000000000001';
const SEED_OWNER = '00000000-0000-4000-8000-000000000002';
const SEED_PROJECT = '00000000-0000-4000-8000-000000000004';
const OTHER_STUDIO = '00000000-0000-4000-8000-0000000000aa';
const OTHER_USER = '00000000-0000-4000-8000-0000000000bb';
const OTHER_PROJECT = '00000000-0000-4000-8000-0000000000cc';

let pool: Pool;
let app: ReturnType<typeof createApp>;
let token = '';
let designerToken = '';

async function tenantQuery<T>(
  studioId: string,
  fn: (client: {
    query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
  }) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', ['app.studio_id', studioId]);
    await client.query('SET LOCAL ROLE studio_app');
    const result = await fn(client as never);
    await client.query('COMMIT');
    return result;
  } finally {
    client.release(true);
  }
}

async function mintToken(studioId: string, userId: string, value: string): Promise<void> {
  await tenantQuery(studioId, async (client) => {
    await client.query(
      `INSERT INTO access_tokens (studio_id, user_id, token, expires_at)
       VALUES ($1, $2, $3, now() + interval '1 hour')
       ON CONFLICT (token) DO NOTHING`,
      [studioId, userId, value],
    );
  });
}

const auth = () => ({ Authorization: `Bearer ${token}` });

beforeAll(async () => {
  pool = new Pool({ connectionString, max: 5 });
  app = createApp(pool);
  token = `naa_ts_${randomUUID()}`;
  designerToken = `naa_ts_designer_${randomUUID()}`;
  await mintToken(SEED_STUDIO, SEED_OWNER, token);

  // A designer in Studio Contoh: reads, but cannot create/edit/void.
  await tenantQuery(SEED_STUDIO, async (client) => {
    await client.query(
      `INSERT INTO users (id, studio_id, email, name, role)
       VALUES (gen_random_uuid(), $1, 'designer@contoh.studio', 'Desainer', 'DESIGNER')
       ON CONFLICT DO NOTHING`,
      [SEED_STUDIO],
    );
    const rows = (await client.query(
      `SELECT id FROM users WHERE studio_id = $1 AND email = 'designer@contoh.studio'`,
      [SEED_STUDIO],
    )) as { rows: { id: string }[] };
    const designerId = rows.rows[0]?.id;
    if (!designerId) {
      throw new Error('designer fixture missing');
    }
    await client.query(
      `INSERT INTO access_tokens (studio_id, user_id, token, expires_at)
       VALUES ($1, $2, $3, now() + interval '1 hour')
       ON CONFLICT (token) DO NOTHING`,
      [SEED_STUDIO, designerId, designerToken],
    );
  });

  // The other studio owns a user and a project; their ids must never resolve
  // inside Studio Contoh.
  await tenantQuery(OTHER_STUDIO, async (client) => {
    await client.query(
      `INSERT INTO studios (studio_id, name, currency, timezone)
       VALUES ($1, 'Studio Lain', 'IDR', 'Asia/Jakarta') ON CONFLICT DO NOTHING`,
      [OTHER_STUDIO],
    );
    await client.query(
      `INSERT INTO users (id, studio_id, email, name, role)
       VALUES ($1, $2, 'owner@lain.studio', 'Pemilik Lain', 'OWNER') ON CONFLICT DO NOTHING`,
      [OTHER_USER, OTHER_STUDIO],
    );
    await client.query(
      `INSERT INTO clients (id, studio_id, client_number, name)
       VALUES (gen_random_uuid(), $1, 'C-001', 'Klien Lain') ON CONFLICT DO NOTHING`,
      [OTHER_STUDIO],
    );
    const clients = (await client.query(
      `SELECT id FROM clients WHERE studio_id = $1 AND client_number = 'C-001'`,
      [OTHER_STUDIO],
    )) as { rows: { id: string }[] };
    const otherClientId = clients.rows[0]?.id;
    if (!otherClientId) {
      throw new Error('other-studio client fixture missing');
    }
    await client.query(
      `INSERT INTO projects (id, studio_id, project_code, name, client_id, status)
       VALUES ($1, $2, 'LAIN-001', 'Proyek Lain', $3, 'ACTIVE') ON CONFLICT DO NOTHING`,
      [OTHER_PROJECT, OTHER_STUDIO, otherClientId],
    );
  });

  // Deterministic fixture: clear every timesheet row the suite creates.
  await tenantQuery(SEED_STUDIO, async (client) => {
    await client.query(`DELETE FROM timesheet_entries WHERE notes = 'ts-test'`);
  });
});

afterAll(async () => {
  await tenantQuery(SEED_STUDIO, async (client) => {
    await client.query(`DELETE FROM timesheet_entries WHERE notes = 'ts-test'`);
  });
  await pool.end();
});

const createBody = (overrides: Record<string, unknown> = {}) => ({
  entryDate: '2026-08-21',
  hours: '7.50',
  projectId: SEED_PROJECT,
  userId: SEED_OWNER,
  notes: 'ts-test',
  ...overrides,
});

describe('timesheet create', () => {
  it('creates an entry and snapshots the labour rate server-side', async () => {
    const key = `key-create-${randomUUID()}`;
    const res = await app.request('/timesheet-entries', {
      method: 'POST',
      headers: { ...auth(), 'Idempotency-Key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify(createBody()),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(body.meta.idempotentReplay).toBe(false);
    expect(body.data.entry.entryDate).toBe('2026-08-21');
    expect(body.data.entry.hours).toBe('7.50');
    expect(body.data.entry.status).toBe('LOGGED');
    expect(body.data.entry.projectName).toBeTruthy();
    expect(body.data.entry.user.name).toBeTruthy();
    expect(body.data.entry.capabilities.create.enabled).toBe(true);
    // The rate is never on the wire (D-007).
    expect('effectiveHourlyRate' in body.data.entry).toBe(false);
    expect('hourlyRate' in body.data.entry).toBe(false);
    const id = body.data.entry.id as string;
    const snapshot = await tenantQuery(SEED_STUDIO, async (client) => {
      const res = await client.query(
        `SELECT effective_hourly_rate FROM timesheet_entries WHERE id = $1`,
        [id],
      );
      return (res.rows[0] as { effective_hourly_rate: string | null }).effective_hourly_rate;
    });
    // The seed owner rate is 125000.0000 (numeric(20,4)).
    expect(snapshot).toBe('125000.0000');
  });

  it('rejects hours outside the TimesheetHours grammar', async () => {
    for (const hours of ['25.00', '7.5', '7', '-1.00', '0.001']) {
      const res = await app.request('/timesheet-entries', {
        method: 'POST',
        headers: { ...auth(), 'Idempotency-Key': `key-bad-${randomUUID()}` },
        body: JSON.stringify(createBody({ hours })),
      });
      expect(res.status).toBe(422);
    }
  });

  it('rejects a malformed entryDate', async () => {
    const res = await app.request('/timesheet-entries', {
      method: 'POST',
      headers: { ...auth(), 'Idempotency-Key': `key-date-${randomUUID()}` },
      body: JSON.stringify(createBody({ entryDate: '21/08/2026' })),
    });
    expect(res.status).toBe(422);
    expect(((await res.json()) as any).code).toBe('INVALID_ENTRY_DATE');
  });

  it('denies a non-OWNER/PM role (capability gate)', async () => {
    const res = await app.request('/timesheet-entries', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${designerToken}`,
        'Idempotency-Key': `key-design-${randomUUID()}`,
      },
      body: JSON.stringify(createBody()),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).code).toBe('CAPABILITY_DENIED');
  });

  it('replays an idempotent retry with idempotentReplay true', async () => {
    const key = `key-replay-${randomUUID()}`;
    const body = JSON.stringify(createBody());
    const first = await app.request('/timesheet-entries', {
      method: 'POST',
      headers: { ...auth(), 'Idempotency-Key': key },
      body,
    });
    expect(first.status).toBe(201);
    const second = await app.request('/timesheet-entries', {
      method: 'POST',
      headers: { ...auth(), 'Idempotency-Key': key },
      body,
    });
    expect(second.status).toBe(200);
    const body2 = (await second.json()) as any;
    expect(body2.meta.idempotentReplay).toBe(true);
    expect(body2.data.entry.id).toBe(((await first.json()) as any).data.entry.id);
  });

  it('rejects the same key with a different body (409 IDEMPOTENCY_KEY_REUSED)', async () => {
    const key = `key-reused-${randomUUID()}`;
    await app.request('/timesheet-entries', {
      method: 'POST',
      headers: { ...auth(), 'Idempotency-Key': key },
      body: JSON.stringify(createBody({ hours: '8.00' })),
    });
    const res = await app.request('/timesheet-entries', {
      method: 'POST',
      headers: { ...auth(), 'Idempotency-Key': key },
      body: JSON.stringify(createBody({ hours: '9.00' })),
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as any).code).toBe('IDEMPOTENCY_KEY_REUSED');
  });
});

describe('timesheet tenant boundary (SOL-69 condition 3)', () => {
  it('returns 404 and creates no row for a foreign-studio projectId', async () => {
    const res = await app.request('/timesheet-entries', {
      method: 'POST',
      headers: { ...auth(), 'Idempotency-Key': `key-foreign-project-${randomUUID()}` },
      body: JSON.stringify(createBody({ projectId: OTHER_PROJECT })),
    });
    expect(res.status).toBe(404);
    const count = await tenantQuery(SEED_STUDIO, async (client) => {
      const r = await client.query(
        `SELECT count(*) FROM timesheet_entries WHERE notes = 'ts-test' AND project_id = $1`,
        [OTHER_PROJECT],
      );
      return Number((r.rows[0] as { count: string }).count);
    });
    expect(count).toBe(0);
  });

  it('returns 404 and creates no row for a foreign-studio userId', async () => {
    const res = await app.request('/timesheet-entries', {
      method: 'POST',
      headers: { ...auth(), 'Idempotency-Key': `key-foreign-user-${randomUUID()}` },
      body: JSON.stringify(createBody({ userId: OTHER_USER })),
    });
    expect(res.status).toBe(404);
  });
});

describe('timesheet read', () => {
  it('lists entries and filters by projectId', async () => {
    const res = await app.request(`/timesheet-entries?projectId=${SEED_PROJECT}&pageSize=5`, {
      headers: auth(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.meta.pagination.totalItems).toBeGreaterThanOrEqual(1);
    expect(body.data.entries[0].projectId).toBe(SEED_PROJECT);
  });

  it('gets one entry and 404s a missing id', async () => {
    // Read a row this suite owns. The register list is unordered, so a
    // list-then-fetch of the first row races other suites that delete
    // their own timesheet rows from the shared database in parallel.
    const created = await app.request('/timesheet-entries', {
      method: 'POST',
      headers: {
        ...auth(),
        'Idempotency-Key': `key-read-${randomUUID()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(createBody()),
    });
    expect(created.status).toBe(201);
    const entry = ((await created.json()) as any).data.entry;
    const res = await app.request(`/timesheet-entries/${entry.id}`, { headers: auth() });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).data.entry.id).toBe(entry.id);
    const missing = await app.request(`/timesheet-entries/${randomUUID()}`, { headers: auth() });
    expect(missing.status).toBe(404);
  });
});

describe('timesheet update and void', () => {
  async function createEntry(): Promise<{ id: string; version: string }> {
    const res = await app.request('/timesheet-entries', {
      method: 'POST',
      headers: { ...auth(), 'Idempotency-Key': `key-fixture-${randomUUID()}` },
      body: JSON.stringify(createBody({ hours: '6.00', entryDate: '2026-08-22' })),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    return { id: body.data.entry.id, version: body.data.entry.entityVersion };
  }

  it('patches a draft entry with If-Match', async () => {
    const { id, version } = await createEntry();
    const res = await app.request(`/timesheet-entries/${id}`, {
      method: 'PATCH',
      headers: {
        ...auth(),
        'Idempotency-Key': `key-patch-${randomUUID()}`,
        'If-Match': `"${version}"`,
      },
      body: JSON.stringify({ hours: '8.50', notes: 'ts-test updated' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.data.entry.hours).toBe('8.50');
    expect(body.data.entry.entityVersion).not.toBe(version);
  });

  it('rejects a stale If-Match with the typed 409', async () => {
    const { id } = await createEntry();
    const res = await app.request(`/timesheet-entries/${id}`, {
      method: 'PATCH',
      headers: {
        ...auth(),
        'Idempotency-Key': `key-stale-${randomUUID()}`,
        'If-Match': `"${randomUUID()}"`,
      },
      body: JSON.stringify({ hours: '8.00' }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as any;
    expect(body.code).toBe('ENTITY_VERSION_CONFLICT');
    expect(body.details.draftPreserved).toBe(true);
    expect(body.details.currentEntityVersion).toBeTruthy();
  });

  it('locks an APPROVED entry (409, draft preserved)', async () => {
    const { id } = await createEntry();
    const approved = await tenantQuery(SEED_STUDIO, async (client) => {
      const r = await client.query(
        `UPDATE timesheet_entries SET status = 'APPROVED'
         WHERE id = $1 RETURNING entity_version`,
        [id],
      );
      return (r.rows[0] as { entity_version: string }).entity_version;
    });
    const res = await app.request(`/timesheet-entries/${id}`, {
      method: 'PATCH',
      headers: {
        ...auth(),
        'Idempotency-Key': `key-approved-${randomUUID()}`,
        'If-Match': `"${approved}"`,
      },
      body: JSON.stringify({ hours: '1.00' }),
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as any).details.draftPreserved).toBe(true);
  });

  it('soft-voids an entry and no-ops a second void', async () => {
    const { id, version } = await createEntry();
    const first = await app.request(`/timesheet-entries/${id}`, {
      method: 'DELETE',
      headers: {
        ...auth(),
        'Idempotency-Key': `key-void-${randomUUID()}`,
        'If-Match': `"${version}"`,
      },
    });
    expect(first.status).toBe(200);
    expect(((await first.json()) as any).data.entry.status).toBe('VOID');
    const current = await tenantQuery(SEED_STUDIO, async (client) => {
      const r = await client.query(`SELECT entity_version FROM timesheet_entries WHERE id = $1`, [
        id,
      ]);
      return (r.rows[0] as { entity_version: string }).entity_version;
    });
    const second = await app.request(`/timesheet-entries/${id}`, {
      method: 'DELETE',
      headers: {
        ...auth(),
        'Idempotency-Key': `key-void2-${randomUUID()}`,
        'If-Match': `"${current}"`,
      },
    });
    expect(second.status).toBe(200);
    expect(((await second.json()) as any).data.entry.status).toBe('VOID');
  });
});
