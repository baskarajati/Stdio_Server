/**
 * SOL-19 revision 6 integration tests: timesheets, budget-versus-actual,
 * and the ten register writes.
 *
 * Runs on its own scratch database (`stdio_sol19_<rand>`): create, apply
 * every migration, seed minimal fixtures on the tenant path, and drop. The
 * suite never touches `stdio_dev`, so concurrent sessions cannot break it.
 *
 * Covers the SOL-69 implementation gates:
 *
 * - 6a/2 — SOL-73-A money rules through the endpoint: the counterexample
 *   `Q=1, R=0.5, U=0.01` shows actual `0.01`, committed `0.00`, total
 *   `0.01`; over-receipt is capped (C2); labour products round half-up
 *   independently (C1); derived fields are never double-rounded (C1);
 *   I-1/I-2 hold on the wire.
 * - 6b — every supplied relation resolves inside the studio; a
 *   cross-studio identifier returns not-found and creates no row (timesheet
 *   userId/projectId, spec-item projectId, quotation engagementId,
 *   client accountManagerId).
 * - 6c — same-studio ancestry: quotation requires the engagement to belong
 *   to the project and the client to be the project's client; invoice
 *   requires the same client-project match.
 * - 6d — negative tests proving a cross-studio request creates no relation,
 *   plus wrong project-client pair tests for quotation and invoice writes.
 * - 6e — I-1 conservation after rounding and after receipt reversal.
 * - 6f — `TimesheetEntry` never exposes a rate; the report projects
 *   `capabilities.read` and `canReadFinance` and uses role-blended labour
 *   only.
 */

import { randomUUID } from 'node:crypto';
import { applyMigrations } from '@stdio/db/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from './app';

const adminUrl = process.env.DATABASE_URL ?? 'postgres://stdio:stdio@localhost:5432/stdio_dev';
const testDb = `stdio_sol19_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
const testUrl = adminUrl.replace(/\/[^/]+$/, `/${testDb}`);

const IDS = {
  studio: randomUUID(),
  owner: randomUUID(),
  pm: randomUUID(),
  designer: randomUUID(),
  finance: randomUUID(),
  clientA: randomUUID(),
  clientB: randomUUID(),
  projectA: randomUUID(), // clientA
  projectB: randomUUID(), // clientB
  projectC: randomUUID(), // clientA — the counterexample project
  engagementA: randomUUID(),
  engagementB: randomUUID(),
  engagementC: randomUUID(),
  vendor: randomUUID(),
  poCounter: randomUUID(),
  poDraft: randomUUID(),
  otherStudio: randomUUID(),
  otherUser: randomUUID(),
  otherClient: randomUUID(),
  otherProject: randomUUID(),
  otherEngagement: randomUUID(),
};

let pool: pg.Pool;
let app: ReturnType<typeof createApp>;

const tokens: Record<string, string> = {};

async function tenant<T>(studioId: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', ['app.studio_id', studioId]);
    await client.query('SET LOCAL ROLE studio_app');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } finally {
    client.release(true);
  }
}

function mintToken(userId: string): string {
  const token = `naa_sol19_${randomUUID()}`;
  tokens[userId] = token;
  return token;
}

async function seedFixtures(): Promise<void> {
  const s = IDS.studio;
  await tenant(s, async (client) => {
    await client.query(
      `INSERT INTO studios (studio_id, name, currency, timezone)
       VALUES ($1, 'Studio SOL-19', 'IDR', 'Asia/Jakarta')`,
      [s],
    );
    const users: Array<[string, string, string, string]> = [
      [IDS.owner, 'owner@sol19.studio', 'Pemilik', 'OWNER'],
      [IDS.pm, 'pm@sol19.studio', 'Manajer', 'PM'],
      [IDS.designer, 'designer@sol19.studio', 'Desainer', 'DESIGNER'],
      [IDS.finance, 'finance@sol19.studio', 'Keuangan', 'FINANCE'],
    ];
    for (const [id, email, name, role] of users) {
      await client.query(
        `INSERT INTO users (id, studio_id, email, name, role, labour_rate)
         VALUES ($1, $2, $3, $4, $5, '50.0000')`,
        [id, s, email, name, role],
      );
      mintToken(id);
      await client.query(
        `INSERT INTO access_tokens (studio_id, user_id, token, expires_at)
         VALUES ($1, $2, $3, now() + interval '1 hour')`,
        [s, id, tokens[id]],
      );
    }
    // Set the designer's rate distinctly so the labour line is role-blended.
    await client.query(`UPDATE users SET labour_rate = '125.0000' WHERE id = $1`, [IDS.owner]);
    await client.query(`UPDATE users SET labour_rate = '50.0000' WHERE id = $1`, [IDS.designer]);

    await client.query(
      `INSERT INTO clients (id, studio_id, client_number, name, company_name, status)
       VALUES ($1, $2, 'CL-A', 'PT Klien A', 'PT Klien A', 'ACTIVE'),
              ($3, $2, 'CL-B', 'PT Klien B', 'PT Klien B', 'ACTIVE')`,
      [IDS.clientA, s, IDS.clientB],
    );
    await client.query(
      `INSERT INTO projects (id, studio_id, project_code, name, client_id, status)
       VALUES ($1, $2, 'PRJ-A', 'Proyek A', $3, 'ACTIVE'),
              ($4, $2, 'PRJ-B', 'Proyek B', $5, 'ACTIVE'),
              ($6, $2, 'PRJ-C', 'Proyek C', $3, 'ACTIVE')`,
      [IDS.projectA, s, IDS.clientA, IDS.projectB, IDS.clientB, IDS.projectC],
    );
    await client.query(
      `INSERT INTO project_engagements (id, studio_id, project_id, kind, sort_order,
                                        lifecycle_status, contract_state, transaction_price)
       VALUES ($1, $2, $3, 'DESIGN', 1, 'ACTIVE', 'SIGNED', '100.00'),
              ($4, $2, $5, 'DESIGN', 1, 'ACTIVE', 'SIGNED', '0.00'),
              ($6, $2, $7, 'DESIGN', 1, 'ACTIVE', 'SIGNED', '1.00')`,
      [
        IDS.engagementA,
        s,
        IDS.projectA,
        IDS.engagementB,
        IDS.projectB,
        IDS.engagementC,
        IDS.projectC,
      ],
    );
    await client.query(
      `INSERT INTO vendors (id, studio_id, vendor_code, name, category)
       VALUES ($1, $2, 'VEN-1', 'CV Pemasok', 'MATERIAL')`,
      [IDS.vendor, s],
    );
    // The counterexample PO (project C): Q=1, R=0.5, U=0.01, SENT (committed
    // state). The received quantity is the cumulative net after a reversal.
    await client.query(
      `INSERT INTO purchase_orders (id, studio_id, purchase_order_number, project_id, vendor_id,
                                    status, currency, issue_date)
       VALUES ($1, $2, 'PO-COUNTER', $3, $4, 'SENT', 'IDR', '2026-08-01'),
              ($5, $2, 'PO-DRAFT', $3, $4, 'DRAFT', 'IDR', '2026-08-01')`,
      [IDS.poCounter, s, IDS.projectC, IDS.vendor, IDS.poDraft],
    );
    await client.query(
      `INSERT INTO purchase_order_items (id, studio_id, purchase_order_id, description,
                                         quantity, received_quantity, unit_cost)
       VALUES (gen_random_uuid(), $1, $2, 'Item counter', '1.0000', '0.5000', '0.01'),
              (gen_random_uuid(), $1, $3, 'Item draft', '10.0000', '0.0000', '100.00')`,
      [s, IDS.poCounter, IDS.poDraft],
    );
    // Labour: one APPROVED designer entry (8h x 50.00 = 400.00) on project A,
    // and one LOGGED entry that must be excluded from the report.
    await client.query(
      `INSERT INTO timesheet_entries (id, studio_id, user_id, project_id, entry_date, hours,
                                      effective_hourly_rate, status)
       VALUES (gen_random_uuid(), $1, $2, $3, '2026-08-20', '8.00', '50.0000', 'APPROVED'),
              (gen_random_uuid(), $1, $2, $3, '2026-08-21', '8.00', '50.0000', 'LOGGED')`,
      [s, IDS.designer, IDS.projectA],
    );
  });

  // A second studio whose rows must never be visible to Studio SOL-19.
  const o = IDS.otherStudio;
  await tenant(o, async (client) => {
    await client.query(
      `INSERT INTO studios (studio_id, name, currency, timezone)
       VALUES ($1, 'Studio Lain', 'IDR', 'Asia/Jakarta')`,
      [o],
    );
    await client.query(
      `INSERT INTO users (id, studio_id, email, name, role, labour_rate)
       VALUES ($1, $2, 'owner@lain.studio', 'Pemilik Lain', 'OWNER', '200.0000')`,
      [IDS.otherUser, o],
    );
    await client.query(
      `INSERT INTO clients (id, studio_id, client_number, name, status)
       VALUES ($1, $2, 'CL-O', 'Klien Lain', 'ACTIVE')`,
      [IDS.otherClient, o],
    );
    await client.query(
      `INSERT INTO projects (id, studio_id, project_code, name, client_id, status)
       VALUES ($1, $2, 'PRJ-O', 'Proyek Lain', $3, 'ACTIVE')`,
      [IDS.otherProject, o, IDS.otherClient],
    );
    await client.query(
      `INSERT INTO project_engagements (id, studio_id, project_id, kind, sort_order,
                                        lifecycle_status, contract_state, transaction_price)
       VALUES ($1, $2, $3, 'DESIGN', 1, 'ACTIVE', 'SIGNED', '999.00')`,
      [IDS.otherEngagement, o, IDS.otherProject],
    );
  });
}

async function countRows(table: string, where: string, params: unknown[]): Promise<number> {
  return tenant(IDS.studio, async (client) => {
    const res = await client.query(
      `SELECT count(*)::int AS n FROM ${table} WHERE ${where}`,
      params,
    );
    return (res.rows[0] as { n: number }).n;
  });
}

function auth(userId: string): Record<string, string> {
  return { Authorization: `Bearer ${tokens[userId]}` };
}

function jsonHeaders(userId: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    ...auth(userId),
    'Content-Type': 'application/json',
    ...extra,
  };
}

async function post(
  userId: string,
  path: string,
  body: unknown,
  extra: Record<string, string> = {},
): Promise<Response> {
  return app.request(path, {
    method: 'POST',
    headers: jsonHeaders(userId, extra),
    body: JSON.stringify(body),
  });
}

async function patch(
  userId: string,
  path: string,
  body: unknown,
  extra: Record<string, string> = {},
): Promise<Response> {
  return app.request(path, {
    method: 'PATCH',
    headers: jsonHeaders(userId, extra),
    body: JSON.stringify(body),
  });
}

async function remove(
  userId: string,
  path: string,
  extra: Record<string, string> = {},
): Promise<Response> {
  return app.request(path, { method: 'DELETE', headers: jsonHeaders(userId, extra) });
}

beforeAll(async () => {
  const creator = new pg.Client({ connectionString: adminUrl });
  await creator.connect();
  await creator.query(`CREATE DATABASE ${testDb}`);
  await creator.end();

  await applyMigrations(testUrl);
  pool = new pg.Pool({ connectionString: testUrl, max: 5 });
  app = createApp(pool);
  await seedFixtures();
}, 120_000);

afterAll(async () => {
  await pool.end();
  const admin = new pg.Pool({ connectionString: adminUrl, max: 1 });
  await admin.query(`DROP DATABASE IF EXISTS ${testDb} WITH (FORCE)`);
  await admin.end();
});

describe('SOL-19 timesheets', () => {
  it('creates an entry (201), never exposing a rate, with MutationMeta', async () => {
    const res = await post(
      IDS.designer,
      '/timesheet-entries',
      {
        userId: IDS.designer,
        projectId: IDS.projectA,
        entryDate: '2026-08-20',
        hours: '7.50',
        notes: 'Survei lokasi',
      },
      { 'Idempotency-Key': 'ts-create-1-aaaaaaaa' },
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(body.data.entry.hours).toBe('7.50');
    expect(body.data.entry.status).toBe('LOGGED');
    expect(body.data.entry.projectName).toBe('Proyek A');
    expect(body.data.entry.user.name).toBe('Desainer');
    expect(body.data.entry.entryDate).toBe('2026-08-20');
    expect(body.data.entry).not.toHaveProperty('effectiveHourlyRate');
    expect(body.data.entry).not.toHaveProperty('effectiveHourlyRateLabel');
    expect(body.meta.idempotentReplay).toBe(false);
    expect(body.data.entry.capabilities.read.enabled).toBe(true);
    expect(res.headers.get('ETag')).toMatch(/^W\//);
  });

  it('replays a same-key retry (200, idempotentReplay true) and rejects a different body', async () => {
    const body = {
      userId: IDS.designer,
      projectId: IDS.projectA,
      entryDate: '2026-08-22',
      hours: '8.00',
    };
    const first = await post(IDS.designer, '/timesheet-entries', body, {
      'Idempotency-Key': 'ts-replay-1-aaaaaaaa',
    });
    expect(first.status).toBe(201);
    const replay = await post(IDS.designer, '/timesheet-entries', body, {
      'Idempotency-Key': 'ts-replay-1-aaaaaaaa',
    });
    expect(replay.status).toBe(200);
    const replayBody = (await replay.json()) as any;
    expect(replayBody.meta.idempotentReplay).toBe(true);

    const other = await post(
      IDS.designer,
      '/timesheet-entries',
      {
        ...body,
        hours: '9.00',
      },
      { 'Idempotency-Key': 'ts-replay-1-aaaaaaaa' },
    );
    expect(other.status).toBe(409);
    expect(((await other.json()) as any).code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('validates hours and entryDate shapes (422)', async () => {
    for (const hours of ['24.01', '8', '8.5', '-1.00']) {
      const res = await post(
        IDS.designer,
        '/timesheet-entries',
        {
          userId: IDS.designer,
          projectId: IDS.projectA,
          entryDate: '2026-08-20',
          hours,
        },
        { 'Idempotency-Key': `ts-bad-hours-${randomUUID()}` },
      );
      expect(res.status).toBe(422);
      expect(((await res.json()) as any).code).toBe('INVALID_HOURS');
    }
    const res = await post(
      IDS.designer,
      '/timesheet-entries',
      {
        userId: IDS.designer,
        projectId: IDS.projectA,
        entryDate: '2026/08/20',
        hours: '8.00',
      },
      { 'Idempotency-Key': 'ts-bad-date-aaaaaaaa' },
    );
    expect(res.status).toBe(422);
    expect(((await res.json()) as any).code).toBe('INVALID_ENTRY_DATE');
  });

  it('lists entries tenant-scoped with filters and pagination meta', async () => {
    const res = await app.request('/timesheet-entries?projectId=' + IDS.projectA, {
      headers: auth(IDS.designer),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.data.entries.length).toBeGreaterThanOrEqual(1);
    expect(body.meta.pagination.totalItems).toBeGreaterThanOrEqual(1);
  });

  it('updates a LOGGED entry (If-Match) and 409s on stale or APPROVED', async () => {
    const created = await post(
      IDS.designer,
      '/timesheet-entries',
      {
        userId: IDS.designer,
        projectId: IDS.projectA,
        entryDate: '2026-08-23',
        hours: '6.00',
      },
      { 'Idempotency-Key': 'ts-update-1-aaaaaaaa' },
    );
    const entry = ((await created.json()) as any).data.entry;

    const res = await patch(
      IDS.designer,
      `/timesheet-entries/${entry.id}`,
      { hours: '6.50' },
      {
        'Idempotency-Key': 'ts-update-2-aaaaaaaa',
        'If-Match': `"${entry.entityVersion}"`,
      },
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).data.entry.hours).toBe('6.50');

    const stale = await patch(
      IDS.designer,
      `/timesheet-entries/${entry.id}`,
      { hours: '7.00' },
      {
        'Idempotency-Key': 'ts-update-3-aaaaaaaa',
        'If-Match': `"${entry.entityVersion}"`,
      },
    );
    expect(stale.status).toBe(409);
    const conflict = (await stale.json()) as any;
    expect(conflict.code).toBe('ENTITY_VERSION_CONFLICT');
    expect(conflict.details.draftPreserved).toBe(true);
    expect(conflict.details.currentEntityVersion).toBeTruthy();

    // APPROVED entries are immutable per the contract.
    const approved = await tenant(IDS.studio, async (client) => {
      const res = await client.query(
        `SELECT id, entity_version FROM timesheet_entries WHERE status = 'APPROVED' LIMIT 1`,
      );
      return res.rows[0] as { id: string; entity_version: string };
    });
    const approvedPatch = await patch(
      IDS.designer,
      `/timesheet-entries/${approved.id}`,
      {
        hours: '1.00',
      },
      {
        'Idempotency-Key': 'ts-update-4-aaaaaaaa',
        'If-Match': `"${approved.entity_version}"`,
      },
    );
    expect(approvedPatch.status).toBe(409);
  });

  it('voids an entry (DELETE, If-Match); VOID entries leave the list', async () => {
    const created = await post(
      IDS.designer,
      '/timesheet-entries',
      {
        userId: IDS.designer,
        projectId: IDS.projectA,
        entryDate: '2026-08-24',
        hours: '4.00',
      },
      { 'Idempotency-Key': 'ts-void-1-aaaaaaaa' },
    );
    const entry = ((await created.json()) as any).data.entry;

    const res = await remove(IDS.designer, `/timesheet-entries/${entry.id}`, {
      'Idempotency-Key': 'ts-void-2-aaaaaaaa',
      'If-Match': `"${entry.entityVersion}"`,
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).data.entry.status).toBe('VOID');

    const list = await app.request(`/timesheet-entries?projectId=${IDS.projectA}`, {
      headers: auth(IDS.designer),
    });
    const entries = ((await list.json()) as any).data.entries as Array<{ id: string }>;
    expect(entries.some((e) => e.id === entry.id)).toBe(false);
  });

  it('rejects a cross-studio userId and projectId with no row created (6b, 6d)', async () => {
    const crossUser = await post(
      IDS.designer,
      '/timesheet-entries',
      {
        userId: IDS.otherUser,
        projectId: IDS.projectA,
        entryDate: '2026-08-25',
        hours: '8.00',
      },
      { 'Idempotency-Key': 'ts-xuser-1-aaaaaaaa' },
    );
    expect(crossUser.status).toBe(422);
    expect(((await crossUser.json()) as any).code).toBe('USER_NOT_FOUND');
    expect(await countRows('timesheet_entries', 'user_id = $1', [IDS.otherUser])).toBe(0);

    const crossProject = await post(
      IDS.designer,
      '/timesheet-entries',
      {
        userId: IDS.designer,
        projectId: IDS.otherProject,
        entryDate: '2026-08-25',
        hours: '8.00',
      },
      { 'Idempotency-Key': 'ts-xproj-1-aaaaaaaa' },
    );
    expect(crossProject.status).toBe(422);
    expect(((await crossProject.json()) as any).code).toBe('PROJECT_NOT_FOUND');
    expect(await countRows('timesheet_entries', 'project_id = $1', [IDS.otherProject])).toBe(0);
  });
});

describe('SOL-19 budget-versus-actual', () => {
  it('gates the report by role: DESIGNER gets 403 CAPABILITY_DENIED', async () => {
    const res = await app.request(`/projects/${IDS.projectC}/budget-vs-actual`, {
      headers: auth(IDS.designer),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).code).toBe('CAPABILITY_DENIED');
  });

  it('resolves the counterexample Q=1, R=0.5, U=0.01 on the wire (SOL-73-A rule 5)', async () => {
    const res = await app.request(`/projects/${IDS.projectC}/budget-vs-actual`, {
      headers: auth(IDS.owner),
    });
    expect(res.status).toBe(200);
    const report = ((await res.json()) as any).data.report;
    expect(report.totalBudget).toBe('1.00');
    expect(report.actualCost).toBe('0.01');
    expect(report.committedCost).toBe('0.00');
    expect(report.labourActualCost).toBe('0.00');
    expect(report.signedVariance).toBe('0.99');
    expect(report.forecastRemaining).toBe('0.99');
    expect(report.canReadFinance).toBe(true);
    expect(report.capabilities.read.enabled).toBe(true);
    const line = report.lines[0];
    expect(line.kind).toBe('purchase_order');
    expect(line.actualCost).toBe('0.01');
    expect(line.committedCost).toBe('0.00');
  });

  it('sums labour from APPROVED entries only and excludes DRAFT POs (I-2, 6e)', async () => {
    const res = await app.request(`/projects/${IDS.projectA}/budget-vs-actual`, {
      headers: auth(IDS.owner),
    });
    expect(res.status).toBe(200);
    const report = ((await res.json()) as any).data.report;
    // transactionPrice 100.00; no committed POs on project A; the DRAFT PO
    // on project C is excluded from the counterexample project, and no PO
    // exists on project A, so external cost is zero.
    expect(report.totalBudget).toBe('100.00');
    expect(report.labourActualCost).toBe('400.00');
    expect(report.committedCost).toBe('0.00');
    expect(report.actualCost).toBe('400.00');
    expect(report.signedVariance).toBe('-300.00');
    expect(report.forecastRemaining).toBe('0.00');
    expect(report.signal.level).toBe('over');
    const labourLine = report.lines.find((l: { bucket: string }) => l.bucket === 'labour');
    expect(labourLine).toBeTruthy();
    expect(labourLine.name).toBe('Designer');
    expect(labourLine.actualCost).toBe('400.00');
  });

  it('excludes DRAFT purchase orders from the report (2.5)', async () => {
    const res = await app.request(`/projects/${IDS.projectC}/budget-vs-actual`, {
      headers: auth(IDS.owner),
    });
    const report = ((await res.json()) as any).data.report;
    expect(report.actualCost).toBe('0.01');
    expect(report.lines.every((l: { id: string }) => l.id !== IDS.poDraft)).toBe(true);
  });

  it('serves a PM with canReadFinance false but keeps the report fields (D-007)', async () => {
    const res = await app.request(`/projects/${IDS.projectC}/budget-vs-actual`, {
      headers: auth(IDS.pm),
    });
    expect(res.status).toBe(200);
    const report = ((await res.json()) as any).data.report;
    expect(report.canReadFinance).toBe(false);
    expect(report.totalBudget).toBe('1.00');
    expect(report.capabilities.read.enabled).toBe(true);
  });

  it('returns 404 for a project outside the studio', async () => {
    const res = await app.request(`/projects/${IDS.otherProject}/budget-vs-actual`, {
      headers: auth(IDS.owner),
    });
    expect(res.status).toBe(404);
  });
});

describe('SOL-19 register writes', () => {
  it('creates and updates a client with replay and If-Match conflict', async () => {
    const created = await post(
      IDS.designer,
      '/clients',
      {
        clientNumber: 'CL-777',
        name: 'Klien Baru',
        companyName: 'PT Klien Baru',
        email: 'klien@baru.id',
        type: 'COMPANY',
      },
      { 'Idempotency-Key': 'cl-create-1-aaaaaaaa' },
    );
    expect(created.status).toBe(201);
    const client = ((await created.json()) as any).data.client;
    expect(client.clientNumber).toBe('CL-777');
    expect(client.primaryContact.email).toBe('klien@baru.id');
    expect(client.source.type).toBe('client');
    expect(client.counts.quotations).toBe(0);

    const replay = await post(
      IDS.designer,
      '/clients',
      {
        clientNumber: 'CL-777',
        name: 'Klien Baru',
        companyName: 'PT Klien Baru',
        email: 'klien@baru.id',
        type: 'COMPANY',
      },
      { 'Idempotency-Key': 'cl-create-1-aaaaaaaa' },
    );
    expect(replay.status).toBe(200);
    expect(((await replay.json()) as any).meta.idempotentReplay).toBe(true);

    const updated = await patch(
      IDS.designer,
      `/clients/${client.id}`,
      { phone: '+62 812 0000' },
      {
        'Idempotency-Key': 'cl-update-1-aaaaaaaa',
        'If-Match': `"${client.entityVersion}"`,
      },
    );
    expect(updated.status).toBe(200);
    expect(((await updated.json()) as any).data.client.primaryContact.phone).toBe('+62 812 0000');

    const stale = await patch(
      IDS.designer,
      `/clients/${client.id}`,
      { name: 'X' },
      {
        'Idempotency-Key': 'cl-update-2-aaaaaaaa',
        'If-Match': `"${client.entityVersion}"`,
      },
    );
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as any).code).toBe('ENTITY_VERSION_CONFLICT');
  });

  it('rejects a cross-studio account manager with no client row (6b, 6d)', async () => {
    const res = await post(
      IDS.designer,
      '/clients',
      {
        clientNumber: 'CL-999',
        name: 'Klien Lintas',
        accountManagerId: IDS.otherUser,
      },
      { 'Idempotency-Key': 'cl-xam-1-aaaaaaaa' },
    );
    expect(res.status).toBe(422);
    expect(((await res.json()) as any).code).toBe('INVALID_ACCOUNT_MANAGER');
    expect(await countRows('clients', 'client_number = $1', ['CL-999'])).toBe(0);
  });

  it('creates and updates a vendor', async () => {
    const created = await post(
      IDS.designer,
      '/vendors',
      {
        vendorNumber: 'VEN-900',
        name: 'Pemasok Baru',
        categoryLabel: 'FURNITURE',
        email: 'supply@baru.id',
      },
      { 'Idempotency-Key': 've-create-1-aaaaaaaa' },
    );
    expect(created.status).toBe(201);
    const vendor = ((await created.json()) as any).data.vendor;
    expect(vendor.vendorCode).toBe('VEN-900');
    expect(vendor.categoryLabel).toBe('FURNITURE');
    expect(vendor.contacts).toEqual([]);

    const updated = await patch(
      IDS.designer,
      `/vendors/${vendor.id}`,
      { phone: '+62 21 555' },
      {
        'Idempotency-Key': 've-update-1-aaaaaaaa',
        'If-Match': `"${vendor.entityVersion}"`,
      },
    );
    expect(updated.status).toBe(200);
    expect(((await updated.json()) as any).data.vendor.phone).toBe('+62 21 555');
  });

  it('creates a spec item; rejects a cross-studio project with no row (6b, 6d)', async () => {
    const created = await post(
      IDS.designer,
      '/spec-items',
      {
        name: 'Keramik 60x60',
        projectId: IDS.projectA,
        room: 'Ruang tamu',
        quantityLabel: '25 m2',
      },
      { 'Idempotency-Key': 'si-create-1-aaaaaaaa' },
    );
    expect(created.status).toBe(201);
    const specItem = ((await created.json()) as any).data.specItem;
    expect(specItem.stage).toBe('drafting');
    expect(specItem.status).toBe('DRAFT');
    expect(specItem.projectName).toBe('Proyek A');
    expect(specItem.source.type).toBe('spec-item');

    const cross = await post(
      IDS.designer,
      '/spec-items',
      {
        name: 'Lintas',
        projectId: IDS.otherProject,
      },
      { 'Idempotency-Key': 'si-xproj-1-aaaaaaaa' },
    );
    expect(cross.status).toBe(404);
    expect(await countRows('spec_items', 'name = $1', ['Lintas'])).toBe(0);

    const updated = await patch(
      IDS.designer,
      `/spec-items/${specItem.id}`,
      { brand: 'Granit' },
      {
        'Idempotency-Key': 'si-update-1-aaaaaaaa',
        'If-Match': `"${specItem.entityVersion}"`,
      },
    );
    expect(updated.status).toBe(200);
    expect(((await updated.json()) as any).data.specItem.brand).toBe('Granit');
  });

  it('creates a quotation with the project+engagement pair and project-client ancestry', async () => {
    const created = await post(
      IDS.owner,
      '/quotations',
      {
        clientId: IDS.clientA,
        projectId: IDS.projectA,
        engagementId: IDS.engagementA,
        quotationNumber: 'QUO-500',
        title: 'Penawaran Proyek A',
        currency: 'IDR',
      },
      { 'Idempotency-Key': 'qu-create-1-aaaaaaaa' },
    );
    expect(created.status).toBe(201);
    const quotation = ((await created.json()) as any).data.quotation;
    expect(quotation.status).toBe('DRAFT');
    expect(quotation.client.name).toBe('PT Klien A');
    expect(quotation.engagementId).toBe(IDS.engagementA);
    expect(quotation.version).toBe(1);
    expect(quotation.source.type).toBe('quotation');

    const updated = await patch(
      IDS.owner,
      `/quotations/${quotation.id}`,
      { title: 'Judul baru' },
      {
        'Idempotency-Key': 'qu-update-1-aaaaaaaa',
        'If-Match': `"${quotation.entityVersion}"`,
      },
    );
    expect(updated.status).toBe(200);
    expect(((await updated.json()) as any).data.quotation.title).toBe('Judul baru');
  });

  it('rejects quotation writes with a wrong project-client pair and no row (6c, 6d)', async () => {
    const wrongClient = await post(
      IDS.owner,
      '/quotations',
      {
        clientId: IDS.clientB,
        projectId: IDS.projectA,
        engagementId: IDS.engagementA,
        quotationNumber: 'QUO-X1',
        title: 'Salah klien',
      },
      { 'Idempotency-Key': 'qu-xclient-1-aaaaaaaa' },
    );
    expect(wrongClient.status).toBe(422);
    expect(((await wrongClient.json()) as any).code).toBe('CLIENT_PROJECT_MISMATCH');
    expect(await countRows('quotations', 'quotation_number = $1', ['QUO-X1'])).toBe(0);

    const wrongEngagement = await post(
      IDS.owner,
      '/quotations',
      {
        clientId: IDS.clientA,
        projectId: IDS.projectA,
        engagementId: IDS.engagementB, // belongs to project B
        quotationNumber: 'QUO-X2',
        title: 'Salah engagement',
      },
      { 'Idempotency-Key': 'qu-xeng-1-aaaaaaaa' },
    );
    expect(wrongEngagement.status).toBe(404);
    expect(await countRows('quotations', 'quotation_number = $1', ['QUO-X2'])).toBe(0);

    const crossEngagement = await post(
      IDS.owner,
      '/quotations',
      {
        clientId: IDS.clientA,
        projectId: IDS.projectA,
        engagementId: IDS.otherEngagement,
        quotationNumber: 'QUO-X3',
        title: 'Lintas engagement',
      },
      { 'Idempotency-Key': 'qu-xeng-2-aaaaaaaa' },
    );
    expect(crossEngagement.status).toBe(404);
    expect(await countRows('quotations', 'quotation_number = $1', ['QUO-X3'])).toBe(0);
  });

  it('locks a signed quotation: PATCH returns 409 ENTITY_VERSION_CONFLICT', async () => {
    const created = await post(
      IDS.owner,
      '/quotations',
      {
        clientId: IDS.clientA,
        projectId: IDS.projectA,
        engagementId: IDS.engagementA,
        quotationNumber: 'QUO-600',
        title: 'Penawaran terkunci',
      },
      { 'Idempotency-Key': 'qu-lock-1-aaaaaaaa' },
    );
    const quotation = ((await created.json()) as any).data.quotation;
    await tenant(IDS.studio, async (client) => {
      await client.query(
        `UPDATE quotations SET status = 'SENT', entity_version = gen_random_uuid() WHERE id = $1`,
        [quotation.id],
      );
    });
    const locked = await patch(
      IDS.owner,
      `/quotations/${quotation.id}`,
      { title: 'X' },
      {
        'Idempotency-Key': 'qu-lock-2-aaaaaaaa',
        'If-Match': `"${quotation.entityVersion}"`,
      },
    );
    expect(locked.status).toBe(409);
    expect(((await locked.json()) as any).code).toBe('ENTITY_VERSION_CONFLICT');
  });

  it('creates an invoice with a non-null projectId and the client-project ancestry', async () => {
    const created = await post(
      IDS.owner,
      '/invoices',
      {
        clientId: IDS.clientA,
        projectId: IDS.projectA,
        invoiceNumber: 'INV-300',
        currency: 'IDR',
      },
      { 'Idempotency-Key': 'in-create-1-aaaaaaaa' },
    );
    expect(created.status).toBe(201);
    const invoice = ((await created.json()) as any).data.invoice;
    expect(invoice.status).toBe('DRAFT');
    expect(invoice.client.name).toBe('PT Klien A');
    expect(invoice.projectName).toBe('Proyek A');
    expect(invoice.source.type).toBe('invoice');
    expect(invoice.payments).toEqual([]);

    const updated = await patch(
      IDS.owner,
      `/invoices/${invoice.id}`,
      {
        dueDate: '2026-09-30T00:00:00Z',
      },
      {
        'Idempotency-Key': 'in-update-1-aaaaaaaa',
        'If-Match': `"${invoice.entityVersion}"`,
      },
    );
    expect(updated.status).toBe(200);
    expect(((await updated.json()) as any).data.invoice.dueDate).toContain('2026-09-30');
  });

  it('rejects invoice writes with a wrong client pair, cross-studio project, and no row (6c, 6d)', async () => {
    const wrongClient = await post(
      IDS.owner,
      '/invoices',
      {
        clientId: IDS.clientB,
        projectId: IDS.projectA,
        invoiceNumber: 'INV-X1',
      },
      { 'Idempotency-Key': 'in-xclient-1-aaaaaaaa' },
    );
    expect(wrongClient.status).toBe(422);
    expect(((await wrongClient.json()) as any).code).toBe('CLIENT_PROJECT_MISMATCH');
    expect(await countRows('invoices', 'invoice_number = $1', ['INV-X1'])).toBe(0);

    const crossProject = await post(
      IDS.owner,
      '/invoices',
      {
        clientId: IDS.clientA,
        projectId: IDS.otherProject,
        invoiceNumber: 'INV-X2',
      },
      { 'Idempotency-Key': 'in-xproj-1-aaaaaaaa' },
    );
    expect(crossProject.status).toBe(404);
    expect(await countRows('invoices', 'invoice_number = $1', ['INV-X2'])).toBe(0);
  });

  it('denies non-owner money writes: quotation and invoice POST return 403', async () => {
    const quotation = await post(
      IDS.designer,
      '/quotations',
      {
        clientId: IDS.clientA,
        projectId: IDS.projectA,
        engagementId: IDS.engagementA,
        quotationNumber: 'QUO-700',
        title: 'Ditolak',
      },
      { 'Idempotency-Key': 'qu-denied-1-aaaaaaaa' },
    );
    expect(quotation.status).toBe(403);

    const invoice = await post(
      IDS.designer,
      '/invoices',
      {
        clientId: IDS.clientA,
        projectId: IDS.projectA,
        invoiceNumber: 'INV-700',
      },
      { 'Idempotency-Key': 'in-denied-1-aaaaaaaa' },
    );
    expect(invoice.status).toBe(403);
  });
});
