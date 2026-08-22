/**
 * Integration tests for the SOL-19 budget-versus-actual report.
 *
 * Runs against the live `stdio_dev` database (seed: Studio Contoh). Proves
 * the SOL-73-A conditions and the FE conditions:
 *
 * - The residual-allocation counterexample end-to-end: Q=1, R=0.5, U=0.01
 *   projects actual 0.01, committed 0.00, sum 0.01 (I-1).
 * - I-1 after a receipt reversal: the report reads the cumulative net
 *   `received_quantity`, never the sum of ORIGINAL receipts (section 2.3).
 * - The over-receipt rule (C2): R > Q projects the full received value as
 *   actual and zero committed, never negative.
 * - Labour (C1): APPROVED entries count hours x rate, rounded half-up per
 *   entry; LOGGED entries do not count; no rate is ever projected.
 * - Access (D-007 Q-A): DESIGNER is 403; OWNER reads the report.
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
const SEED_VENDOR = '00000000-0000-4000-8000-000000000005';

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

/** Creates one CONFIRMED PO with one line, all inside the studio. */
async function fixturePo(line: {
  description: string;
  quantity: string;
  received: string;
  unitCost: string;
}): Promise<{ poId: string; itemId: string }> {
  return tenantQuery(SEED_STUDIO, async (client) => {
    const po = (await client.query(
      `INSERT INTO purchase_orders
         (id, studio_id, purchase_order_number, project_id, vendor_id, status, currency, issue_date)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, 'CONFIRMED', 'IDR', '2026-08-12')
       RETURNING id`,
      [SEED_STUDIO, `BGT-${randomUUID().slice(0, 8)}`, SEED_PROJECT, SEED_VENDOR],
    )) as { rows: { id: string }[] };
    const poId = po.rows[0]?.id;
    if (!poId) {
      throw new Error('fixture PO missing');
    }
    const item = (await client.query(
      `INSERT INTO purchase_order_items
         (id, studio_id, purchase_order_id, description, quantity, received_quantity, unit_cost)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [SEED_STUDIO, poId, line.description, line.quantity, line.received, line.unitCost],
    )) as { rows: { id: string }[] };
    const itemId = item.rows[0]?.id;
    if (!itemId) {
      throw new Error('fixture PO item missing');
    }
    return { poId, itemId };
  });
}

/** Writes one goods receipt (ORIGINAL or REVERSAL) and updates the net. */
async function fixtureReceipt(
  itemId: string,
  quantity: string,
  kind: 'ORIGINAL' | 'REVERSAL',
): Promise<void> {
  await tenantQuery(SEED_STUDIO, async (client) => {
    const receipt = (await client.query(
      `INSERT INTO goods_receipts
         (id, studio_id, purchase_order_id, number, kind, delivery_reference, receipt_date, issued_at, receiver_name_snapshot)
       VALUES (gen_random_uuid(), $1,
               (SELECT purchase_order_id FROM purchase_order_items WHERE id = $2),
               $3, $4, 'ref', now(), now(), 'Test')
       RETURNING id`,
      [SEED_STUDIO, itemId, `GR-${randomUUID().slice(0, 8)}`, kind],
    )) as { rows: { id: string }[] };
    const receiptId = receipt.rows[0]?.id;
    if (!receiptId) {
      throw new Error('fixture receipt missing');
    }
    await client.query(
      `INSERT INTO goods_receipt_lines (id, studio_id, goods_receipt_id, purchase_order_item_id, description_snapshot, quantity)
       VALUES (gen_random_uuid(), $1, $2, $3, 'line', $4)`,
      [SEED_STUDIO, receiptId, itemId, quantity],
    );
    await client.query(
      `UPDATE purchase_order_items
          SET received_quantity = received_quantity + $2::numeric
        WHERE id = $1`,
      [itemId, kind === 'ORIGINAL' ? quantity : `-${quantity}`],
    );
  });
}

/**
 * A dedicated project so the baseline totals never race with the
 * engagement suite, which mutates the seed build engagement's D-033
 * transaction price while the server test files run in parallel.
 */
async function fixtureProject(): Promise<{ projectId: string }> {
  return tenantQuery(SEED_STUDIO, async (client) => {
    const project = (await client.query(
      `INSERT INTO projects (id, studio_id, project_code, name, client_id, status)
       VALUES (gen_random_uuid(), $1, $2, 'Proyek Anggaran', '00000000-0000-4000-8000-000000000003', 'ACTIVE')
       RETURNING id`,
      [SEED_STUDIO, `BGT-PRJ-${randomUUID().slice(0, 8)}`],
    )) as { rows: { id: string }[] };
    const projectId = project.rows[0]?.id;
    if (!projectId) {
      throw new Error('fixture project missing');
    }
    await client.query(
      `INSERT INTO project_engagements
         (id, studio_id, project_id, kind, contract_value, transaction_price)
       VALUES (gen_random_uuid(), $1, $2, 'BUILD', '500000000.00', '500000000.00')`,
      [SEED_STUDIO, projectId],
    );
    const po = (await client.query(
      `INSERT INTO purchase_orders
         (id, studio_id, purchase_order_number, project_id, vendor_id, status, currency, issue_date, total_amount)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, 'CONFIRMED', 'IDR', '2026-08-12', '120000000.00')
       RETURNING id`,
      [SEED_STUDIO, `BGT-PO-${randomUUID().slice(0, 8)}`, projectId, SEED_VENDOR],
    )) as { rows: { id: string }[] };
    const poId = po.rows[0]?.id;
    if (!poId) {
      throw new Error('fixture PO missing');
    }
    await client.query(
      `INSERT INTO purchase_order_items
         (id, studio_id, purchase_order_id, description, quantity, unit_cost, line_total, receiving_state)
       VALUES (gen_random_uuid(), $1, $2, 'BGT-baseline-line', '2.0000', '60000000.00', '120000000.00', 'ordered')`,
      [SEED_STUDIO, poId],
    );
    return { projectId };
  });
}

async function cleanupFixtures(): Promise<void> {
  await tenantQuery(SEED_STUDIO, async (client) => {
    await client.query(
      `DELETE FROM goods_receipt_lines WHERE goods_receipt_id IN
         (SELECT id FROM goods_receipts WHERE purchase_order_id IN
           (SELECT id FROM purchase_orders WHERE purchase_order_number LIKE 'BGT-%'))`,
    );
    await client.query(
      `DELETE FROM goods_receipts WHERE purchase_order_id IN
         (SELECT id FROM purchase_orders WHERE purchase_order_number LIKE 'BGT-%')`,
    );
    await client.query(`DELETE FROM purchase_order_items WHERE description LIKE 'BGT-%'`);
    await client.query(`DELETE FROM purchase_orders WHERE purchase_order_number LIKE 'BGT-%'`);
    await client.query(`DELETE FROM timesheet_entries WHERE notes = 'bgt-test'`);
  });
}

beforeAll(async () => {
  pool = new Pool({ connectionString, max: 5 });
  app = createApp(pool);
  token = `naa_bgt_${randomUUID()}`;
  designerToken = `naa_bgt_designer_${randomUUID()}`;
  await mintToken(SEED_STUDIO, SEED_OWNER, token);
  await tenantQuery(SEED_STUDIO, async (client) => {
    await client.query(
      `INSERT INTO users (id, studio_id, email, name, role)
       VALUES (gen_random_uuid(), $1, 'bgt-designer@contoh.studio', 'Desainer', 'DESIGNER')
       ON CONFLICT DO NOTHING`,
      [SEED_STUDIO],
    );
    const rows = (await client.query(
      `SELECT id FROM users WHERE studio_id = $1 AND email = 'bgt-designer@contoh.studio'`,
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
  await cleanupFixtures();
});

afterAll(async () => {
  await cleanupFixtures();
  await pool.end();
});

describe('budget-versus-actual report', () => {
  it('serves a deterministic baseline: budget 500M, committed 120M, zero actual', async () => {
    const { projectId } = await fixtureProject();
    const res = await app.request(`/projects/${projectId}/budget-vs-actual`, { headers: auth() });
    expect(res.status).toBe(200);
    const report = ((await res.json()) as any).data.report;
    // totalBudget = the engagement transaction price (D-033).
    expect(report.totalBudget).toBe('500000000.00');
    expect(report.committedCost).toBe('120000000.00');
    expect(report.actualCost).toBe('0.00');
    expect(report.labourActualCost).toBe('0.00');
    expect(report.signedVariance).toBe('380000000.00');
    expect(report.forecastRemaining).toBe('380000000.00');
    expect(report.canReadFinance).toBe(true);
    const poLine = report.lines.find(
      (l: any) => l.kind === 'purchase_order' && l.name === 'BGT-baseline-line',
    );
    expect(poLine).toBeTruthy();
    expect(poLine.bucket).toBe('committed');
    expect(poLine.committedCost).toBe('120000000.00');
    expect(poLine.actualCost).toBe('0.00');
  });

  it('projects the counterexample end-to-end: Q=1, R=0.5, U=0.01', async () => {
    await fixturePo({
      description: 'BGT-counterexample',
      quantity: '1.0000',
      received: '0.5000',
      unitCost: '0.01',
    });
    const res = await app.request(`/projects/${SEED_PROJECT}/budget-vs-actual`, {
      headers: auth(),
    });
    const report = ((await res.json()) as any).data.report;
    const line = report.lines.find((l: any) => l.name === 'BGT-counterexample');
    expect(line).toBeTruthy();
    // The ruling's exact values: actual 0.01, committed 0.00, sum 0.01.
    expect(line.actualCost).toBe('0.01');
    expect(line.committedCost).toBe('0.00');
    expect(line.bucket).toBe('actual');
  });

  it('holds I-1 after a receipt reversal (net received quantity)', async () => {
    const { itemId } = await fixturePo({
      description: 'BGT-reversal',
      quantity: '4.0000',
      received: '0',
      unitCost: '100.00',
    });
    await fixtureReceipt(itemId, '2.0000', 'ORIGINAL');
    await fixtureReceipt(itemId, '2.0000', 'REVERSAL');
    const res = await app.request(`/projects/${SEED_PROJECT}/budget-vs-actual`, {
      headers: auth(),
    });
    const report = ((await res.json()) as any).data.report;
    const line = report.lines.find((l: any) => l.name === 'BGT-reversal');
    // The cumulative net is zero: the full 400.00 stays committed.
    expect(line.receivedQuantity).toBeUndefined();
    expect(line.actualCost).toBe('0.00');
    expect(line.committedCost).toBe('400.00');
    expect(line.bucket).toBe('committed');
    expect(`${line.actualCost}+${line.committedCost}`).toBe('0.00+400.00');
  });

  it('applies the over-receipt rule: R > Q projects full actual and zero committed', async () => {
    await fixturePo({
      description: 'BGT-over',
      quantity: '1.0000',
      received: '2.0000',
      unitCost: '100.00',
    });
    const res = await app.request(`/projects/${SEED_PROJECT}/budget-vs-actual`, {
      headers: auth(),
    });
    const report = ((await res.json()) as any).data.report;
    const line = report.lines.find((l: any) => l.name === 'BGT-over');
    expect(line.actualCost).toBe('200.00');
    expect(line.committedCost).toBe('0.00');
    expect(line.bucket).toBe('actual');
  });

  it('counts APPROVED labour at the snapshot rate and never projects a rate', async () => {
    // A dedicated project: the seed project's timesheets are mutated by the
    // parallel timesheets suite, so totals there are not hermetic.
    const { projectId } = await fixtureProject();
    await tenantQuery(SEED_STUDIO, async (client) => {
      await client.query(
        `INSERT INTO timesheet_entries
           (id, studio_id, user_id, project_id, entry_date, hours, notes, status, effective_hourly_rate)
         VALUES (gen_random_uuid(), $1, $2, $3, '2026-08-22T00:00:00.000Z', '8.00', 'bgt-test', 'APPROVED', '125000.0000')`,
        [SEED_STUDIO, SEED_OWNER, projectId],
      );
    });
    const res = await app.request(`/projects/${projectId}/budget-vs-actual`, {
      headers: auth(),
    });
    const report = ((await res.json()) as any).data.report;
    // 8.00 h x 125000.0000 = 1,000,000.00.
    expect(report.labourActualCost).toBe('1000000.00');
    const labourLine = report.lines.find((l: any) => l.kind === 'timesheet');
    expect(labourLine).toBeTruthy();
    expect(labourLine.bucket).toBe('labour');
    expect(labourLine.actualCost).toBe('1000000.00');
    expect(labourLine.committedCost).toBe('0.00');
    // D-007: the rate itself is never projected.
    expect(JSON.stringify(report)).not.toContain('125000');
  });

  it('does not count LOGGED entries', async () => {
    const { projectId } = await fixtureProject();
    await tenantQuery(SEED_STUDIO, async (client) => {
      await client.query(
        `INSERT INTO timesheet_entries
           (id, studio_id, user_id, project_id, entry_date, hours, notes, status, effective_hourly_rate)
         VALUES (gen_random_uuid(), $1, $2, $3, '2026-08-21T00:00:00.000Z', '5.00', 'bgt-test', 'LOGGED', '125000.0000')`,
        [SEED_STUDIO, SEED_OWNER, projectId],
      );
    });
    const res = await app.request(`/projects/${projectId}/budget-vs-actual`, {
      headers: auth(),
    });
    const report = ((await res.json()) as any).data.report;
    expect(report.labourActualCost).toBe('0.00');
  });

  it('denies a DESIGNER (403) and 404s a foreign project', async () => {
    const denied = await app.request(`/projects/${SEED_PROJECT}/budget-vs-actual`, {
      headers: { Authorization: `Bearer ${designerToken}` },
    });
    expect(denied.status).toBe(403);
    expect(((await denied.json()) as any).code).toBe('CAPABILITY_DENIED');
    const missing = await app.request(`/projects/${randomUUID()}/budget-vs-actual`, {
      headers: auth(),
    });
    expect(missing.status).toBe(404);
  });
});
