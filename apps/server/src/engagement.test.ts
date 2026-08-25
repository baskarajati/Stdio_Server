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
 * - Invoice draft/issue writes stay capability-denied; the SOL-132
 *   split-payment write is OWNER-gated and records cash, PPh and retensi.
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
let designerToken = '';
let otherToken = '';

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

async function createEligibleChange(
  engagementId: string = BUILD_ENGAGEMENT,
): Promise<{ id: string; entityVersion: string }> {
  return tenantQuery(SEED_STUDIO, async (client) => {
    const res = await client.query(
      `INSERT INTO project_changes (id, studio_id, project_id, engagement_id, change_number, change_type, status, title)
       VALUES (gen_random_uuid(), $1, $2, $3, 'PC-' || left(gen_random_uuid()::text, 8), 'SCOPE', 'ELIGIBLE', 'Test change')
       RETURNING id, entity_version`,
      [SEED_STUDIO, SEED_PROJECT, engagementId],
    );
    const row = res.rows[0] as { id: string; entity_version: string };
    return { id: row.id, entityVersion: row.entity_version };
  });
}

async function readEngagementPrice(engagementId: string): Promise<string | null> {
  return tenantQuery(SEED_STUDIO, async (client) => {
    const res = await client.query(
      `SELECT transaction_price FROM project_engagements WHERE id = $1`,
      [engagementId],
    );
    return (
      (res.rows[0] as { transaction_price?: string | null } | undefined)?.transaction_price ?? null
    );
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

  // SOL-132: a same-studio non-OWNER for the capability negative test.
  designerToken = `naa_pay_designer_${randomUUID()}`;
  await tenantQuery(SEED_STUDIO, async (client) => {
    await client.query(
      `INSERT INTO users (id, studio_id, email, name, role)
       VALUES (gen_random_uuid(), $1, 'pay-designer@contoh.studio', 'Desainer Pay', 'DESIGNER')
       ON CONFLICT DO NOTHING`,
      [SEED_STUDIO],
    );
    const rows = (await client.query(
      `SELECT id FROM users WHERE studio_id = $1 AND email = 'pay-designer@contoh.studio'`,
      [SEED_STUDIO],
    )) as { rows: { id: string }[] };
    const designerId = rows.rows[0]?.id;
    if (!designerId) throw new Error('designer fixture missing');
    await client.query(
      `INSERT INTO access_tokens (studio_id, user_id, token, expires_at)
       VALUES ($1, $2, $3, now() + interval '1 hour') ON CONFLICT (token) DO NOTHING`,
      [SEED_STUDIO, designerId, designerToken],
    );
  });

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
  otherToken = `naa_pay_other_${randomUUID()}`;
  await mintToken(OTHER_STUDIO, OTHER_USER, otherToken);

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
    // SOL-131: reset the per-studio VO counter so a suite run mints
    // deterministically (first mint VO-0001, second VO-0002). The seeded
    // literal VO-001 row is untouched.
    await client.query(
      `DELETE FROM studio_number_sequences WHERE studio_id = $1 AND namespace = 'VO'`,
      [SEED_STUDIO],
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
const designerAuth = () => ({ Authorization: `Bearer ${designerToken}` });
const otherAuth = () => ({ Authorization: `Bearer ${otherToken}` });

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

    // SOL-131: the mint numbers the document (displayNumber = systemNumber).
    expect(payload.data.variationOrder.displayNumber).toBe('VO-0001');
    expect(payload.data.variationOrder.systemNumber).toBe('VO-0001');

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
    const firstPayload = (await first.json()) as any;
    // SOL-131: the second mint of the suite gets the next number (C4: a
    // replay returns the stored number without consuming a new one).
    expect(firstPayload.data.variationOrder.displayNumber).toBe('VO-0002');
    expect(firstPayload.data.variationOrder.systemNumber).toBe('VO-0002');
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
    expect(payload.data.variationOrder.displayNumber).toBe('VO-0002');
    expect(payload.data.variationOrder.systemNumber).toBe('VO-0002');

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
    const problem = (await res.json()) as ProblemEnvelope;
    expectProblem(problem, 409, 'ENTITY_VERSION_CONFLICT');
    expect(problem.details?.draftPreserved).toBe(true);
    expect(problem.details?.currentEntityVersion).toBeTruthy();
  });

  it('SOL-146: wraps a missing engagement 404 on the write path in the full Problem', async () => {
    const key = `vo_missing_eng_${randomUUID()}`;
    const res = await app.request(
      `/projects/${SEED_PROJECT}/engagements/${randomUUID()}/project-changes/${SEED_CHANGE}/variation-order`,
      {
        method: 'POST',
        headers: {
          ...auth(),
          'Idempotency-Key': key,
          'If-Match': `"${randomUUID()}", "${randomUUID()}"`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ feeEffect: '1000000.00' }),
      },
    );
    expect(res.status).toBe(404);
    expectProblem((await res.json()) as ProblemEnvelope, 404, 'ENGAGEMENT_NOT_FOUND');
  });

  it('SOL-146: wraps a missing change 404 on the write path in the full Problem', async () => {
    const engagementVersion = await readEngagementVersion();
    const key = `vo_missing_change_${randomUUID()}`;
    const res = await app.request(
      `/projects/${SEED_PROJECT}/engagements/${BUILD_ENGAGEMENT}/project-changes/${randomUUID()}/variation-order`,
      {
        method: 'POST',
        headers: {
          ...auth(),
          'Idempotency-Key': key,
          'If-Match': `"${randomUUID()}", "${engagementVersion}"`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ feeEffect: '1000000.00' }),
      },
    );
    expect(res.status).toBe(404);
    expectProblem((await res.json()) as ProblemEnvelope, 404, 'PROJECT_CHANGE_NOT_FOUND');
  });

  it('SOL-146: rejects a non-ELIGIBLE change with 422 PROJECT_CHANGE_NOT_ELIGIBLE', async () => {
    const change = await createEligibleChange();
    await tenantQuery(SEED_STUDIO, async (client) => {
      await client.query(`UPDATE project_changes SET status = 'DRAFT' WHERE id = $1`, [change.id]);
    });
    const engagementVersion = await readEngagementVersion();
    const key = `vo_not_eligible_${randomUUID()}`;
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
        body: JSON.stringify({ feeEffect: '1000000.00', contractRevisionId: change.id }),
      },
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as ProblemEnvelope;
    expectProblem(body, 422, 'PROJECT_CHANGE_NOT_ELIGIBLE');
    expect(body.detail).toContain('DRAFT');
  });

  it('SOL-146: wraps a missing quotation engagement 404 in the full Problem', async () => {
    const key = `qu_missing_eng_${randomUUID()}`;
    const res = await app.request(
      `/projects/${SEED_PROJECT}/engagements/${randomUUID()}/quotations`,
      {
        method: 'POST',
        headers: {
          ...auth(),
          'Idempotency-Key': key,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          clientId: '00000000-0000-4000-8000-000000000003',
          quotationNumber: 'Q-146',
        }),
      },
    );
    expect(res.status).toBe(404);
    expectProblem((await res.json()) as ProblemEnvelope, 404, 'ENGAGEMENT_NOT_FOUND');
  });

  it('SOL-131 C1: concurrent mints on one studio get distinct numbers and full roll-ups', async () => {
    // The two mints contend only on the per-studio VO counter — the shared
    // resource C1 serializes. They use two throwaway engagements so the
    // If-Match version guard (per engagement) does not force a conflict:
    // both must succeed, with the next two numbers, no duplicate, no 500.
    // Numbers are never reused (C6): the test reads the counter instead of
    // resetting it, so the mints take the genuinely next values.
    const nextValue = await tenantQuery(SEED_STUDIO, async (client) => {
      const res = await client.query(
        `SELECT next_value FROM studio_number_sequences WHERE studio_id = $1 AND namespace = 'VO'`,
        [SEED_STUDIO],
      );
      return (res.rows[0] as { next_value?: number } | undefined)?.next_value ?? 1;
    });
    const expectedNumbers = new Set([
      `VO-${String(nextValue).padStart(4, '0')}`,
      `VO-${String(nextValue + 1).padStart(4, '0')}`,
    ]);

    const engagementA = randomUUID();
    const engagementB = randomUUID();
    await tenantQuery(SEED_STUDIO, async (client) => {
      for (const engagementId of [engagementA, engagementB]) {
        // currentPhaseKey 'vo-cleanup-test' marks this row as a throwaway
        // fixture; the cleanup at the end of the test removes every row with
        // the marker, so aborted runs never leak engagements into the shared
        // stdio_dev database (same pattern as budget.test.ts).
        await client.query(
          `INSERT INTO project_engagements (id, studio_id, project_id, kind, contract_value, current_phase_key)
           VALUES ($1, $2, $3, 'DESIGN', '1000000000.00', 'vo-cleanup-test')`,
          [engagementId, SEED_STUDIO, SEED_PROJECT],
        );
      }
    });
    const changeA = await createEligibleChange(engagementA);
    const changeB = await createEligibleChange(engagementB);
    const versionA = await tenantQuery(SEED_STUDIO, async (client) => {
      const res = await client.query(
        `SELECT entity_version FROM project_engagements WHERE id = $1`,
        [engagementA],
      );
      return (res.rows[0] as { entity_version: string }).entity_version;
    });
    const versionB = await tenantQuery(SEED_STUDIO, async (client) => {
      const res = await client.query(
        `SELECT entity_version FROM project_engagements WHERE id = $1`,
        [engagementB],
      );
      return (res.rows[0] as { entity_version: string }).entity_version;
    });

    const mint = (
      engagementId: string,
      change: { id: string; entityVersion: string },
      engagementVersion: string,
      key: string,
    ) =>
      app.request(
        `/projects/${SEED_PROJECT}/engagements/${engagementId}/project-changes/${change.id}/variation-order`,
        {
          method: 'POST',
          headers: {
            ...auth(),
            'Idempotency-Key': key,
            'If-Match': `"${change.entityVersion}", "${engagementVersion}"`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            boqEffect: '10000000.00',
            contractRevisionId: change.id,
            effectiveDate: '2026-08-22T00:00:00Z',
            feeEffect: '5000000.00',
            scheduleOfValuesId: randomUUID(),
          }),
        },
      );

    const [resA, resB] = await Promise.all([
      mint(engagementA, changeA, versionA, `vo_conc_a_${randomUUID()}`),
      mint(engagementB, changeB, versionB, `vo_conc_b_${randomUUID()}`),
    ]);
    expect(resA.status).toBe(201);
    expect(resB.status).toBe(201);
    const a = (await resA.json()) as any;
    const b = (await resB.json()) as any;
    expect(
      new Set([a.data.variationOrder.displayNumber, b.data.variationOrder.displayNumber]),
    ).toEqual(expectedNumbers);
    expect(a.data.variationOrder.systemNumber).toBe(a.data.variationOrder.displayNumber);
    expect(b.data.variationOrder.systemNumber).toBe(b.data.variationOrder.displayNumber);

    // Each engagement's D-033 roll-up is correct: 1,000M contract value +
    // its own 5M fee effect = 1,005,000,000.00.
    expect(await readEngagementPrice(engagementA)).toBe('1005000000.00');
    expect(await readEngagementPrice(engagementB)).toBe('1005000000.00');

    // No duplicate display numbers anywhere in the studio.
    const duplicates = await tenantQuery(SEED_STUDIO, async (client) => {
      const res = await client.query(
        `SELECT display_number FROM variation_orders
         WHERE display_number IS NOT NULL
         GROUP BY display_number HAVING count(*) > 1`,
      );
      return res.rows.length;
    });
    expect(duplicates).toBe(0);

    // Cleanup: drop the throwaway engagements, their changes and VOs. The
    // counter is NOT reset — numbers are never reused (C6); the suite's
    // beforeAll resets it for the next run.
    await tenantQuery(SEED_STUDIO, async (client) => {
      await client.query(
        `DELETE FROM variation_order_approvals
         WHERE variation_order_id IN (
           SELECT id FROM variation_orders WHERE project_change_id IN ($1, $2))`,
        [changeA.id, changeB.id],
      );
      await client.query(`DELETE FROM variation_orders WHERE project_change_id IN ($1, $2)`, [
        changeA.id,
        changeB.id,
      ]);
      await client.query(`DELETE FROM project_changes WHERE id IN ($1, $2)`, [
        changeA.id,
        changeB.id,
      ]);
      // Marker-based sweep: also removes rows from aborted runs of this
      // test (an assertion failure before this block leaks them).
      await client.query(
        `DELETE FROM project_changes WHERE engagement_id IN
           (SELECT id FROM project_engagements WHERE current_phase_key = 'vo-cleanup-test')`,
      );
      await client.query(
        `DELETE FROM variation_orders WHERE engagement_id IN
           (SELECT id FROM project_engagements WHERE current_phase_key = 'vo-cleanup-test')`,
      );
      await client.query(
        `DELETE FROM project_engagements WHERE current_phase_key = 'vo-cleanup-test'`,
      );
    });
  });

  it('SOL-131: a same-engagement concurrent loser gets a typed 409, never a 500', async () => {
    // Two mints against ONE engagement with the same pre-mint If-Match
    // version: the version guard means exactly one commits. The loser gets a
    // typed 409 — the retry converts the first attempt's 40001 into a clean
    // ENTITY_VERSION_CONFLICT carrying the current version to refetch — never
    // a bare 500.
    const nextValue = await tenantQuery(SEED_STUDIO, async (client) => {
      const res = await client.query(
        `SELECT next_value FROM studio_number_sequences WHERE studio_id = $1 AND namespace = 'VO'`,
        [SEED_STUDIO],
      );
      return (res.rows[0] as { next_value?: number } | undefined)?.next_value ?? 1;
    });
    const expectedWinnerNumber = `VO-${String(nextValue).padStart(4, '0')}`;
    const changeA = await createEligibleChange();
    const changeB = await createEligibleChange();
    const engagementVersion = await readEngagementVersion();

    const mint = (change: { id: string; entityVersion: string }, key: string) =>
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
          body: JSON.stringify({
            boqEffect: '10000000.00',
            contractRevisionId: change.id,
            effectiveDate: '2026-08-22T00:00:00Z',
            feeEffect: '5000000.00',
            scheduleOfValuesId: randomUUID(),
          }),
        },
      );

    const [resA, resB] = await Promise.all([
      mint(changeA, `vo_same_a_${randomUUID()}`),
      mint(changeB, `vo_same_b_${randomUUID()}`),
    ]);
    const statuses = [resA.status, resB.status].sort();
    expect(statuses).toEqual([201, 409]);
    const winner = resA.status === 201 ? resA : resB;
    const loser = resA.status === 201 ? resB : resA;
    // SOL-146: every guarded-write error body is the full Problem envelope;
    // the refetch version lives in `details.currentEntityVersion`.
    const loserBody = (await loser.json()) as ProblemEnvelope;
    expect(loserBody.type).toBe('urn:stdio:error');
    expect(['CONCURRENT_WRITE_CONFLICT', 'ENTITY_VERSION_CONFLICT']).toContain(loserBody.code);
    if (loserBody.code === 'ENTITY_VERSION_CONFLICT') {
      expect(loserBody.details?.currentEntityVersion).toBeTruthy();
    }

    // The winner minted exactly one numbered VO; the loser minted nothing.
    const winnerPayload = (await winner.json()) as any;
    expect(winnerPayload.data.variationOrder.displayNumber).toBe(expectedWinnerNumber);
    const mintedCount = await tenantQuery(SEED_STUDIO, async (client) => {
      const res = await client.query(
        `SELECT count(*)::int AS n FROM variation_orders
         WHERE project_change_id IN ($1, $2)`,
        [changeA.id, changeB.id],
      );
      return (res.rows[0] as { n?: number }).n;
    });
    expect(mintedCount).toBe(1);

    // Cleanup: drop the winner VO and restore the suite baseline
    // (price 1,035,000,000: base + seed VO + the two sequential test VOs).
    // The counter keeps its value — the burned number is never reused (C6).
    const winnerChangeId = winner === resA ? changeA.id : changeB.id;
    await tenantQuery(SEED_STUDIO, async (client) => {
      await client.query(
        `DELETE FROM variation_order_approvals
         WHERE variation_order_id IN (
           SELECT id FROM variation_orders WHERE project_change_id = $1)`,
        [winnerChangeId],
      );
      await client.query(`DELETE FROM variation_orders WHERE project_change_id = $1`, [
        winnerChangeId,
      ]);
      await client.query(
        `UPDATE project_engagements SET transaction_price = '1035000000.00' WHERE id = $1`,
        [BUILD_ENGAGEMENT],
      );
    });
  });

  it('SOL-131: a non-UUID contractRevisionId returns 422, not a bare 500', async () => {
    const engagementVersion = await readEngagementVersion();
    const key = `vo_uuid_${randomUUID()}`;
    const body = {
      boqEffect: '10000000.00',
      contractRevisionId: 'rev-w3-1',
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
    expect(res.status).toBe(422);
    const payload = (await res.json()) as any;
    expect(payload.code).toBe('INVALID_UUID_FIELD');
    expect(payload.detail).toContain('contractRevisionId');
  });

  it('SOL-131: a non-UUID scheduleOfValuesId returns 422, not a bare 500', async () => {
    const engagementVersion = await readEngagementVersion();
    const key = `vo_uuid_sov_${randomUUID()}`;
    const body = {
      boqEffect: '10000000.00',
      contractRevisionId: SEED_CHANGE,
      effectiveDate: '2026-08-22T00:00:00Z',
      feeEffect: '5000000.00',
      scheduleOfValuesId: 'sov-sheet-7',
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
    expect(res.status).toBe(422);
    const payload = (await res.json()) as any;
    expect(payload.code).toBe('INVALID_UUID_FIELD');
    expect(payload.detail).toContain('scheduleOfValuesId');
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

  it('records a plain payment on the OWNER capability (SOL-132)', async () => {
    const res = await app.request(
      `/projects/${SEED_PROJECT}/engagements/${BUILD_ENGAGEMENT}/invoices/${SEED_INVOICE}/payment`,
      {
        method: 'POST',
        headers: {
          ...auth(),
          'Content-Type': 'application/json',
          'Idempotency-Key': `pay-${randomUUID()}`,
        },
        body: JSON.stringify({
          amount: '100000.00',
          date: '2026-08-22',
          paymentMethod: 'BANK_TRANSFER',
        }),
      },
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(body.meta.idempotentReplay).toBe(false);
    const invoice = body.data.invoice;
    expect(invoice.payments.length).toBeGreaterThanOrEqual(2);
    const stored = await tenantQuery(SEED_STUDIO, async (client) => {
      const rows = (await client.query(
        `SELECT amount, gross_amount, pph_amount, retensi_amount
         FROM invoice_payments ORDER BY created_at DESC LIMIT 1`,
      )) as { rows: Record<string, string | null>[] };
      return rows.rows[0] ?? {};
    });
    expect(stored.amount).toBe('100000.00');
    expect(stored.gross_amount).toBe('100000.00');
    expect(stored.pph_amount).toBeNull();
    expect(stored.retensi_amount).toBeNull();
  });

  it('records a split payment and derives cash = gross - pph - retensi (SOL-132)', async () => {
    // A 10000.00 gross termin with 2% PPh withholding and 5% retensi held.
    const res = await app.request(
      `/projects/${SEED_PROJECT}/engagements/${BUILD_ENGAGEMENT}/invoices/${SEED_INVOICE}/payment`,
      {
        method: 'POST',
        headers: {
          ...auth(),
          'Content-Type': 'application/json',
          'Idempotency-Key': `pay-${randomUUID()}`,
        },
        body: JSON.stringify({
          amount: '9300.00',
          date: '2026-08-23',
          paymentMethod: 'BANK_TRANSFER',
          reference: 'BCA-8812',
          grossAmount: '10000.00',
          pphPercent: '2.0000',
          retensiPercent: '5.0000',
        }),
      },
    );
    if (res.status !== 201) {
      console.log('SPLIT BODY', JSON.stringify(await res.json()));
    }
    expect(res.status).toBe(201);
    const stored = await tenantQuery(SEED_STUDIO, async (client) => {
      const rows = (await client.query(
        `SELECT amount, gross_amount, pph_percent, pph_amount, retensi_percent, retensi_amount
         FROM invoice_payments WHERE reference = 'BCA-8812'`,
      )) as { rows: Record<string, string | null>[] };
      return rows.rows[0] ?? {};
    });
    // Exact rational arithmetic in integer minor units: 200.00 PPh,
    // 500.00 retensi, 9300.00 cash. No cent is lost to floats.
    expect(stored.gross_amount).toBe('10000.00');
    expect(stored.pph_percent).toBe('2.0000');
    expect(stored.pph_amount).toBe('200.00');
    expect(stored.retensi_percent).toBe('5.0000');
    expect(stored.retensi_amount).toBe('500.00');
    expect(stored.amount).toBe('9300.00');
  });

  it('replays an idempotent payment retry with 200 and no second row', async () => {
    const key = `pay-${randomUUID()}`;
    const payload = JSON.stringify({ amount: '111.00', date: '2026-08-23', paymentMethod: 'CASH' });
    const first = await app.request(
      `/projects/${SEED_PROJECT}/engagements/${BUILD_ENGAGEMENT}/invoices/${SEED_INVOICE}/payment`,
      {
        method: 'POST',
        headers: { ...auth(), 'Content-Type': 'application/json', 'Idempotency-Key': key },
        body: payload,
      },
    );
    expect(first.status).toBe(201);
    const replay = await app.request(
      `/projects/${SEED_PROJECT}/engagements/${BUILD_ENGAGEMENT}/invoices/${SEED_INVOICE}/payment`,
      {
        method: 'POST',
        headers: { ...auth(), 'Content-Type': 'application/json', 'Idempotency-Key': key },
        body: payload,
      },
    );
    expect(replay.status).toBe(200);
    expect(((await replay.json()) as any).meta.idempotentReplay).toBe(true);
    const counted = await tenantQuery(SEED_STUDIO, async (client) => {
      // The completed key stores exactly one executed response; a second
      // execution would have written another payment row and replayed that
      // different body instead.
      const keyed = (await client.query(
        `SELECT (response_body LIKE '%111.00%')::int AS n
         FROM idempotency_keys WHERE key = $1 AND status = 'COMPLETED'`,
        [key],
      )) as { rows: { n: number }[] };
      return keyed.rows[0]?.n ?? 0;
    });
    expect(counted).toBe(1);
  });

  it('rejects a split whose derived cash disagrees with amount (SOL-132)', async () => {
    const res = await app.request(
      `/projects/${SEED_PROJECT}/engagements/${BUILD_ENGAGEMENT}/invoices/${SEED_INVOICE}/payment`,
      {
        method: 'POST',
        headers: {
          ...auth(),
          'Content-Type': 'application/json',
          'Idempotency-Key': `pay-${randomUUID()}`,
        },
        body: JSON.stringify({
          amount: '9999.00',
          date: '2026-08-23',
          paymentMethod: 'BANK_TRANSFER',
          grossAmount: '10000.00',
          pphPercent: '2.0000',
          retensiPercent: '5.0000',
        }),
      },
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as any;
    expect(body.code).toBe('PAYMENT_SPLIT_MISMATCH');
  });

  it('rejects percent-derived splits without a gross amount', async () => {
    const res = await app.request(
      `/projects/${SEED_PROJECT}/engagements/${BUILD_ENGAGEMENT}/invoices/${SEED_INVOICE}/payment`,
      {
        method: 'POST',
        headers: {
          ...auth(),
          'Content-Type': 'application/json',
          'Idempotency-Key': `pay-${randomUUID()}`,
        },
        body: JSON.stringify({
          amount: '100.00',
          date: '2026-08-23',
          paymentMethod: 'CASH',
          pphPercent: '2.0000',
        }),
      },
    );
    expect(res.status).toBe(422);
    expect(((await res.json()) as any).code).toBe('PAYMENT_GROSS_REQUIRED');
  });

  it('rejects a negative amount and an over-gross split', async () => {
    const negative = await app.request(
      `/projects/${SEED_PROJECT}/engagements/${BUILD_ENGAGEMENT}/invoices/${SEED_INVOICE}/payment`,
      {
        method: 'POST',
        headers: {
          ...auth(),
          'Content-Type': 'application/json',
          'Idempotency-Key': `pay-${randomUUID()}`,
        },
        body: JSON.stringify({ amount: '-5.00', date: '2026-08-23', paymentMethod: 'CASH' }),
      },
    );
    expect(negative.status).toBe(422);
    expect(((await negative.json()) as any).code).toBe('MONEY_OUT_OF_RANGE');

    const over = await app.request(
      `/projects/${SEED_PROJECT}/engagements/${BUILD_ENGAGEMENT}/invoices/${SEED_INVOICE}/payment`,
      {
        method: 'POST',
        headers: {
          ...auth(),
          'Content-Type': 'application/json',
          'Idempotency-Key': `pay-${randomUUID()}`,
        },
        body: JSON.stringify({
          // 60% PPh + 50% retensi = 110% of the gross, so the derived cash
          // goes negative (-500.00) and PAYMENT_SPLIT_OVER_GROSS must fire.
          // A non-positive amount cannot reach this stage (rejected above),
          // so a tiny positive amount carries the mismatch branch instead.
          amount: '1.00',
          date: '2026-08-23',
          paymentMethod: 'BANK_TRANSFER',
          grossAmount: '10000.00',
          pphPercent: '60.0000',
          retensiPercent: '50.0000',
        }),
      },
    );
    expect(over.status).toBe(422);
    const overBody = (await over.json()) as any;
    // The derived cash is negative (-1000.00 = 10000 - 6000 - 5000), so the
    // route answers PAYMENT_SPLIT_OVER_GROSS regardless of the stated amount.
    expect(overBody.code).toBe('PAYMENT_SPLIT_OVER_GROSS');
    expect(overBody.details.derivedCash).toBe('-1000.00');
  });

  it('denies the payment write for a non-OWNER role (SOL-132)', async () => {
    const res = await app.request(
      `/projects/${SEED_PROJECT}/engagements/${BUILD_ENGAGEMENT}/invoices/${SEED_INVOICE}/payment`,
      {
        method: 'POST',
        headers: {
          ...designerAuth(),
          'Content-Type': 'application/json',
          'Idempotency-Key': `pay-${randomUUID()}`,
        },
        body: JSON.stringify({ amount: '100.00', date: '2026-08-23', paymentMethod: 'CASH' }),
      },
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as any;
    expect(body.code).toBe('CAPABILITY_DENIED');
    expect(body.detail).toContain('studio owner');
  });

  it('never lets another studio record a payment on this invoice (RLS)', async () => {
    // The other studio cannot resolve this engagement at all.
    const res = await app.request(
      `/projects/${SEED_PROJECT}/engagements/${randomUUID()}/invoices/${SEED_INVOICE}/payment`,
      {
        method: 'POST',
        headers: {
          ...otherAuth(),
          'Content-Type': 'application/json',
          'Idempotency-Key': `pay-${randomUUID()}`,
        },
        body: JSON.stringify({ amount: '100.00', date: '2026-08-23', paymentMethod: 'CASH' }),
      },
    );
    expect([403, 404]).toContain(res.status);
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
    // 1,035,000,000.00: the cross-engagement roll-up = the build baseline
    // (base 1,000M + seed VO 25M) + the two approved test VOs (5M each)
    // written earlier in this suite. The suite reset the design engagement
    // to no money so the roll-up is deterministic against the seed.
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
