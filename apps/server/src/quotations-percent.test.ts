/**
 * SOL-96 regression: quotation reads survive 4dp percentages.
 *
 * `discount_percent` and milestone `percentage` are `numeric(10,4)` columns —
 * percentages, not 2dp money. The money parser rejects values with more than
 * two decimal places, so feeding these columns through `moneyNumber` made the
 * register 500 on any 4dp percentage (proved live on 2026-08-22: 10.0000
 * crashed the route). The route must emit them as exact plain numbers.
 *
 * This suite owns a scratch database, like `tax/routes.test.ts`.
 */

import { randomUUID } from 'node:crypto';

import { applyMigrations } from '@stdio/db/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from './app';

const adminUrl = process.env.DATABASE_URL ?? 'postgres://stdio:stdio@localhost:5432/stdio_dev';
const testDb = `stdio_quotation_pct_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
const testUrl = adminUrl.replace(/\/[^/]+$/, `/${testDb}`);

const IDS = {
  studio: randomUUID(),
  owner: randomUUID(),
  client: randomUUID(),
  project: randomUUID(),
  engagement: randomUUID(),
  quotation: randomUUID(),
  milestone: randomUUID(),
};

let pool: pg.Pool;
let app: ReturnType<typeof createApp>;
let token: string;

/** Opens a tenant-scoped session and runs the callback, then commits. */
async function tenant<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', ['app.studio_id', IDS.studio]);
    await client.query('SET LOCAL ROLE studio_app');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } finally {
    client.release(true);
  }
}

async function seedFixtures(): Promise<void> {
  await tenant(async (client) => {
    await client.query(
      `INSERT INTO studios (studio_id, name, currency, timezone)
       VALUES ($1, 'Studio Persen', 'IDR', 'Asia/Jakarta')`,
      [IDS.studio],
    );
    await client.query(
      `INSERT INTO users (id, studio_id, email, name, role)
       VALUES ($1, $2, 'owner@persen.studio', 'Pemilik', 'OWNER')`,
      [IDS.owner, IDS.studio],
    );
    await client.query(
      `INSERT INTO clients (id, studio_id, client_number, name, company_name, status)
       VALUES ($1, $2, 'CL-PCT', 'PT Klien Persen', 'PT Klien Persen', 'ACTIVE')`,
      [IDS.client, IDS.studio],
    );
    await client.query(
      `INSERT INTO projects (id, studio_id, project_code, name, client_id, status)
       VALUES ($1, $2, 'PRJ-PCT', 'Proyek Persen', $3, 'ACTIVE')`,
      [IDS.project, IDS.studio, IDS.client],
    );
    await client.query(
      `INSERT INTO project_engagements (id, studio_id, project_id, kind, sort_order,
                                        lifecycle_status, contract_state)
       VALUES ($1, $2, $3, 'DESIGN', 1, 'ACTIVE', 'SIGNED')`,
      [IDS.engagement, IDS.studio, IDS.project],
    );
    // discount_percent carries four decimal places — the regression token.
    await client.query(
      `INSERT INTO quotations (id, studio_id, quotation_number, title, client_id, project_id,
                               engagement_id, version, status, quotation_type, fee_model,
                               currency, subtotal_amount, discount_percent, discount_amount,
                               tax_amount, total_amount, default_rate_per_sqm)
       VALUES ($1, $2, 'QUO-PCT', 'Penawaran Persen', $3, $4, $5, 1, 'ISSUED', 'DESIGN',
               'PERCENTAGE', 'IDR', '618750.00', '10.5000', '75000.00', '74250.00',
               '749250.00', '1500000.00')`,
      [IDS.quotation, IDS.studio, IDS.client, IDS.project, IDS.engagement],
    );
    await client.query(
      `INSERT INTO quotation_items (id, studio_id, quotation_id, line_order, line_type,
                                    description, quantity, unit_rate, line_subtotal, line_total)
       VALUES ($1, $2, $3, 1, 'FEE', 'Jasa desain tahap A', '412.5000', '1500000.00',
               '618750.00', '618750.00')`,
      [randomUUID(), IDS.studio, IDS.quotation],
    );
    // Milestone percentage also carries four decimal places.
    await client.query(
      `INSERT INTO quotation_payment_milestones (id, studio_id, quotation_id, sort_order,
                                                 name, percentage, amount)
       VALUES ($1, $2, $3, 1, 'Kunci desain', '25.2500', '187312.50')`,
      [IDS.milestone, IDS.studio, IDS.quotation],
    );
    token = `naa_pct_test_${randomUUID()}`;
    await client.query(
      `INSERT INTO access_tokens (studio_id, user_id, token, expires_at)
       VALUES ($1, $2, $3, now() + interval '1 hour')`,
      [IDS.studio, IDS.owner, token],
    );
  });
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
}, 90_000);

afterAll(async () => {
  await pool.end();
  const admin = new pg.Pool({ connectionString: adminUrl, max: 1 });
  await admin.query(`DROP DATABASE IF EXISTS ${testDb} WITH (FORCE)`);
  await admin.end();
});

describe('quotation register with 4dp percentages', () => {
  it('returns 200 and emits discountPercent and milestone percentage exactly', async () => {
    const res = await app.request(
      `/projects/${IDS.project}/engagements/${IDS.engagement}/quotations`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { quotations: { quotations: Array<Record<string, unknown>> } };
    };
    const quotations = body.data.quotations.quotations;
    expect(quotations).toHaveLength(1);
    const quotation = quotations[0] as Record<string, unknown>;
    expect(quotation.discountPercent).toBe(10.5);
    expect(quotation.defaultRatePerSqm).toBe(1500000);
    expect(quotation.discountAmount).toBe(75000);
    expect(quotation.totalAmount).toBe(749250);
    const milestones = quotation.paymentMilestones as Array<Record<string, unknown>>;
    expect(milestones).toHaveLength(1);
    const milestone = milestones[0] as Record<string, unknown>;
    expect(milestone.percentage).toBe(25.25);
    expect(milestone.amount).toBe(187312.5);
  });
});
