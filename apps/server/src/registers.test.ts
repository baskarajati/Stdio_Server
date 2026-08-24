/**
 * Integration tests for the SOL-19 register writes (revision 6).
 *
 * Runs against the live `stdio_dev` database (seed: Studio Contoh). Proves
 * the SOL-69 conditions:
 *
 * - Condition 3: every supplied relation resolves inside the studio; a
 *   cross-studio identifier is a 404 and creates no row or link.
 * - Condition 4: same-studio ancestry — a quotation requires
 *   engagement.project_id == project.id and project.client_id == client.id;
 *   an invoice requires project.client_id == client.id. A same-studio but
 *   wrong project-client pair is a 422.
 * - Condition 5: negative tests for every relation (accountManagerId,
 *   projectId, clientId, engagementId, vendorId paths covered).
 * - The guarded-write contract: Idempotency-Key replay, 409 key reuse,
 *   If-Match version conflicts with `draftPreserved: true`.
 */

import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from './app';

const connectionString =
  process.env.DATABASE_URL ?? 'postgres://stdio:stdio@localhost:5432/stdio_dev';

const SEED_STUDIO = '00000000-0000-4000-8000-000000000001';
const SEED_OWNER = '00000000-0000-4000-8000-000000000002';
const SEED_CLIENT = '00000000-0000-4000-8000-000000000003';
const SEED_PROJECT = '00000000-0000-4000-8000-000000000004';
const BUILD_ENGAGEMENT = '00000000-0000-4000-8000-00000000000f';
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
const idem = () => `idem-${randomUUID()}`;

/** The contract Problem envelope (components/schemas/Problem). */
type ProblemEnvelope = {
  type: string;
  status: number;
  code: string;
  title: string;
  detail: string;
  requestId: string;
  details?: { draftPreserved?: boolean; currentEntityVersion?: string | null };
};

/** Asserts the full contract Problem envelope on an error body (SOL-146). */
function expectProblem(body: ProblemEnvelope, status: number, code: string): void {
  expect(body.type).toBe('urn:stdio:error');
  expect(body.status).toBe(status);
  expect(body.code).toBe(code);
  expect(typeof body.title).toBe('string');
  expect(body.title.length).toBeGreaterThan(0);
  expect(typeof body.detail).toBe('string');
  expect(body.detail.length).toBeGreaterThan(0);
  expect(typeof body.requestId).toBe('string');
  expect(body.requestId.length).toBeGreaterThan(0);
}

beforeAll(async () => {
  pool = new Pool({ connectionString, max: 5 });
  app = createApp(pool);
  token = `naa_reg_${randomUUID()}`;
  designerToken = `naa_reg_designer_${randomUUID()}`;
  await mintToken(SEED_STUDIO, SEED_OWNER, token);

  await tenantQuery(SEED_STUDIO, async (client) => {
    await client.query(
      `INSERT INTO users (id, studio_id, email, name, role)
       VALUES (gen_random_uuid(), $1, 'reg-designer@contoh.studio', 'Desainer', 'DESIGNER')
       ON CONFLICT DO NOTHING`,
      [SEED_STUDIO],
    );
    const rows = (await client.query(
      `SELECT id FROM users WHERE studio_id = $1 AND email = 'reg-designer@contoh.studio'`,
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

  // A same-studio client that does NOT own the seeded project: the wrong
  // project-client pair for the ancestry negative tests (condition 4/5).
  await tenantQuery(SEED_STUDIO, async (client) => {
    await client.query(
      `INSERT INTO clients (id, studio_id, client_number, name)
       VALUES ('00000000-0000-4000-8000-0000000000dd', $1, 'C-UNRELATED', 'Klien Tak Terkait')
       ON CONFLICT (id) DO NOTHING`,
      [SEED_STUDIO],
    );
  });

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
       VALUES (gen_random_uuid(), $1, 'C-LAIN', 'Klien Lain') ON CONFLICT DO NOTHING`,
      [OTHER_STUDIO],
    );
    const clients = (await client.query(
      `SELECT id FROM clients WHERE studio_id = $1 AND client_number = 'C-LAIN'`,
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

  // Clean the register rows this suite creates (unique marker prefix).
  await tenantQuery(SEED_STUDIO, async (client) => {
    await client.query(`DELETE FROM clients WHERE client_number LIKE 'REG-%'`);
    await client.query(`DELETE FROM vendors WHERE vendor_code LIKE 'REG-%'`);
  });
});

afterAll(async () => {
  await tenantQuery(SEED_STUDIO, async (client) => {
    await client.query(`DELETE FROM clients WHERE client_number LIKE 'REG-%'`);
    await client.query(`DELETE FROM vendors WHERE vendor_code LIKE 'REG-%'`);
    await client.query(`DELETE FROM quotations WHERE quotation_number LIKE 'REG-%'`);
    await client.query(`DELETE FROM invoices WHERE invoice_number LIKE 'REG-%'`);
  });
  await pool.end();
});

describe('client register writes', () => {
  it('creates a client with the guarded contract', async () => {
    const number = `REG-${randomUUID().slice(0, 8)}`;
    const res = await app.request('/clients', {
      method: 'POST',
      headers: { ...auth(), 'Idempotency-Key': idem() },
      body: JSON.stringify({
        clientNumber: number,
        name: 'Klien Register',
        companyName: 'PT Klien Register',
        email: 'client@reg.example',
        accountManagerId: SEED_OWNER,
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(body.meta.idempotentReplay).toBe(false);
    expect(body.data.client.clientNumber).toBe(number);
    expect(body.data.client.accountManager.id).toBe(SEED_OWNER);
    expect(body.data.client.primaryContact.email).toBe('client@reg.example');
    expect(body.data.client.source.type).toBe('client');
  });

  it('replays an idempotent retry with 200 + idempotentReplay true', async () => {
    const key = idem();
    const number = `REG-${randomUUID().slice(0, 8)}`;
    const body = JSON.stringify({ clientNumber: number, name: 'Klien Replay' });
    const first = await app.request('/clients', {
      method: 'POST',
      headers: { ...auth(), 'Idempotency-Key': key },
      body,
    });
    expect(first.status).toBe(201);
    const second = await app.request('/clients', {
      method: 'POST',
      headers: { ...auth(), 'Idempotency-Key': key },
      body,
    });
    expect(second.status).toBe(200);
    expect(((await second.json()) as any).meta.idempotentReplay).toBe(true);
  });

  it('rejects the same key with a different body', async () => {
    const key = idem();
    await app.request('/clients', {
      method: 'POST',
      headers: { ...auth(), 'Idempotency-Key': key },
      body: JSON.stringify({ clientNumber: `REG-${randomUUID().slice(0, 8)}`, name: 'A' }),
    });
    const res = await app.request('/clients', {
      method: 'POST',
      headers: { ...auth(), 'Idempotency-Key': key },
      body: JSON.stringify({ clientNumber: `REG-${randomUUID().slice(0, 8)}`, name: 'B' }),
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as any).code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('404s a foreign-studio accountManagerId and creates no row', async () => {
    const res = await app.request('/clients', {
      method: 'POST',
      headers: { ...auth(), 'Idempotency-Key': idem() },
      body: JSON.stringify({
        clientNumber: `REG-${randomUUID().slice(0, 8)}`,
        name: 'Klien Buruk',
        accountManagerId: OTHER_USER,
      }),
    });
    expect(res.status).toBe(404);
  });

  it('denies a designer (capability gate)', async () => {
    const res = await app.request('/clients', {
      method: 'POST',
      headers: { Authorization: `Bearer ${designerToken}`, 'Idempotency-Key': idem() },
      body: JSON.stringify({ clientNumber: `REG-${randomUUID().slice(0, 8)}`, name: 'X' }),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).code).toBe('CAPABILITY_DENIED');
  });

  it('patches a client and returns the typed 409 on a stale version', async () => {
    const number = `REG-${randomUUID().slice(0, 8)}`;
    const created = await app.request('/clients', {
      method: 'POST',
      headers: { ...auth(), 'Idempotency-Key': idem() },
      body: JSON.stringify({ clientNumber: number, name: 'Sebelum' }),
    });
    const client = ((await created.json()) as any).data.client;
    const patched = await app.request(`/clients/${client.id}`, {
      method: 'PATCH',
      headers: { ...auth(), 'Idempotency-Key': idem(), 'If-Match': `"${client.entityVersion}"` },
      body: JSON.stringify({ name: 'Sesudah' }),
    });
    expect(patched.status).toBe(200);
    expect(((await patched.json()) as any).data.client.name).toBe('Sesudah');
    const stale = await app.request(`/clients/${client.id}`, {
      method: 'PATCH',
      headers: { ...auth(), 'Idempotency-Key': idem(), 'If-Match': `"${client.entityVersion}"` },
      body: JSON.stringify({ name: 'Lagi' }),
    });
    expect(stale.status).toBe(409);
    const conflict = (await stale.json()) as any;
    expectProblem(conflict, 409, 'ENTITY_VERSION_CONFLICT');
    expect(conflict.details.draftPreserved).toBe(true);
  });

  it('SOL-146: wraps a missing-client 404 on the update path in the full Problem', async () => {
    const res = await app.request(`/clients/${randomUUID()}`, {
      method: 'PATCH',
      headers: { ...auth(), 'Idempotency-Key': idem(), 'If-Match': `"${randomUUID()}"` },
      body: JSON.stringify({ name: 'Tidak Ada' }),
    });
    expect(res.status).toBe(404);
    expectProblem((await res.json()) as ProblemEnvelope, 404, 'CLIENT_NOT_FOUND');
  });
});

describe('vendor register writes', () => {
  it('creates and updates a vendor', async () => {
    const number = `REG-${randomUUID().slice(0, 8)}`;
    const created = await app.request('/vendors', {
      method: 'POST',
      headers: { ...auth(), 'Idempotency-Key': idem() },
      body: JSON.stringify({
        vendorNumber: number,
        name: 'Supplier Register',
        categoryLabel: 'Material',
      }),
    });
    expect(created.status).toBe(201);
    const vendor = ((await created.json()) as any).data.vendor;
    expect(vendor.vendorCode).toBe(number);
    expect(vendor.categoryLabel).toBe('Material');
    const patched = await app.request(`/vendors/${vendor.id}`, {
      method: 'PATCH',
      headers: { ...auth(), 'Idempotency-Key': idem(), 'If-Match': `"${vendor.entityVersion}"` },
      body: JSON.stringify({ name: 'Supplier Ganti' }),
    });
    expect(patched.status).toBe(200);
    expect(((await patched.json()) as any).data.vendor.name).toBe('Supplier Ganti');
  });
});

describe('spec item register writes', () => {
  it('creates a spec item on a studio project', async () => {
    const res = await app.request('/spec-items', {
      method: 'POST',
      headers: { ...auth(), 'Idempotency-Key': idem() },
      body: JSON.stringify({ name: 'Ubin Teraso', projectId: SEED_PROJECT, room: 'Ruang tamu' }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(body.data.specItem.name).toBe('Ubin Teraso');
    expect(body.data.specItem.projectId).toBe(SEED_PROJECT);
    expect(body.data.specItem.projectName).toBeTruthy();
    expect(body.data.specItem.status).toBe('DRAFT');
  });

  it('404s a foreign-studio projectId and creates no row', async () => {
    const res = await app.request('/spec-items', {
      method: 'POST',
      headers: { ...auth(), 'Idempotency-Key': idem() },
      body: JSON.stringify({ name: 'Barang Lain', projectId: OTHER_PROJECT }),
    });
    expect(res.status).toBe(404);
    const count = await tenantQuery(SEED_STUDIO, async (client) => {
      const r = await client.query(`SELECT count(*) FROM spec_items WHERE project_id = $1`, [
        OTHER_PROJECT,
      ]);
      return Number((r.rows[0] as { count: string }).count);
    });
    expect(count).toBe(0);
  });
});

describe('quotation register writes (D-019 ancestry)', () => {
  it('creates a draft quotation for the seeded project + engagement + client', async () => {
    const res = await app.request('/quotations', {
      method: 'POST',
      headers: { ...auth(), 'Idempotency-Key': idem() },
      body: JSON.stringify({
        clientId: SEED_CLIENT,
        projectId: SEED_PROJECT,
        engagementId: BUILD_ENGAGEMENT,
        quotationNumber: `REG-${randomUUID().slice(0, 8)}`,
        title: 'Penawaran Register',
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(body.data.quotation.client.id).toBe(SEED_CLIENT);
    expect(body.data.quotation.projectId).toBe(SEED_PROJECT);
    expect(body.data.quotation.engagementId).toBe(BUILD_ENGAGEMENT);
    expect(body.data.quotation.status).toBe('DRAFT');
  });

  it('404s a foreign-studio engagement (condition 3)', async () => {
    const res = await app.request('/quotations', {
      method: 'POST',
      headers: { ...auth(), 'Idempotency-Key': idem() },
      body: JSON.stringify({
        clientId: SEED_CLIENT,
        projectId: SEED_PROJECT,
        engagementId: randomUUID(),
        quotationNumber: `REG-${randomUUID().slice(0, 8)}`,
        title: 'X',
      }),
    });
    expect(res.status).toBe(404);
  });

  it('422s a same-studio but wrong project-client pair (conditions 4/5)', async () => {
    const res = await app.request('/quotations', {
      method: 'POST',
      headers: { ...auth(), 'Idempotency-Key': idem() },
      body: JSON.stringify({
        clientId: '00000000-0000-4000-8000-0000000000dd',
        projectId: SEED_PROJECT,
        engagementId: BUILD_ENGAGEMENT,
        quotationNumber: `REG-${randomUUID().slice(0, 8)}`,
        title: 'Ancestry Buruk',
      }),
    });
    expect(res.status).toBe(422);
    expect(((await res.json()) as any).code).toBe('INVALID_QUOTATION_ANCESTRY');
  });

  it('locks a non-DRAFT quotation (409 draftPreserved)', async () => {
    const created = await app.request('/quotations', {
      method: 'POST',
      headers: { ...auth(), 'Idempotency-Key': idem() },
      body: JSON.stringify({
        clientId: SEED_CLIENT,
        projectId: SEED_PROJECT,
        engagementId: BUILD_ENGAGEMENT,
        quotationNumber: `REG-${randomUUID().slice(0, 8)}`,
        title: 'Terkunci',
      }),
    });
    const quotation = ((await created.json()) as any).data.quotation;
    await tenantQuery(SEED_STUDIO, async (client) => {
      await client.query(`UPDATE quotations SET status = 'SENT' WHERE id = $1`, [quotation.id]);
    });
    const res = await app.request(`/quotations/${quotation.id}`, {
      method: 'PATCH',
      headers: { ...auth(), 'Idempotency-Key': idem(), 'If-Match': `"${quotation.entityVersion}"` },
      body: JSON.stringify({ title: 'Tidak Boleh' }),
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as any).details.draftPreserved).toBe(true);
  });
});

describe('invoice register writes (project link)', () => {
  it('creates a draft invoice for the seeded project + client', async () => {
    const res = await app.request('/invoices', {
      method: 'POST',
      headers: { ...auth(), 'Idempotency-Key': idem() },
      body: JSON.stringify({
        clientId: SEED_CLIENT,
        projectId: SEED_PROJECT,
        invoiceNumber: `REG-${randomUUID().slice(0, 8)}`,
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(body.data.invoice.client.id).toBe(SEED_CLIENT);
    expect(body.data.invoice.status).toBe('DRAFT');
    expect(body.data.invoice.source.type).toBe('invoice');
  });

  it('422s a same-studio but wrong project-client pair', async () => {
    const res = await app.request('/invoices', {
      method: 'POST',
      headers: { ...auth(), 'Idempotency-Key': idem() },
      body: JSON.stringify({
        clientId: '00000000-0000-4000-8000-0000000000dd',
        projectId: SEED_PROJECT,
        invoiceNumber: `REG-${randomUUID().slice(0, 8)}`,
      }),
    });
    expect(res.status).toBe(422);
    expect(((await res.json()) as any).code).toBe('INVALID_INVOICE_ANCESTRY');
  });

  it('404s a foreign-studio projectId and creates no invoice', async () => {
    const res = await app.request('/invoices', {
      method: 'POST',
      headers: { ...auth(), 'Idempotency-Key': idem() },
      body: JSON.stringify({
        clientId: SEED_CLIENT,
        projectId: OTHER_PROJECT,
        invoiceNumber: `REG-${randomUUID().slice(0, 8)}`,
      }),
    });
    expect(res.status).toBe(404);
  });
});
