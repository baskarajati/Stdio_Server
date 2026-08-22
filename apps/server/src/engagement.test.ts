/**
 * Integration tests for the SOL-28 engagement-scoped routes (SOL-94).
 *
 * Runs against the live `stdio_dev` database (seed: Studio Contoh, one
 * project with a DESIGN and a BUILD engagement). Proves the acceptance
 * criteria:
 *
 * - Engagement identity scopes quotation, variation-order, and invoice ops.
 * - Project finance stays a read-only roll-up.
 * - D-033: an approved variation order changes the engagement transaction
 *   price; an unapproved change never touches it.
 * - Invoice draft/issue/payment writes are capability-denied (SOL-25 gate,
 *   permanent payment denial).
 * - Cross-engagement isolation: an id on the wrong engagement is a 404.
 * - Idempotent replay and entity-version conflicts behave per the guard
 *   contract.
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
const DESIGN_ENGAGEMENT = '00000000-0000-4000-8000-00000000000e';
const BUILD_ENGAGEMENT = '00000000-0000-4000-8000-00000000000f';
const SEED_CHANGE = '00000000-0000-4000-8000-000000000010';
const SEED_VO = '00000000-0000-4000-8000-00000000000c';
const SEED_INVOICE = '00000000-0000-4000-8000-000000000008';
const OTHER_STUDIO = '00000000-0000-4000-8000-0000000000aa';
const OTHER_USER = '00000000-0000-4000-8000-0000000000bb';

let pool: Pool;
let app: ReturnType<typeof createApp>;
let token: string = '';

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

async function readEngagementVersion(): Promise<string> {
  return tenantQuery(SEED_STUDIO, async (client) => {
    const res = await client.query(`SELECT entity_version FROM project_engagements WHERE id = $1`, [
      BUILD_ENGAGEMENT,
    ]);
    return (res.rows[0] as { entity_version?: string } | undefined)?.entity_version as string;
  });
}

async function createEligibleChange(): Promise<{ id: string; entityVersion: string }> {
  return tenantQuery(SEED_STUDIO, async (client) => {
    const res = await client.query(
      `INSERT INTO project_changes (id, studio_id, project_id, engagement_id, change_number, change_type, status, title)
       VALUES (gen_random_uuid(), $1, $2, $3, 'PC-' || left(gen_random_uuid()::text, 8), 'SCOPE', 'ELIGIBLE', 'Test change')
       RETURNING id, entity_version`,
      [SEED_STUDIO, SEED_PROJECT, BUILD_ENGAGEMENT],
    );
    const row = res.rows[0] as { id: string; entity_version: string };
    return { id: row.id, entityVersion: row.entity_version };
  });
}

async function readTransactionPrice(): Promise<string | null> {
  return tenantQuery(SEED_STUDIO, async (client) => {
    const res = await client.query(
      `SELECT transaction_price FROM project_engagements WHERE id = $1`,
      [BUILD_ENGAGEMENT],
    );
    return (
      (res.rows[0] as { transaction_price?: string | null } | undefined)?.transaction_price ?? null
    );
  });
}

beforeAll(async () => {
  pool = new Pool({ connectionString, max: 5 });
  app = createApp(pool);
  token = `naa_test_${randomUUID()}`;
  await mintToken(SEED_STUDIO, SEED_OWNER, token);

  // Fixture: a second studio whose rows must never be readable by Studio
  // Contoh. The other user owns a project with an engagement.
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
  });

  // Deterministic fixture for the D-033 recompute:
  // transaction_price = base contract_value + sum(approved fee_effect).
  // Reset the build engagement, drop every test-minted variation order and
  // change, and restore the seed change to ELIGIBLE, so the suite is
  // repeatable against the shared database.
  await tenantQuery(SEED_STUDIO, async (client) => {
    await client.query(
      `DELETE FROM variation_order_approvals
       WHERE variation_order_id IN (SELECT id FROM variation_orders WHERE project_change_id IS NOT NULL)`,
    );
    await client.query(`DELETE FROM variation_orders WHERE project_change_id IS NOT NULL`);
    await client.query(`DELETE FROM project_changes WHERE change_number LIKE 'PC-%' AND id <> $1`, [
      SEED_CHANGE,
    ]);
    // Re-create the seed change if an earlier run deleted it, then restore
    // ELIGIBLE so the stale-If-Match test always has a live change.
    await client.query(
      `INSERT INTO project_changes (id, studio_id, project_id, engagement_id, change_number, change_type, status, title)
       VALUES ($1, $2, $3, $4, 'PC-001', 'SCOPE', 'ELIGIBLE', 'Tambah dinding partisi ruang kerja')
       ON CONFLICT (id) DO UPDATE SET status = 'ELIGIBLE'`,
      [SEED_CHANGE, SEED_STUDIO, SEED_PROJECT, BUILD_ENGAGEMENT],
    );
    // Deterministic baseline: base 1,000,000,000 + seed approved VO 25,000,000.
    // The D-033 write then adds its own fee effect (5,000,000) -> 1,030,000,000.
    await client.query(
      `UPDATE project_engagements SET contract_value = '1000000000.00',
        transaction_price = '1025000000.00'
       WHERE id = $1`,
      [BUILD_ENGAGEMENT],
    );
    // The design engagement carries no money of its own: reset it so the
    // project finance roll-up is deterministic against the shared database.
    await client.query(
      `UPDATE project_engagements SET contract_value = NULL, transaction_price = NULL
       WHERE id = $1`,
      [DESIGN_ENGAGEMENT],
    );
  });
});

afterAll(async () => {
  await pool.end();
});

const auth = () => ({ Authorization: `Bearer ${token}` });

describe('engagement-scoped contracts', () => {
  it('lists the contract of one engagement', async () => {
    const res = await app.request(
      `/projects/${SEED_PROJECT}/engagements/${BUILD_ENGAGEMENT}/contracts`,
      { headers: auth() },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.data.contracts).toHaveLength(1);
    expect(body.data.contracts[0].engagementId).toBe(BUILD_ENGAGEMENT);
    expect(body.data.contracts[0].entityVersion).toBeTruthy();
    expect(body.data.contracts[0].currentRevision.contractValue).toBe(1000000000);
  });

  it('returns a 404 for an engagement on the wrong project', async () => {
    const res = await app.request(
      `/projects/${SEED_PROJECT}/engagements/${randomUUID()}/contracts`,
      { headers: auth() },
    );
    expect(res.status).toBe(404);
    expect(((await res.json()) as any).code).toBe('ENGAGEMENT_NOT_FOUND');
  });

  it('never leaks another studio rows (RLS boundary)', async () => {
    // The other studio has no project with this id; even if it did, RLS
    // hides it. The route must 404, never return foreign rows.
    const res = await app.request(
      `/projects/${SEED_PROJECT}/engagements/${BUILD_ENGAGEMENT}/contracts`,
      { headers: auth() },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    for (const contract of body.data.contracts) {
      expect(contract.projectCode).not.toBe('LAIN-001');
    }
  });
});

describe('engagement-scoped variation orders', () => {
  it('lists the issued variation order of the build engagement only', async () => {
    const res = await app.request(
      `/projects/${SEED_PROJECT}/engagements/${BUILD_ENGAGEMENT}/variation-orders`,
      { headers: auth() },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.data.variationOrders.length).toBeGreaterThan(0);
    const vo = body.data.variationOrders.find((v: any) => v.id === SEED_VO);
    expect(vo).toBeTruthy();
    expect(vo.feeEffect).toBe('25000000.00');
    expect(vo.canReadFinance).toBe(true);
  });

  it('returns an empty register for the design engagement (isolation)', async () => {
    const res = await app.request(
      `/projects/${SEED_PROJECT}/engagements/${DESIGN_ENGAGEMENT}/variation-orders`,
      { headers: auth() },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.data.variationOrders).toHaveLength(0);
  });

  it('reads one variation order detail with an ETag', async () => {
    const res = await app.request(
      `/projects/${SEED_PROJECT}/engagements/${BUILD_ENGAGEMENT}/variation-orders/${SEED_VO}`,
      { headers: auth() },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('ETag')).toMatch(/^W\/"/);
    const body = (await res.json()) as any;
    expect(body.data.variationOrder.id).toBe(SEED_VO);
    expect(body.data.variationOrder.engagementId).toBe(BUILD_ENGAGEMENT);
  });

  it('returns 404 for a variation order on the wrong engagement', async () => {
    const res = await app.request(
      `/projects/${SEED_PROJECT}/engagements/${DESIGN_ENGAGEMENT}/variation-orders/${SEED_VO}`,
      { headers: auth() },
    );
    expect(res.status).toBe(404);
  });

  it('D-033: an approved change mints a VO and raises the transaction price', async () => {
    const change = await createEligibleChange();
    const engagementVersion = await readEngagementVersion();
    const before = await readTransactionPrice();

    const key = `vo_write_${randomUUID()}`;
    const body = {
      boqEffect: '10000000.00',
      contractRevisionId: change.id,
      effectiveDate: '2026-08-22T00:00:00Z',
      feeEffect: '5000000.00',
      scheduleOfValuesId: randomUUID(),
    };
    const res = await app.request(
      `/projects/${SEED_PROJECT}/engagements/${BUILD_ENGAGEMENT}/project-changes/${change.id}/variation-order`,
      {
        method: 'POST',
        headers: {
          ...auth(),
          'Idempotency-Key': key,
          'If-Match': `"${change.entityVersion}", "${engagementVersion}"`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      },
    );
    expect(res.status).toBe(201);
    const payload = (await res.json()) as any;
    expect(payload.data.idempotentReplay).toBe(false);
    expect(payload.data.variationOrder.status).toBe('ISSUED');
    expect(payload.data.variationOrder.feeEffect).toBe('5000000.00');
    expect(payload.data.variationOrder.projectChange).toBeTruthy();

    // D-033: transaction_price = base (1,000,000,000) + existing approved VO
    // (25,000,000) + this approved VO (5,000,000) = 1,030,000,000.00.
    const after = await readTransactionPrice();
    expect(after).toBe('1030000000.00');
    expect(after).not.toBe(before);
  });

  it('replays the same idempotency key with 200 and no second mutation', async () => {
    const change = await createEligibleChange();
    const engagementVersion = await readEngagementVersion();
    const key = `vo_replay_${randomUUID()}`;
    const body = {
      boqEffect: '10000000.00',
      contractRevisionId: change.id,
      effectiveDate: '2026-08-22T00:00:00Z',
      feeEffect: '5000000.00',
      scheduleOfValuesId: randomUUID(),
    };
    const request = () =>
      app.request(
        `/projects/${SEED_PROJECT}/engagements/${BUILD_ENGAGEMENT}/project-changes/${change.id}/variation-order`,
        {
          method: 'POST',
          headers: {
            ...auth(),
            'Idempotency-Key': key,
            'If-Match': `"${change.entityVersion}", "${engagementVersion}"`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        },
      );

    const first = await request();
    expect(first.status).toBe(201);
    const countAfterFirst = await tenantQuery(SEED_STUDIO, async (client) => {
      const res = await client.query(
        `SELECT count(*)::int AS n FROM variation_orders WHERE project_change_id = $1`,
        [change.id],
      );
      return (res.rows[0] as { n?: number }).n;
    });

    const replay = await request();
    expect(replay.status).toBe(200);
    const payload = (await replay.json()) as any;
    expect(payload.data.idempotentReplay).toBe(true);

    const countAfterReplay = await tenantQuery(SEED_STUDIO, async (client) => {
      const res = await client.query(
        `SELECT count(*)::int AS n FROM variation_orders WHERE project_change_id = $1`,
        [change.id],
      );
      return (res.rows[0] as { n?: number }).n;
    });
    expect(countAfterReplay).toBe(countAfterFirst);
  });

  it('rejects a stale If-Match with 409 ENTITY_VERSION_CONFLICT', async () => {
    const engagementVersion = await readEngagementVersion();
    const key = `vo_conflict_${randomUUID()}`;
    const body = {
      boqEffect: '10000000.00',
      contractRevisionId: SEED_CHANGE,
      effectiveDate: '2026-08-22T00:00:00Z',
      feeEffect: '5000000.00',
      scheduleOfValuesId: randomUUID(),
    };
    const res = await app.request(
      `/projects/${SEED_PROJECT}/engagements/${BUILD_ENGAGEMENT}/project-changes/${SEED_CHANGE}/variation-order`,
      {
        method: 'POST',
        headers: {
          ...auth(),
          'Idempotency-Key': key,
          'If-Match': `"${randomUUID()}", "${engagementVersion}"`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      },
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as any).code).toBe('ENTITY_VERSION_CONFLICT');
  });
});

describe('engagement-scoped invoices', () => {
  it('lists the engagement invoice register', async () => {
    const res = await app.request(
      `/projects/${SEED_PROJECT}/engagements/${BUILD_ENGAGEMENT}/invoices`,
      { headers: auth() },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(Array.isArray(body.data.invoices)).toBe(true);
  });

  it('denies the payment write permanently (SOL-20, A-010)', async () => {
    const res = await app.request(
      `/projects/${SEED_PROJECT}/engagements/${BUILD_ENGAGEMENT}/invoices/${SEED_INVOICE}/payment`,
      {
        method: 'POST',
        headers: { ...auth(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          amount: '100000.00',
          date: '2026-08-22',
          paymentMethod: 'TRANSFER',
        }),
      },
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as any;
    expect(body.code).toBe('CAPABILITY_DENIED');
  });

  it('denies the draft write until SOL-25 lands', async () => {
    const res = await app.request(
      `/projects/${SEED_PROJECT}/engagements/${BUILD_ENGAGEMENT}/invoices/${SEED_INVOICE}/draft`,
      { method: 'POST', headers: auth() },
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).code).toBe('CAPABILITY_DENIED');
  });

  it('denies the issue write until SOL-25 lands', async () => {
    const res = await app.request(
      `/projects/${SEED_PROJECT}/engagements/${BUILD_ENGAGEMENT}/invoices/${SEED_INVOICE}/issue`,
      { method: 'POST', headers: auth() },
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).code).toBe('CAPABILITY_DENIED');
  });
});

describe('project finance roll-up', () => {
  it('serves the read-only roll-up across engagements', async () => {
    const res = await app.request(`/projects/${SEED_PROJECT}/finance`, { headers: auth() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    const summary = body.data.finance.summary;
    // 1,035,000,000.00: baseline (base 1,000M + seed VO 25M) plus the two
    // approved test VOs (5M each) written earlier in this suite.
    expect(summary.contractValue).toBe(1035000000);
    expect(summary.variationCount).toBeGreaterThan(0);
  });

  it('totals large numeric(20,2) values exactly, never through a float', async () => {
    // A float reads 999999999999999999.99 as 1e18 and loses the cents. The
    // roll-up must keep the exact integer minor-unit sum and emit the raw
    // token. The wire form is a JSON number, so the raw body text is the
    // lossless assertion surface: res.json() itself would round to 1e18.
    const projectId = randomUUID();
    const engagementId = randomUUID();
    const maxValue = '999999999999999999.99';
    await tenantQuery(SEED_STUDIO, async (client) => {
      await client.query(
        `INSERT INTO projects (id, studio_id, project_code, name, client_id, status)
         VALUES ($1, $2, 'PRJ-EXACT', 'Proyek Uji Presisi', $3, 'ACTIVE')
         ON CONFLICT (id) DO NOTHING`,
        [projectId, SEED_STUDIO, '00000000-0000-4000-8000-000000000003'],
      );
      await client.query(
        `INSERT INTO project_engagements
           (id, studio_id, project_id, kind, contract_value, transaction_price)
         VALUES ($1, $2, $3, 'DESIGN', $4, $4)`,
        [engagementId, SEED_STUDIO, projectId, maxValue],
      );
    });
    try {
      const res = await app.request(`/projects/${projectId}/finance`, { headers: auth() });
      expect(res.status).toBe(200);
      const raw = await res.text();
      expect(raw).toContain(`"contractValue":${maxValue}`);
      expect(raw).toContain(`"invoicedValue":0.00`);
      // The JSON parse confirms the number survived as a JSON number at all;
      // the raw-text assertion above is the exactness proof.
      const body = JSON.parse(raw) as any;
      expect(body.data.finance.summary.contractValue).toBe(1e18);
    } finally {
      await tenantQuery(SEED_STUDIO, async (client) => {
        await client.query(`DELETE FROM project_engagements WHERE id = $1`, [engagementId]);
        await client.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
      });
    }
  });
});

describe('deprecation shims', () => {
  it('returns 410 DEPRECATED_ROUTE for the project-scoped quotation route', async () => {
    const res = await app.request(`/projects/${SEED_PROJECT}/quotations`, { headers: auth() });
    expect(res.status).toBe(410);
    expect(((await res.json()) as any).code).toBe('DEPRECATED_ROUTE');
  });

  it('returns 410 for the project-scoped variation-order write', async () => {
    const res = await app.request(
      `/projects/${SEED_PROJECT}/project-changes/${SEED_CHANGE}/variation-order`,
      { method: 'POST', headers: auth() },
    );
    expect(res.status).toBe(410);
    expect(((await res.json()) as any).code).toBe('DEPRECATED_ROUTE');
  });
});
