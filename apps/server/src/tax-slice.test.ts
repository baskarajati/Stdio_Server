/**
 * Acceptance tests for the SOL-25 revision-24 tax surface (SOL-102).
 *
 * Runs against its own scratch database (SOL-134): the suite creates
 * `stdio_tax_slice_<random>` from the admin `DATABASE_URL`, applies the
 * migrations and the Studio Contoh seed, runs, and drops the database again.
 * It never writes TEST- rows into the shared `stdio_dev` database.
 *
 * Pins the SOL-102 acceptance criteria and the highest-value revision-24
 * vectors:
 *
 * - CONDITION 3 (CEO ruling): build 1 gets `426 NATIVE_BUILD_UPGRADE_REQUIRED`
 *   and never consumes the Idempotency-Key; a build-2 replay with the same
 *   key writes exactly once and returns `meta.idempotentReplay: true`;
 *   rejected attempts never consume the key (N66, N67).
 * - Cross-studio rule ids return the identical non-leaking `404
 *   TAX_RULE_NOT_FOUND` (N30).
 * - Stale and foreign `x-stdio-tax-catalog-tag` values return the identical
 *   non-leaking `409 TAX_RULE_CATALOG_CONFLICT` (N60, N64).
 * - Preview money categories (N20), line selection (N31/N53), the B9 result
 *   (N23), guarded custom-rule writes (N37/N38/N59), supplier recordings
 *   (N39/N40/N57/N58), and the issue-operation build gate (N67/N68).
 *
 * Every test uses fresh fixture rows with a `TEST-` prefix; the scratch
 * database makes the suite repeatable and isolates it from every other run.
 */

import { randomUUID } from 'node:crypto';
import { seedDatabase } from '@stdio/db';
import { applyMigrations } from '@stdio/db/testing';
import type { Hono } from 'hono';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, type ServerEnv } from './app';

/** The concrete app type; never `ReturnType<typeof createApp>`. */
type App = Hono<ServerEnv>;

/**
 * One named narrowing helper for response-body reads in this suite. The
 * server under test is the thing being validated, so each read narrows
 * through `typeof` instead of an unchecked inline member-access cast.
 */
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Admin URL used only to create and drop this suite's scratch database. */
const adminUrl = process.env.DATABASE_URL ?? 'postgres://stdio:stdio@localhost:5432/stdio_dev';
const testDb = `stdio_tax_slice_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
const testUrl = adminUrl.replace(/\/[^/]+$/, `/${testDb}`);

const SEED_STUDIO = '00000000-0000-4000-8000-000000000001';
const SEED_OWNER = '00000000-0000-4000-8000-000000000002';
const SEED_PROJECT = '00000000-0000-4000-8000-000000000004';
const SEED_CLIENT = '00000000-0000-4000-8000-000000000003';
const SEED_PURCHASE_ORDER = '00000000-0000-4000-8000-00000000000a';
const OTHER_STUDIO = '00000000-0000-4000-8000-0000000000aa';
const OTHER_USER = '00000000-0000-4000-8000-0000000000bb';

const BUILD_2 = '2';

let pool: pg.Pool;
let app: App;
let token: string = '';
let otherToken: string = '';

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

type HttpResult = {
  status: number;
  body: Record<string, unknown>;
  text: string;
  headers: Headers;
};

async function request(
  method: string,
  path: string,
  opts: { token?: string; headers?: Record<string, string>; body?: unknown } = {},
): Promise<HttpResult> {
  const headers = new Headers(opts.headers ?? {});
  headers.set('Authorization', `Bearer ${opts.token ?? token}`);
  const init: RequestInit = { method, headers };
  if (opts.body !== undefined) {
    init.body = JSON.stringify(opts.body);
  }
  const res = await app.request(path, init);
  const text = await res.text();
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = { raw: text };
  }
  return { status: res.status, body, text, headers: res.headers };
}

function problemCode(body: Record<string, unknown>): string {
  return (body.code as string) ?? '';
}

/** Discovery for the studio: returns the tag, the verified rule and customs. */
async function discover(
  date = '2026-08-01',
  bearer?: string,
): Promise<{ tag: string; body: Record<string, unknown>; status: number }> {
  const result = await request(
    'GET',
    `/tax-rules/resolve?documentIssueDate=${date}&documentCurrency=IDR`,
    bearer ? { token: bearer } : {},
  );
  const rawEtag = result.headers.get('etag') ?? '';
  // The ETag header is `W/"<hex>"`; the canonical tag is the bare hex.
  const tag = rawEtag.replace(/^W\//, '').replace(/^"|"$/g, '');
  return { tag, body: result.body, status: result.status };
}

const verifiedApplication = (_tag: string, confirmationText: string) => ({
  ruleId: 'PPN_STANDARD_2025',
  ruleVersion: 1,
  documentCurrency: 'IDR',
  lineSelections: [{ lineId: 'line-1', selected: true }],
  confirmation: {
    transactionInIndonesia: true,
    fallsWithinPmk131Article3: true,
    noSeparateRegimeApplies: true,
    pkpStatusConfirmed: true,
    acceptedText: confirmationText,
  },
});

function previewBody(
  tag: string,
  confirmationText: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    documentIssueDate: '2026-08-01',
    documentCurrency: 'IDR',
    considerationBeforeDiscount: '850000000.00',
    discount: '0',
    taxApplication: verifiedApplication(tag, confirmationText),
    ...overrides,
  };
}

const previewHeaders = (tag: string) => ({
  'x-businessapp-native-build': '1',
  'x-request-id': randomUUID(),
  'x-stdio-tax-catalog-tag': tag,
  'content-type': 'application/json',
});

const writeHeaders = (tag: string, key: string, build = BUILD_2) => ({
  'x-businessapp-native-build': build,
  'x-request-id': randomUUID(),
  'Idempotency-Key': key,
  'If-Match': `W/"${tag}"`,
  'content-type': 'application/json',
});

async function countSnapshots(documentId: string): Promise<number> {
  return tenantQuery(SEED_STUDIO, async (client) => {
    const res = await client.query(
      `SELECT count(*)::int AS n FROM tax_snapshots WHERE document_id = $1`,
      [documentId],
    );
    return (res.rows[0] as { n: number }).n;
  });
}

async function createQuotationFixture(): Promise<{
  id: string;
  itemId: string;
  entityVersion: string;
}> {
  return tenantQuery(SEED_STUDIO, async (client) => {
    const id = randomUUID();
    const itemId = randomUUID();
    await client.query(
      `INSERT INTO quotations (id, studio_id, quotation_number, title, client_id, project_id, version, status, currency, subtotal_amount, total_amount, quotation_date)
       VALUES ($1, $2, 'TEST-' || left($3::text, 8), 'TEST quotation', $4, $5, 1, 'DRAFT', 'IDR', '850000000.00', '943500000.00', '2026-08-01')`,
      [id, SEED_STUDIO, id, SEED_CLIENT, SEED_PROJECT],
    );
    await client.query(
      `INSERT INTO quotation_items (id, studio_id, quotation_id, line_order, line_type, description, unit, quantity, unit_rate, line_subtotal, line_total)
       VALUES ($1, $2, $3, 1, 'FEE', 'TEST line', 'lot', '1.0000', '850000000.00', '850000000.00', '850000000.00')`,
      [itemId, SEED_STUDIO, id],
    );
    const res = await client.query(`SELECT entity_version FROM quotations WHERE id = $1`, [id]);
    return {
      id,
      itemId,
      entityVersion: (res.rows[0] as { entity_version: string }).entity_version,
    };
  });
}

async function createInvoiceFixture(
  status: 'DRAFT' | 'PAID' = 'DRAFT',
): Promise<{ id: string; entityVersion: string }> {
  return tenantQuery(SEED_STUDIO, async (client) => {
    const id = randomUUID();
    await client.query(
      `INSERT INTO invoices (id, studio_id, invoice_number, client_id, project_id, engagement_id, billing_basis, status, currency, total_amount, created_by_user_id)
       VALUES ($1, $2, 'TEST-INV-' || left($3::text, 8), $4, $5, $6, 'MANUAL', $7, 'IDR', '283050000.00', $8)`,
      [
        id,
        SEED_STUDIO,
        id,
        SEED_CLIENT,
        SEED_PROJECT,
        '00000000-0000-4000-8000-00000000000f',
        status,
        SEED_OWNER,
      ],
    );
    const res = await client.query(`SELECT entity_version FROM invoices WHERE id = $1`, [id]);
    return { id, entityVersion: (res.rows[0] as { entity_version: string }).entity_version };
  });
}

const customDraft = (overrides: Record<string, unknown> = {}) => ({
  label: `TEST rule ${randomUUID().slice(0, 8)}`,
  code: `TR-${randomUUID().slice(0, 8)}`,
  effectiveFrom: '2026-01-01',
  effectiveTo: null,
  sources: [
    {
      authority: 'user',
      title: 'TEST source',
      url: 'https://example.com/source',
      publishedAt: '2026-01-01',
      retrievedAt: '2026-08-01T00:00:00.000Z',
    },
  ],
  disclaimerText: 'TEST disclaimer',
  unverifiedAcknowledgment: { accepted: true, acceptedText: 'TEST ack' },
  calculationMode: 'RATIONAL_RATE',
  statutoryRateNumerator: '11',
  statutoryRateDenominator: '100',
  dppFactorNumerator: '1',
  dppFactorDenominator: '1',
  ...overrides,
});

beforeAll(async () => {
  const creator = new pg.Client({ connectionString: adminUrl });
  await creator.connect();
  await creator.query(`CREATE DATABASE ${testDb}`);
  await creator.end();

  await applyMigrations(testUrl);
  await seedDatabase(testUrl);

  pool = new pg.Pool({ connectionString: testUrl, max: 5 });
  app = createApp(pool);
  token = `naa_test_${randomUUID()}`;
  otherToken = `naa_test_${randomUUID()}`;
  await mintToken(SEED_STUDIO, SEED_OWNER, token);

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
      `INSERT INTO access_tokens (studio_id, user_id, token, expires_at)
       VALUES ($1, $2, $3, now() + interval '1 hour') ON CONFLICT DO NOTHING`,
      [OTHER_STUDIO, OTHER_USER, otherToken],
    );
  });

  // Repeatable fixtures: drop every TEST- row the suite may create. Tax rows
  // (rules, snapshots, supplier recordings) are immutable by design (the
  // migration installs an UPDATE/DELETE trigger), so the suite never deletes
  // them; every test uses a unique id so runs never collide.
  await tenantQuery(SEED_STUDIO, async (client) => {
    await client.query(
      `DELETE FROM quotation_items WHERE quotation_id IN (SELECT id FROM quotations WHERE quotation_number LIKE 'TEST-%')`,
    );
    await client.query(`DELETE FROM quotations WHERE quotation_number LIKE 'TEST-%'`);
    await client.query(`DELETE FROM invoices WHERE invoice_number LIKE 'TEST-INV-%'`);
    // Tax rows (rules, snapshots, supplier recordings) are immutable by
    // design (the migration installs an UPDATE/DELETE trigger), so the suite
    // never deletes them; every test uses a unique id so runs never collide.
  });
});

afterAll(async () => {
  await pool.end();
  const cleaner = new pg.Client({ connectionString: adminUrl });
  await cleaner.connect();
  await cleaner.query(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
    [testDb],
  );
  await cleaner.query(`DROP DATABASE IF EXISTS ${testDb}`);
  await cleaner.end();
}, 30_000);

describe('SOL-25 tax discovery', () => {
  it('resolves the verified rule for a date and returns the catalog ETag (N71)', async () => {
    const { status, body, tag } = await discover();
    expect(status).toBe(200);
    expect(tag.length).toBeGreaterThan(0);
    const data = body.data as Record<string, unknown>;
    expect(data.documentIssueDate).toBe('2026-08-01');
    expect(data.documentCurrency).toBe('IDR');
    const rule = data.resolvedVerifiedRule as Record<string, unknown>;
    expect(rule.id).toBe('PPN_STANDARD_2025');
    expect(rule.version).toBe(1);
    expect(rule.ownerType).toBe('CENTRAL');
    expect(rule.studioId).toBeNull();
    expect(rule.status).toBe('VERIFIED');
    expect(rule.code).toBe('PPN_STANDARD_2025');
    expect(rule.effectiveFrom).toBe('2025-01-01');
    expect((rule.verifiedEvidence as unknown[]).length).toBeGreaterThan(0);
    expect(Array.isArray(data.customRules)).toBe(true);
  });

  it('returns null verified rule before the register starts (N27)', async () => {
    const { status, body } = await discover('2024-12-31');
    expect(status).toBe(200);
    const data = body.data as Record<string, unknown>;
    expect(data.resolvedVerifiedRule).toBeNull();
  });

  it('rejects a missing date and a non-IDR currency', async () => {
    const missing = await request('GET', '/tax-rules/resolve?documentCurrency=IDR');
    expect(missing.status).toBe(400);
    const badCurrency = await request(
      'GET',
      '/tax-rules/resolve?documentIssueDate=2026-08-01&documentCurrency=USD',
    );
    expect(badCurrency.status).toBeGreaterThanOrEqual(400);
    expect(badCurrency.status).toBeLessThan(500);
  });
});

describe('SOL-25 tax preview', () => {
  it('returns the exact B9 rational result and persists nothing (N23, N71)', async () => {
    const { tag, body: discovery } = await discover();
    const rule = asRecord(asRecord(discovery.data).resolvedVerifiedRule);
    const result = await request('POST', '/tax-calculations', {
      headers: previewHeaders(tag),
      body: previewBody(tag, rule.applicabilityConfirmationText as string),
    });
    expect(result.status).toBe(200);
    expect(result.headers.get('etag')).toBeNull();
    const data = result.body.data as Record<string, unknown>;
    const calc = data.result as Record<string, unknown>;
    expect(calc.calculationMode).toBe('RATIONAL_RATE');
    expect(calc.ruleId).toBe('PPN_STANDARD_2025');
    expect(calc.dppRounded).toBe('779166667.00');
    expect(calc.ppnRounded).toBe('93500000.00');
    expect(calc.total).toBe('943500000.00');
    expect(calc.taxableBase).toBe('850000000.00');
  });

  it('rejects a missing catalog tag with 400 TAX_CATALOG_TAG_REQUIRED (N64)', async () => {
    const { body: discovery } = await discover();
    const rule = asRecord(asRecord(discovery.data).resolvedVerifiedRule);
    const withTag = previewHeaders('tag');
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(withTag)) {
      if (name !== 'x-stdio-tax-catalog-tag') {
        headers[name] = value;
      }
    }
    const result = await request('POST', '/tax-calculations', {
      headers,
      body: previewBody('tag', rule.applicabilityConfirmationText as string),
    });
    expect(result.status).toBe(400);
    expect(problemCode(result.body)).toBe('TAX_CATALOG_TAG_REQUIRED');
  });

  it('rejects all-false line selections with TAX_LINE_SELECTION_EMPTY (N53)', async () => {
    const { tag, body: discovery } = await discover();
    const rule = asRecord(asRecord(discovery.data).resolvedVerifiedRule);
    const body = previewBody(tag, rule.applicabilityConfirmationText as string);
    body.taxApplication.lineSelections = [{ lineId: 'line-1', selected: false }];
    const result = await request('POST', '/tax-calculations', {
      headers: previewHeaders(tag),
      body,
    });
    expect(result.status).toBe(422);
    expect(problemCode(result.body)).toBe('TAX_LINE_SELECTION_EMPTY');
  });

  it('rejects duplicate line ids with TAX_LINE_SELECTION_INVALID (N31)', async () => {
    const { tag, body: discovery } = await discover();
    const rule = asRecord(asRecord(discovery.data).resolvedVerifiedRule);
    const body = previewBody(tag, rule.applicabilityConfirmationText as string);
    body.taxApplication.lineSelections = [
      { lineId: 'line-1', selected: true },
      { lineId: 'line-1', selected: false },
    ];
    const result = await request('POST', '/tax-calculations', {
      headers: previewHeaders(tag),
      body,
    });
    expect(result.status).toBe(422);
    expect(problemCode(result.body)).toBe('TAX_LINE_SELECTION_INVALID');
  });

  it('rejects a discount above the consideration with TAX_AMOUNT_INVALID', async () => {
    const { tag, body: discovery } = await discover();
    const rule = asRecord(asRecord(discovery.data).resolvedVerifiedRule);
    const result = await request('POST', '/tax-calculations', {
      headers: previewHeaders(tag),
      body: previewBody(tag, rule.applicabilityConfirmationText as string, {
        discount: '900000000.00',
      }),
    });
    expect(result.status).toBe(422);
    expect(problemCode(result.body)).toBe('TAX_AMOUNT_INVALID');
  });

  it('rejects malformed, inexact and out-of-range money with the exact codes (N20)', async () => {
    const { tag, body: discovery } = await discover();
    const rule = asRecord(asRecord(discovery.data).resolvedVerifiedRule);
    const confirmation = rule.applicabilityConfirmationText as string;

    const malformed = await request('POST', '/tax-calculations', {
      headers: previewHeaders(tag),
      body: previewBody(tag, confirmation, { considerationBeforeDiscount: '1.' }),
    });
    expect(malformed.status).toBe(422);
    expect(problemCode(malformed.body)).toBe('MONEY_FORMAT_INVALID');

    const inexact = await request('POST', '/tax-calculations', {
      headers: previewHeaders(tag),
      body: previewBody(tag, confirmation, { considerationBeforeDiscount: 2 ** 53 }),
    });
    expect(inexact.status).toBe(422);
    expect(problemCode(inexact.body)).toBe('MONEY_NOT_EXACT');

    const outOfRange = await request('POST', '/tax-calculations', {
      headers: previewHeaders(tag),
      body: previewBody(tag, confirmation, {
        considerationBeforeDiscount: '999999999999999999999999.00',
      }),
    });
    expect(outOfRange.status).toBe(422);
    expect(problemCode(outOfRange.body)).toBe('MONEY_OUT_OF_RANGE');
  });

  it('rejects a custom-rule version that is no longer the latest with TAX_RULE_VERSION_STALE', async () => {
    // Create a custom rule, append version 2, then preview with version 1.
    const { tag } = await discover();
    const created = await request('POST', '/tax-rules/custom', {
      headers: writeHeaders(tag, `key-${randomUUID()}`),
      body: customDraft(),
    });
    const rule = asRecord(created.body.data).rule as Record<string, unknown>;
    const append = await request('POST', `/tax-rules/custom/${rule.id}/versions`, {
      headers: writeHeaders(rule.entityVersion as string, `key-${randomUUID()}`),
      body: customDraft({ code: rule.code as string, label: 'TEST rule v2' }),
    });
    expect(append.status).toBe(201);
    expect(asRecord(append.body.data).rule).toMatchObject({ version: 2 });

    // The catalog tag moved when v2 landed; re-discover for the current tag.
    const { tag: currentTag } = await discover();
    const result = await request('POST', '/tax-calculations', {
      headers: previewHeaders(currentTag),
      body: {
        documentIssueDate: '2026-08-01',
        documentCurrency: 'IDR',
        considerationBeforeDiscount: '850000000.00',
        discount: '0',
        taxApplication: {
          ruleId: rule.id,
          ruleVersion: 1,
          documentCurrency: 'IDR',
          lineSelections: [{ lineId: 'line-1', selected: true }],
          customRuleAcknowledgment: { customUnverified: true, acceptedText: 'ack' },
        },
      },
    });
    expect(result.status).toBe(422);
    expect(problemCode(result.body)).toBe('TAX_RULE_VERSION_STALE');
  });

  it('rejects a manual-override currency that differs from the request with TAX_CURRENCY_MISMATCH', async () => {
    const { tag } = await discover();
    const result = await request('POST', '/tax-calculations', {
      headers: previewHeaders(tag),
      body: {
        documentIssueDate: '2026-08-01',
        documentCurrency: 'IDR',
        considerationBeforeDiscount: '850000000.00',
        discount: '0',
        taxApplication: {
          lineSelections: [{ lineId: 'line-1', selected: true }],
          manualOverride: {
            label: 'TEST override',
            amount: '1000000',
            taxAmountCurrency: 'IDR',
            documentCurrency: 'USD',
            reason: 'TEST reason',
            source: 'TEST source',
            lineIds: ['line-1'],
            exchangeRateEvidence: null,
          },
          recordingAcknowledgment: {
            recordedOutsideStdio: true,
            notVerifiedTreatment: true,
            acceptedText: 'ack',
          },
        },
      },
    });
    expect(result.status).toBe(422);
    expect(problemCode(result.body)).toBe('TAX_CURRENCY_MISMATCH');
  });

  it('returns the IDENTICAL non-leaking 409 for stale and foreign catalog tags (N64, acceptance)', async () => {
    const { body: discovery } = await discover();
    const rule = asRecord(asRecord(discovery.data).resolvedVerifiedRule);
    const confirmation = rule.applicabilityConfirmationText as string;

    const stale = await request('POST', '/tax-calculations', {
      headers: previewHeaders('deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef'),
      body: previewBody('deadbeef', confirmation),
    });
    const { tag: foreignTag } = await discover('2026-08-01', otherToken);
    const foreign = await request('POST', '/tax-calculations', {
      headers: previewHeaders(foreignTag),
      body: previewBody(foreignTag, confirmation),
    });

    expect(stale.status).toBe(409);
    expect(foreign.status).toBe(409);
    expect(problemCode(stale.body)).toBe('TAX_RULE_CATALOG_CONFLICT');
    expect(problemCode(foreign.body)).toBe('TAX_RULE_CATALOG_CONFLICT');
    // Identical bodies (modulo the per-request requestId): same title,
    // detail and code; no tag disclosure.
    const comparable = (body: Record<string, unknown>) => ({
      type: body.type,
      title: body.title,
      status: body.status,
      detail: body.detail,
      code: body.code,
    });
    expect(comparable(stale.body)).toEqual(comparable(foreign.body));
    expect(JSON.stringify(stale.body)).not.toContain('deadbeef');
  });
});

describe('SOL-25 guarded custom-rule writes', () => {
  it('gates the write path at build 1 with 426 and writes nothing (section 9.9)', async () => {
    const { tag } = await discover();
    const key = `key-${randomUUID()}`;
    const result = await request('POST', '/tax-rules/custom', {
      headers: writeHeaders(tag, key, '1'),
      body: customDraft(),
    });
    expect(result.status).toBe(426);
    expect(problemCode(result.body)).toBe('NATIVE_BUILD_UPGRADE_REQUIRED');
    const details = asRecord(asRecord(result.body).details);
    expect(details.minimumSupportedBuild).toBe(2);
    expect(details.requestBuild).toBe(1);
  });

  it('creates version 1 with the current catalog tag, then replays exactly once (N59)', async () => {
    const { tag } = await discover();
    const key = `key-${randomUUID()}`;
    const draft = customDraft();

    const created = await request('POST', '/tax-rules/custom', {
      headers: writeHeaders(tag, key),
      body: draft,
    });
    expect(created.status).toBe(201);
    expect(problemCode(created.body)).toBe('');
    const data = created.body.data as Record<string, unknown>;
    const rule = data.rule as Record<string, unknown>;
    expect(rule.version).toBe(1);
    expect(rule.ownerType).toBe('STUDIO');
    expect(rule.status).toBe('CUSTOM_UNVERIFIED');
    expect(rule.label).toBe(draft.label);
    const metaBody = created.body.meta as Record<string, unknown>;
    expect(metaBody.idempotentReplay).toBe(false);
    expect(created.headers.get('etag')?.length).toBeGreaterThan(0);
    const newTag = created.headers.get('etag') as string;
    expect(newTag).not.toBe(`W/"${tag}"`);

    // Replay with the original body and tag: 200, idempotentReplay true, no
    // second row.
    const replay = await request('POST', '/tax-rules/custom', {
      headers: writeHeaders(newTag.replace(/^W\//, ''), key),
      body: draft,
    });
    expect(replay.status).toBe(200);
    expect(asRecord(replay.body.meta).idempotentReplay).toBe(true);

    const count = await tenantQuery(SEED_STUDIO, async (client) => {
      const res = await client.query(`SELECT count(*)::int AS n FROM tax_rules WHERE id = $1`, [
        rule.id,
      ]);
      return (res.rows[0] as { n: number }).n;
    });
    expect(count).toBe(1);
  });

  it('rejects a stale or foreign catalog If-Match with the identical 409 (N60, acceptance)', async () => {
    await discover();
    const stale = await request('POST', '/tax-rules/custom', {
      headers: writeHeaders(
        'stale-stale-stale-stale-stale-stale-stale-stale',
        `key-${randomUUID()}`,
      ),
      body: customDraft(),
    });
    const { tag: foreignTag } = await discover('2026-08-01', otherToken);
    const foreign = await request('POST', '/tax-rules/custom', {
      headers: writeHeaders(foreignTag, `key-${randomUUID()}`),
      body: customDraft(),
    });
    expect(stale.status).toBe(409);
    expect(foreign.status).toBe(409);
    expect(problemCode(stale.body)).toBe('TAX_RULE_CATALOG_CONFLICT');
    expect(problemCode(foreign.body)).toBe('TAX_RULE_CATALOG_CONFLICT');
    const comparable = (body: Record<string, unknown>) => ({
      type: body.type,
      title: body.title,
      status: body.status,
      detail: body.detail,
      code: body.code,
    });
    expect(comparable(stale.body)).toEqual(comparable(foreign.body));
    expect(JSON.stringify(stale.body)).not.toContain('stale');
  });

  it('rejects the reserved preset code with TAX_RULE_CODE_RESERVED (N37)', async () => {
    const { tag } = await discover();
    const result = await request('POST', '/tax-rules/custom', {
      headers: writeHeaders(tag, `key-${randomUUID()}`),
      body: customDraft({ code: 'PPN_STANDARD_2025' }),
    });
    expect(result.status).toBe(422);
    expect(problemCode(result.body)).toBe('TAX_RULE_CODE_RESERVED');
  });

  it('appends versions and rejects a stale entity If-Match (N38)', async () => {
    const { tag } = await discover();
    const key = `key-${randomUUID()}`;
    const draft = customDraft();
    const created = await request('POST', '/tax-rules/custom', {
      headers: writeHeaders(tag, key),
      body: draft,
    });
    const rule = asRecord(created.body.data).rule as Record<string, unknown>;

    const append = await request('POST', `/tax-rules/custom/${rule.id}/versions`, {
      headers: writeHeaders(rule.entityVersion as string, `key-${randomUUID()}`),
      body: customDraft({ code: rule.code as string, label: 'TEST rule v2' }),
    });
    expect(append.status).toBe(201);
    const v2 = asRecord(append.body.data).rule as Record<string, unknown>;
    expect(v2.version).toBe(2);

    const stale = await request('POST', `/tax-rules/custom/${rule.id}/versions`, {
      headers: writeHeaders(rule.entityVersion as string, `key-${randomUUID()}`),
      body: customDraft({ code: rule.code as string, label: 'TEST rule v3' }),
    });
    expect(stale.status).toBe(409);
    expect(problemCode(stale.body)).toBe('ENTITY_VERSION_CONFLICT');

    // The prior version is byte-unchanged.
    const prior = await tenantQuery(SEED_STUDIO, async (client) => {
      const res = await client.query(`SELECT label FROM tax_rules WHERE id = $1 AND version = 1`, [
        rule.id,
      ]);
      return (res.rows[0] as { label: string }).label;
    });
    expect(prior).toBe(draft.label);
  });

  it('returns the non-leaking 404 for a cross-studio rule id (acceptance, N30)', async () => {
    const { tag, body: discovery } = await discover();
    const rule = asRecord(asRecord(discovery.data).resolvedVerifiedRule);
    // Create a rule in the OTHER studio, then reference it from studio 1.
    const { tag: otherTag } = await discover('2026-08-01', otherToken);
    const other = await request('POST', '/tax-rules/custom', {
      headers: writeHeaders(otherTag, `key-${randomUUID()}`, BUILD_2),
      body: customDraft({ label: 'TEST rule other' }),
      token: otherToken,
    });
    const otherRule = asRecord(other.body.data).rule as Record<string, unknown>;

    const viaPreview = await request('POST', '/tax-calculations', {
      headers: previewHeaders(tag),
      body: {
        ...previewBody(tag, rule.applicabilityConfirmationText as string),
        taxApplication: {
          ruleId: otherRule.id,
          ruleVersion: 1,
          documentCurrency: 'IDR',
          lineSelections: [{ lineId: 'line-1', selected: true }],
          customRuleAcknowledgment: { customUnverified: true, acceptedText: 'ack' },
        },
      },
    });
    expect(viaPreview.status).toBe(404);
    expect(problemCode(viaPreview.body)).toBe('TAX_RULE_NOT_FOUND');

    const viaVersions = await request('POST', `/tax-rules/custom/${otherRule.id}/versions`, {
      headers: writeHeaders(tag, `key-${randomUUID()}`, BUILD_2),
      body: customDraft(),
    });
    expect(viaVersions.status).toBe(404);
    expect(problemCode(viaVersions.body)).toBe('TAX_RULE_NOT_FOUND');
    // Identical non-leaking bodies (modulo the per-request requestId).
    const comparable = (body: Record<string, unknown>) => ({
      type: body.type,
      title: body.title,
      status: body.status,
      detail: body.detail,
      code: body.code,
    });
    expect(comparable(viaPreview.body)).toEqual(comparable(viaVersions.body));

    // The foreign rule is invisible in studio-1 discovery.
    const { body: studio1Discovery } = await discover();
    const customRules = asRecord(studio1Discovery.data).customRules;
    expect(Array.isArray(customRules)).toBe(true);
    const ids = (customRules as unknown[]).map((entry) =>
      typeof entry === 'object' && entry !== null ? (entry as { id?: unknown }).id : undefined,
    );
    expect(ids).not.toContain(otherRule.id);
  });

  it('never consumes the idempotency key on a rejected write (condition 3)', async () => {
    const { tag } = await discover();
    const key = `key-${randomUUID()}`;
    const draft = customDraft();
    const rejected = await request('POST', '/tax-rules/custom', {
      headers: writeHeaders('stale-stale-stale-stale-stale-stale-stale-stale', key),
      body: draft,
    });
    expect(rejected.status).toBe(409);

    // The same key with the correct tag proceeds as a first write (201),
    // proving the rejected attempt recorded nothing.
    const retried = await request('POST', '/tax-rules/custom', {
      headers: writeHeaders(tag, key),
      body: draft,
    });
    expect(retried.status).toBe(201);
    expect(asRecord(retried.body.meta).idempotentReplay).toBe(false);
  });
});

describe('SOL-25 supplier tax recordings', () => {
  const recordingBody = (overrides: Record<string, unknown> = {}) => ({
    supplierDocumentReference: `SR-${randomUUID().slice(0, 8)}`,
    label: 'TEST supplier tax',
    documentCurrency: 'IDR',
    dppAmount: '100000.00',
    taxAmount: '12000.00',
    exchangeRateEvidence: null,
    source: {
      authority: 'user',
      title: 'TEST source',
      url: 'https://example.com/source',
      publishedAt: '2026-01-01',
      retrievedAt: '2026-08-01T00:00:00.000Z',
    },
    acknowledgment: { accepted: true, acceptedText: 'TEST ack' },
    ...overrides,
  });

  async function poEntityVersion(): Promise<string> {
    return tenantQuery(SEED_STUDIO, async (client) => {
      const res = await client.query(`SELECT entity_version FROM purchase_orders WHERE id = $1`, [
        SEED_PURCHASE_ORDER,
      ]);
      return (res.rows[0] as { entity_version: string }).entity_version;
    });
  }

  it('records an IDR supplier tax leaf with an ETag (N39, N57)', async () => {
    const poVersion = await poEntityVersion();
    const result = await request(
      'POST',
      `/purchase-orders/${SEED_PURCHASE_ORDER}/supplier-tax-recordings`,
      {
        headers: writeHeaders(poVersion, `key-${randomUUID()}`),
        body: recordingBody(),
      },
    );
    expect(result.status).toBe(201);
    const leaf = asRecord(asRecord(result.body.data).supplierTaxRecording);
    expect(leaf.status).toBe('CUSTOM_UNVERIFIED');
    expect(leaf.documentCurrency).toBe('IDR');
    expect(leaf.dppAmount).toBe('100000.00');
    expect(leaf.taxAmount).toBe('12000.00');
    expect(leaf.exchangeRateEvidence).toBeNull();
    expect(leaf.acceptedConfirmationText).toBe('TEST ack');
    expect(leaf.purchaseOrderId).toBe(SEED_PURCHASE_ORDER);
    expect(result.headers.get('etag')?.length).toBeGreaterThan(0);
  });

  it('rejects a duplicate supplier reference with 409 SUPPLIER_TAX_RECORDING_CONFLICT (N39)', async () => {
    const poVersion = await poEntityVersion();
    const body = recordingBody();
    const first = await request(
      'POST',
      `/purchase-orders/${SEED_PURCHASE_ORDER}/supplier-tax-recordings`,
      { headers: writeHeaders(poVersion, `key-${randomUUID()}`), body },
    );
    expect(first.status).toBe(201);
    const second = await request(
      'POST',
      `/purchase-orders/${SEED_PURCHASE_ORDER}/supplier-tax-recordings`,
      { headers: writeHeaders(poVersion, `key-${randomUUID()}`), body },
    );
    expect(second.status).toBe(409);
    expect(problemCode(second.body)).toBe('SUPPLIER_TAX_RECORDING_CONFLICT');
  });

  it('rejects evidence violations for IDR and non-IDR recordings (N10, N11)', async () => {
    const poVersion = await poEntityVersion();
    const idrWithEvidence = await request(
      'POST',
      `/purchase-orders/${SEED_PURCHASE_ORDER}/supplier-tax-recordings`,
      {
        headers: writeHeaders(poVersion, `key-${randomUUID()}`),
        body: recordingBody({ exchangeRateEvidence: 'evidence' }),
      },
    );
    expect(idrWithEvidence.status).toBe(422);

    const nonIdrNoEvidence = await request(
      'POST',
      `/purchase-orders/${SEED_PURCHASE_ORDER}/supplier-tax-recordings`,
      {
        headers: writeHeaders(poVersion, `key-${randomUUID()}`),
        body: recordingBody({ documentCurrency: 'USD', exchangeRateEvidence: null }),
      },
    );
    expect(nonIdrNoEvidence.status).toBe(422);
    expect(problemCode(nonIdrNoEvidence.body)).toBe('TAX_RECORDING_EVIDENCE_INVALID');
  });
});

describe('SOL-25 issue operations and condition 3', () => {
  it('CONDITION 3: build 1 gets 426, build-2 replay with the same key writes exactly once (N66, N67)', async () => {
    const { tag, body: discovery } = await discover();
    const rule = asRecord(asRecord(discovery.data).resolvedVerifiedRule);
    const quotation = await createQuotationFixture();
    const path = `/projects/${SEED_PROJECT}/quotations/${quotation.id}/send`;
    const key = `key-${randomUUID()}`;
    const application = {
      taxApplication: {
        ...verifiedApplication(tag, rule.applicabilityConfirmationText as string),
        lineSelections: [{ lineId: quotation.itemId, selected: true }],
      },
    };

    // Build 1: 426 before body validation and before the idempotency lookup.
    const build1 = await request('POST', path, {
      headers: {
        'x-businessapp-native-build': '1',
        'x-request-id': randomUUID(),
        'Idempotency-Key': key,
        'If-Match': `W/"${quotation.entityVersion}"`,
        'x-stdio-tax-catalog-tag': tag,
        'content-type': 'application/json',
      },
      body: application,
    });
    expect(build1.status).toBe(426);
    expect(problemCode(build1.body)).toBe('NATIVE_BUILD_UPGRADE_REQUIRED');
    const details = asRecord(asRecord(build1.body).details);
    expect(details.minimumSupportedBuild).toBe(2);
    expect(details.requestBuild).toBe(1);

    // Build 2 with the same key: the first successful write (201).
    const build2 = await request('POST', path, {
      headers: {
        'x-businessapp-native-build': '2',
        'x-request-id': randomUUID(),
        'Idempotency-Key': key,
        'If-Match': `W/"${quotation.entityVersion}"`,
        'x-stdio-tax-catalog-tag': tag,
        'content-type': 'application/json',
      },
      body: application,
    });
    expect(build2.status).toBe(201);
    const build2Body = build2.body as Record<string, unknown>;
    expect(asRecord(build2Body.meta).idempotentReplay).toBe(false);
    const snapshot = asRecord(asRecord(build2Body.data).taxSnapshot);
    expect(snapshot.ruleId).toBe('PPN_STANDARD_2025');
    expect(snapshot.documentId).toBe(quotation.id);
    expect(await countSnapshots(quotation.id)).toBe(1);

    // Replay the same key/body/tag: 200, idempotentReplay true, no second
    // snapshot, and the stale catalog precondition is never evaluated.
    const replay = await request('POST', path, {
      headers: {
        'x-businessapp-native-build': '2',
        'x-request-id': randomUUID(),
        'Idempotency-Key': key,
        'If-Match': `W/"${quotation.entityVersion}"`,
        'x-stdio-tax-catalog-tag': tag,
        'content-type': 'application/json',
      },
      body: application,
    });
    expect(replay.status).toBe(200);
    expect(asRecord(replay.body.meta).idempotentReplay).toBe(true);
    expect(await countSnapshots(quotation.id)).toBe(1);

    // Same key, different body: 409 IDEMPOTENCY_KEY_REUSED, nothing written.
    const reused = await request('POST', path, {
      headers: {
        'x-businessapp-native-build': '2',
        'x-request-id': randomUUID(),
        'Idempotency-Key': key,
        'If-Match': `W/"${quotation.entityVersion}"`,
        'x-stdio-tax-catalog-tag': tag,
        'content-type': 'application/json',
      },
      body: { taxApplication: null },
    });
    expect(reused.status).toBe(409);
    expect(problemCode(reused.body)).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(await countSnapshots(quotation.id)).toBe(1);
  });

  it('rejects the legacy taxEvidence body with 422 TAX_RULE_UNAVAILABLE (N15, N16, N67)', async () => {
    const invoice = await createInvoiceFixture('DRAFT');
    const result = await request(
      'POST',
      `/projects/${SEED_PROJECT}/finance/invoices/${invoice.id}/issue`,
      {
        headers: {
          'x-businessapp-native-build': '2',
          'x-request-id': randomUUID(),
          'Idempotency-Key': `key-${randomUUID()}`,
          'If-Match': `W/"${invoice.entityVersion}"`,
          'content-type': 'application/json',
        },
        body: { taxEvidence: null },
      },
    );
    expect(result.status).toBe(422);
    expect(problemCode(result.body)).toBe('TAX_RULE_UNAVAILABLE');
    expect(await countSnapshots(invoice.id)).toBe(0);
  });

  it('gates invoice issue at build 1 with 426 (N67, N68)', async () => {
    const invoice = await createInvoiceFixture('DRAFT');
    const result = await request(
      'POST',
      `/projects/${SEED_PROJECT}/finance/invoices/${invoice.id}/issue`,
      {
        headers: {
          'x-request-id': randomUUID(),
          'Idempotency-Key': `key-${randomUUID()}`,
          'If-Match': `W/"${invoice.entityVersion}"`,
          'content-type': 'application/json',
        },
        body: {},
      },
    );
    expect(result.status).toBe(426);
    expect(problemCode(result.body)).toBe('NATIVE_BUILD_UPGRADE_REQUIRED');
    const details = asRecord(asRecord(result.body).details);
    expect(details.requestBuild).toBe(0);
  });

  it('rejects a tag with null taxApplication and a missing tag with an application (N65)', async () => {
    const { tag } = await discover();
    const quotation = await createQuotationFixture();
    const path = `/projects/${SEED_PROJECT}/quotations/${quotation.id}/send`;

    const unexpected = await request('POST', path, {
      headers: {
        'x-businessapp-native-build': '2',
        'x-request-id': randomUUID(),
        'Idempotency-Key': `key-${randomUUID()}`,
        'If-Match': `W/"${quotation.entityVersion}"`,
        'x-stdio-tax-catalog-tag': tag,
        'content-type': 'application/json',
      },
      body: { taxApplication: null },
    });
    expect(unexpected.status).toBe(422);
    expect(problemCode(unexpected.body)).toBe('TAX_CATALOG_TAG_UNEXPECTED');

    const { body: discovery } = await discover();
    const rule = asRecord(asRecord(discovery.data).resolvedVerifiedRule);
    const required = await request('POST', path, {
      headers: {
        'x-businessapp-native-build': '2',
        'x-request-id': randomUUID(),
        'Idempotency-Key': `key-${randomUUID()}`,
        'If-Match': `W/"${quotation.entityVersion}"`,
        'content-type': 'application/json',
      },
      body: {
        taxApplication: verifiedApplication(tag, rule.applicabilityConfirmationText as string),
      },
    });
    expect(required.status).toBe(422);
    expect(problemCode(required.body)).toBe('TAX_CATALOG_TAG_REQUIRED');
  });

  it('returns 404 for the milestone invoice until the milestone register exists', async () => {
    const result = await request(
      'POST',
      `/projects/${SEED_PROJECT}/finance/milestones/${randomUUID()}/invoice`,
      {
        headers: {
          'x-request-id': randomUUID(),
          'Idempotency-Key': `key-${randomUUID()}`,
          'content-type': 'application/json',
        },
        body: { dueDate: '2026-09-01' },
      },
    );
    expect(result.status).toBe(404);
    expect(problemCode(result.body)).toBe('MILESTONE_NOT_FOUND');
  });
});
