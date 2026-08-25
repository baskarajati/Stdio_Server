/**
 * Integration test for the token → `/me` path.
 *
 * Runs against the live `stdio_dev` database, which the seed has populated
 * (`Studio Contoh`, owner, one project with two engagements). The test
 * mints an access token, then asserts the `/me` response projects the
 * correct user, company, and capability set.
 * The SOL-28 and SOL-25 gates have closed, so the owner's money-write
 * capabilities are enabled; payment recording stays disabled. Reads and
 * collection-control metadata are open.
 */

import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from './app';

const connectionString =
  process.env.DATABASE_URL ?? 'postgres://stdio:stdio@localhost:5432/stdio_dev';

const SEED_STUDIO = '00000000-0000-4000-8000-000000000001';
const SEED_OWNER = '00000000-0000-4000-8000-000000000002';

let pool: Pool;
let app: ReturnType<typeof createApp>;

type Capability = { enabled: boolean; reason: string };
type MeBody = {
  data: {
    user: { id: string; email: string; name: string; role: string };
    company: { id: string; name: string; currency: string; timezone: string };
    capabilities: {
      canReadFinance: Capability;
      canUpdateInvoiceCollection: Capability;
      canWriteVariationOrder: Capability;
      canWriteInvoiceDraft: Capability;
      canIssueInvoice: Capability;
      canRecordInvoicePayment: Capability;
    };
  };
  meta: { apiVersion: string; requestId: string };
};

beforeAll(async () => {
  pool = new Pool({ connectionString, max: 5 });
  app = createApp(pool);
});

afterAll(async () => {
  await pool.end();
});

async function mintToken(token: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', ['app.studio_id', SEED_STUDIO]);
    await client.query('SET LOCAL ROLE studio_app');
    await client.query(
      `INSERT INTO access_tokens (studio_id, user_id, token, expires_at)
       VALUES ($1, $2, $3, now() + interval '1 hour')
       ON CONFLICT (token) DO NOTHING`,
      [SEED_STUDIO, SEED_OWNER, token],
    );
    await client.query('COMMIT');
  } finally {
    client.release(true);
  }
}

describe('GET /me', () => {
  const token = `naa_test_${randomUUID()}`;

  beforeAll(async () => {
    await mintToken(token);
  });

  it('returns a 401 without a bearer token', async () => {
    const res = await app.request('/me');
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('UNAUTHENTICATED');
  });

  it('returns a 401 for an unknown token', async () => {
    const res = await app.request('/me', {
      headers: { Authorization: 'Bearer naa_unknown_does_not_exist' },
    });
    expect(res.status).toBe(401);
  });

  it('returns the user, company, and capabilities for a valid token', async () => {
    const res = await app.request('/me', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as MeBody;

    expect(body.data.user.id).toBe(SEED_OWNER);
    expect(body.data.user.email).toBe('owner@contoh.studio');
    expect(body.data.user.role).toBe('OWNER');
    expect(body.data.company.id).toBe(SEED_STUDIO);
    expect(body.data.company.name).toBe('Studio Contoh');
    expect(body.data.company.currency).toBe('IDR');

    // Reads and collection-control metadata are open.
    expect(body.data.capabilities.canReadFinance.enabled).toBe(true);
    expect(body.data.capabilities.canUpdateInvoiceCollection.enabled).toBe(true);

    // The SOL-28 review gate closed on 2026-08-22 (revision 7 concurred, CEO
    // confirmation b6701b4e): quotation and variation-order writes are
    // enabled for the studio owner. The SOL-25 slice has merged (Founding
    // Engineer concurrence, SOL-107), so invoice draft and issue are enabled
    // for the owner too. SOL-132 (CEO confirmation 79974dba, option B)
    // enables the split-payment write for the owner.
    expect(body.data.capabilities.canWriteVariationOrder.enabled).toBe(true);
    expect(body.data.capabilities.canWriteInvoiceDraft.enabled).toBe(true);
    expect(body.data.capabilities.canIssueInvoice.enabled).toBe(true);
    expect(body.data.capabilities.canRecordInvoicePayment.enabled).toBe(true);

    expect(body.meta.apiVersion).toBe('2026-06-23');
    expect(body.meta.requestId).toBeTruthy();
  });
});
