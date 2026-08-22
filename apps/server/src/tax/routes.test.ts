/**
 * SOL-25 revision-24 tax route tests. SOL-100.
 *
 * The suite owns a scratch database: create -> migrations (central register
 * included) -> tenant fixtures -> route assertions -> drop. Money assertions
 * use the approved revision-24 vectors (B9 / B15 / Q25-10): the quotation
 * example Rp750,000.00 with Rp75,000.00 discount yields DPP 618,750.00,
 * PPN 74,250.00, total 749,250.00.
 *
 * CEO condition 3 (N66) is pinned here end-to-end: a build-1 request with the
 * legacy body gets exactly 426 and consumes no key; a build-2 replay of the
 * same Idempotency-Key writes exactly once (200, meta.idempotentReplay true,
 * no second document or snapshot); the same key with a different body is
 * 409 IDEMPOTENCY_KEY_REUSED.
 */

import { randomUUID } from 'node:crypto';

import { PPN_STANDARD_2025 } from '@stdio/core';
import { applyMigrations } from '@stdio/db/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../app';

const adminUrl = process.env.DATABASE_URL ?? 'postgres://stdio:stdio@localhost:5432/stdio_dev';
const testDb = `stdio_tax_route_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
const testUrl = adminUrl.replace(/\/[^/]+$/, `/${testDb}`);

const IDS = {
  studio: randomUUID(),
  owner: randomUUID(),
  pm: randomUUID(),
  client: randomUUID(),
  project: randomUUID(),
  engagement: randomUUID(),
  quotation: randomUUID(),
  quotationItemA: randomUUID(),
  quotationItemB: randomUUID(),
  invoice: randomUUID(),
  purchaseOrder: randomUUID(),
  vendor: randomUUID(),
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

async function mintToken(): Promise<void> {
  token = `naa_tax_test_${randomUUID()}`;
  await tenant(async (client) => {
    await client.query(
      `INSERT INTO access_tokens (studio_id, user_id, token, expires_at)
       VALUES ($1, $2, $3, now() + interval '1 hour')`,
      [IDS.studio, IDS.owner, token],
    );
  });
}

async function seedFixtures(): Promise<void> {
  await tenant(async (client) => {
    await client.query(
      `INSERT INTO studios (studio_id, name, currency, timezone)
       VALUES ($1, 'Studio Pajak', 'IDR', 'Asia/Jakarta')`,
      [IDS.studio],
    );
    await client.query(
      `INSERT INTO users (id, studio_id, email, name, role)
       VALUES ($1, $2, 'owner@tax.studio', 'Pemilik', 'OWNER')`,
      [IDS.owner, IDS.studio],
    );
    await client.query(
      `INSERT INTO users (id, studio_id, email, name, role)
       VALUES ($1, $2, 'pm@tax.studio', 'Manajer', 'PM')`,
      [IDS.pm, IDS.studio],
    );
    await client.query(
      `INSERT INTO clients (id, studio_id, client_number, name, company_name, status)
       VALUES ($1, $2, 'CL-TAX', 'PT Pembayar Pajak', 'PT Pembayar Pajak', 'ACTIVE')`,
      [IDS.client, IDS.studio],
    );
    await client.query(
      `INSERT INTO projects (id, studio_id, project_code, name, client_id, status)
       VALUES ($1, $2, 'PRJ-TAX', 'Proyek Pajak', $3, 'ACTIVE')`,
      [IDS.project, IDS.studio, IDS.client],
    );
    await client.query(
      `INSERT INTO project_engagements (id, studio_id, project_id, kind, sort_order,
                                        lifecycle_status, contract_state)
       VALUES ($1, $2, $3, 'BUILD', 1, 'ACTIVE', 'SIGNED')`,
      [IDS.engagement, IDS.studio, IDS.project],
    );
    // Two-line quotation: Rp562,500.00 + Rp187,500.00, document discount
    // Rp75,000.00 (the approved 3:1 allocation vector).
    await client.query(
      `INSERT INTO quotations (id, studio_id, quotation_number, title, client_id, project_id,
                               version, status, currency, subtotal_amount, discount_amount,
                               total_amount)
       VALUES ($1, $2, 'QUO-TAX', 'Penawaran Pajak', $3, $4, 1, 'DRAFT', 'IDR',
               '750000.00', '75000.00', '675000.00')`,
      [IDS.quotation, IDS.studio, IDS.client, IDS.project],
    );
    await client.query(
      `INSERT INTO quotation_items (id, studio_id, quotation_id, line_order, line_type,
                                    description, quantity, unit_rate, line_subtotal, line_total)
       VALUES ($1, $2, $3, 1, 'FEE', 'Jasa desain tahap A', '1.0000', '562500.00',
               '562500.00', '562500.00')`,
      [IDS.quotationItemA, IDS.studio, IDS.quotation],
    );
    await client.query(
      `INSERT INTO quotation_items (id, studio_id, quotation_id, line_order, line_type,
                                    description, quantity, unit_rate, line_subtotal, line_total)
       VALUES ($1, $2, $3, 2, 'FEE', 'Jasa desain tahap B', '1.0000', '187500.00',
               '187500.00', '187500.00')`,
      [IDS.quotationItemB, IDS.studio, IDS.quotation],
    );
    // Draft invoice with a pre-tax total of Rp1,000,000.00.
    await client.query(
      `INSERT INTO invoices (id, studio_id, invoice_number, client_id, project_id,
                             engagement_id, billing_basis, status, currency, total_amount)
       VALUES ($1, $2, 'INV-TAX', $3, $4, $5, 'MANUAL', 'DRAFT', 'IDR', '1000000.00')`,
      [IDS.invoice, IDS.studio, IDS.client, IDS.project, IDS.engagement],
    );
    await client.query(
      `INSERT INTO vendors (id, studio_id, vendor_code, name, category)
       VALUES ($1, $2, 'VEN-TAX', 'CV Pemasok', 'FURNITURE')`,
      [IDS.vendor, IDS.studio],
    );
    await client.query(
      `INSERT INTO purchase_orders (id, studio_id, purchase_order_number, project_id, vendor_id,
                                    status, currency, issue_date, total_amount)
       VALUES ($1, $2, 'PO-TAX', $3, $4, 'CONFIRMED', 'IDR', '2026-08-01', '500000.00')`,
      [IDS.purchaseOrder, IDS.studio, IDS.project, IDS.vendor],
    );
  });
}

async function entityVersion(table: string, id: string): Promise<string> {
  return tenant(async (client) => {
    const res = await client.query(`SELECT entity_version FROM ${table} WHERE id = $1`, [id]);
    return (res.rows[0] as { entity_version: string }).entity_version;
  });
}

/** The common request headers for the tax routes. */
function headers(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'x-request-id': randomUUID(),
    'x-businessapp-native-build': '2',
    'Content-Type': 'application/json',
    ...overrides,
  };
}

/** Resolves the studio catalog and returns the ETag. */
async function resolveCatalog(): Promise<string> {
  const res = await app.request(
    `/tax-rules/resolve?documentIssueDate=2026-08-01&documentCurrency=IDR`,
    { headers: headers() },
  );
  expect(res.status).toBe(200);
  const etag = res.headers.get('ETag') as string;
  // The wire ETag is W/"<hash>"; the tax-catalog-tag and If-Match headers
  // carry the bare hash.
  return etag.replace(/^W\/"/, '').replace(/"$/, '');
}

/** The verified-rational taxApplication for the approved vector. */
function verifiedApplication(lineIds: string[], allSelected = true) {
  return {
    ruleId: 'PPN_STANDARD_2025',
    ruleVersion: 1,
    documentCurrency: 'IDR',
    lineSelections: lineIds.map((lineId) => ({ lineId, selected: allSelected })),
    confirmation: {
      transactionInIndonesia: true,
      fallsWithinPmk131Article3: true,
      noSeparateRegimeApplies: true,
      pkpStatusConfirmed: true,
      acceptedText: PPN_STANDARD_2025.applicabilityConfirmationText,
    },
  };
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
  await mintToken();
}, 90_000);

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

describe('GET /tax-rules/resolve', () => {
  it('returns the verified rule and an ETag for the studio catalog', async () => {
    const res = await app.request(
      `/tax-rules/resolve?documentIssueDate=2026-08-01&documentCurrency=IDR`,
      { headers: headers() },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('ETag')).toBeTruthy();
    const body = (await res.json()) as {
      data: {
        documentIssueDate: string;
        documentCurrency: string;
        resolvedVerifiedRule: { id: string; version: number; statutoryRateNumerator: string };
        customRules: unknown[];
      };
    };
    expect(body.data.documentCurrency).toBe('IDR');
    expect(body.data.resolvedVerifiedRule).toMatchObject({
      id: 'PPN_STANDARD_2025',
      version: 1,
      statutoryRateNumerator: '12',
      dppFactorNumerator: '11',
    });
    expect(body.data.customRules).toEqual([]);
  });

  it('returns null before the rule takes effect (N27)', async () => {
    const res = await app.request(
      `/tax-rules/resolve?documentIssueDate=2024-12-31&documentCurrency=IDR`,
      { headers: headers() },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { resolvedVerifiedRule: unknown } };
    expect(body.data.resolvedVerifiedRule).toBeNull();
  });

  it('rejects a missing date (400) and a non-IDR currency (422)', async () => {
    const missing = await app.request(`/tax-rules/resolve?documentCurrency=IDR`, {
      headers: headers(),
    });
    expect(missing.status).toBe(400);
    const badCurrency = await app.request(
      `/tax-rules/resolve?documentIssueDate=2026-08-01&documentCurrency=USD`,
      { headers: headers() },
    );
    expect(badCurrency.status).toBe(422);
  });

  it('rejects an invalid date with 422', async () => {
    const res = await app.request(
      `/tax-rules/resolve?documentIssueDate=2026-02-30&documentCurrency=IDR`,
      { headers: headers() },
    );
    expect(res.status).toBe(422);
  });

  it('requires authentication (401)', async () => {
    const res = await app.request(
      `/tax-rules/resolve?documentIssueDate=2026-08-01&documentCurrency=IDR`,
    );
    expect(res.status).toBe(401);
  });
});

describe('POST /tax-calculations (preview)', () => {
  const body = {
    documentIssueDate: '2026-08-01',
    documentCurrency: 'IDR',
    considerationBeforeDiscount: '750000.00',
    discount: '75000.00',
    taxApplication: verifiedApplication(['preview-line']),
  };

  it('produces the approved B9 vector exactly', async () => {
    const tag = await resolveCatalog();
    const res = await app.request('/tax-calculations', {
      method: 'POST',
      headers: headers({ 'x-stdio-tax-catalog-tag': tag }),
      body: JSON.stringify({
        ...body,
        taxApplication: verifiedApplication([IDS.quotationItemA, IDS.quotationItemB]),
      }),
    });
    expect(res.status).toBe(200);
    const payload = (await res.json()) as { data: { result: Record<string, string> } };
    expect(payload.data.result).toMatchObject({
      calculationMode: 'RATIONAL_RATE',
      ruleId: 'PPN_STANDARD_2025',
      ruleVersion: 1,
      ruleStatus: 'VERIFIED',
      documentCurrency: 'IDR',
      considerationBeforeDiscount: '750000.00',
      discount: '75000.00',
      taxableBase: '675000.00',
      dppRounded: '618750.00',
      ppnRounded: '74250.00',
      total: '749250.00',
    });
  });

  it('rejects a stale catalog tag with 409 TAX_RULE_CATALOG_CONFLICT (N64)', async () => {
    const res = await app.request('/tax-calculations', {
      method: 'POST',
      headers: headers({ 'x-stdio-tax-catalog-tag': 'stale-tag' }),
      body: JSON.stringify({
        ...body,
        taxApplication: verifiedApplication([IDS.quotationItemA]),
      }),
    });
    expect(res.status).toBe(409);
    const payload = (await res.json()) as { code: string };
    expect(payload.code).toBe('TAX_RULE_CATALOG_CONFLICT');
  });

  it('rejects the recording branch on preview (422 TAX_RULE_MODE_CONFLICT)', async () => {
    const tag = await resolveCatalog();
    const res = await app.request('/tax-calculations', {
      method: 'POST',
      headers: headers({ 'x-stdio-tax-catalog-tag': tag }),
      body: JSON.stringify({
        ...body,
        taxApplication: {
          lineSelections: [{ lineId: IDS.quotationItemA, selected: true }],
          manualOverride: {
            label: 'Override',
            amount: '10000.00',
            taxAmountCurrency: 'IDR',
            documentCurrency: 'IDR',
            reason: 'reason',
            source: 'source',
            lineIds: [IDS.quotationItemA],
            exchangeRateEvidence: null,
          },
          recordingAcknowledgment: {
            recordedOutsideStdio: true,
            notVerifiedTreatment: true,
            acceptedText: 'ok',
          },
        },
      }),
    });
    expect(res.status).toBe(422);
    const payload = (await res.json()) as { code: string };
    expect(payload.code).toBe('TAX_RULE_MODE_CONFLICT');
  });

  it('maps the money rejection categories exactly (N20)', async () => {
    const tag = await resolveCatalog();
    for (const [field, value, code] of [
      ['considerationBeforeDiscount', 'abc', 'MONEY_FORMAT_INVALID'],
      ['considerationBeforeDiscount', 9007199254740992, 'MONEY_NOT_EXACT'],
      ['considerationBeforeDiscount', '1e30', 'MONEY_OUT_OF_RANGE'],
    ] as const) {
      const res = await app.request('/tax-calculations', {
        method: 'POST',
        headers: headers({ 'x-stdio-tax-catalog-tag': tag }),
        body: JSON.stringify({
          ...body,
          [field]: value,
        }),
      });
      expect(res.status).toBe(422);
      const payload = (await res.json()) as { code: string };
      expect(payload.code).toBe(code);
    }
  });

  it('rejects a discount above the consideration (TAX_AMOUNT_INVALID)', async () => {
    const tag = await resolveCatalog();
    const res = await app.request('/tax-calculations', {
      method: 'POST',
      headers: headers({ 'x-stdio-tax-catalog-tag': tag }),
      body: JSON.stringify({
        ...body,
        discount: '900000.00',
      }),
    });
    expect(res.status).toBe(422);
    const payload = (await res.json()) as { code: string };
    expect(payload.code).toBe('TAX_AMOUNT_INVALID');
  });

  it('requires the dedicated headers (400)', async () => {
    const withoutBuild = await app.request('/tax-calculations', {
      method: 'POST',
      headers: headers({ 'x-businessapp-native-build': '' }),
      body: JSON.stringify(body),
    });
    expect(withoutBuild.status).toBe(400);
    const missingTag = await app.request('/tax-calculations', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(body),
    });
    expect(missingTag.status).toBe(400);
  });
});

describe('POST /tax-rules/custom and versions', () => {
  const draft = (overrides: Record<string, unknown> = {}) => ({
    label: 'Aturan Kantor',
    code: 'OFFICE_RULE',
    effectiveFrom: '2026-01-01',
    effectiveTo: null,
    sources: [
      {
        authority: 'DJP_RI',
        title: 'Peraturan contoh',
        url: 'https://www.pajak.go.id/aturan-contoh',
        publishedAt: '2026-01-01',
        retrievedAt: '2026-08-01T00:00:00.000Z',
      },
    ],
    disclaimerText: 'Aturan kantor, bukan nasihat pajak.',
    unverifiedAcknowledgment: { accepted: true, acceptedText: 'dipahami' },
    calculationMode: 'RATIONAL_RATE',
    statutoryRateNumerator: '11',
    statutoryRateDenominator: '100',
    dppFactorNumerator: '10',
    dppFactorDenominator: '11',
    ...overrides,
  });

  it('creates an immutable version 1 and moves the catalog ETag', async () => {
    const tagBefore = await resolveCatalog();
    const res = await app.request('/tax-rules/custom', {
      method: 'POST',
      headers: headers({
        'Idempotency-Key': `create_rule_${randomUUID()}`,
        'If-Match': `"${tagBefore}"`,
      }),
      body: JSON.stringify(draft()),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      data: { rule: { id: string; version: number; status: string; ownerType: string } };
    };
    expect(body.data.rule).toMatchObject({
      version: 1,
      status: 'CUSTOM_UNVERIFIED',
      ownerType: 'STUDIO',
    });
    const tagAfter = res.headers.get('ETag') as string;
    expect(tagAfter).not.toBe(tagBefore);

    // The new rule is visible in the catalog.
    const discovery = await app.request(
      `/tax-rules/resolve?documentIssueDate=2026-08-01&documentCurrency=IDR`,
      { headers: headers() },
    );
    const payload = (await discovery.json()) as {
      data: { customRules: Array<{ id: string }> };
    };
    expect(payload.data.customRules.some((rule) => rule.id === body.data.rule.id)).toBe(true);
  });

  it('rejects a stale If-Match with 409 ENTITY_VERSION_CONFLICT', async () => {
    const res = await app.request('/tax-rules/custom', {
      method: 'POST',
      headers: headers({ 'Idempotency-Key': `create_rule_${randomUUID()}`, 'If-Match': '"stale"' }),
      body: JSON.stringify(draft({ code: 'OTHER_RULE' })),
    });
    expect(res.status).toBe(409);
    const payload = (await res.json()) as { code: string };
    expect(payload.code).toBe('TAX_RULE_CATALOG_CONFLICT');
  });

  it('rejects the reserved central code (TAX_RULE_CODE_RESERVED)', async () => {
    const tag = await resolveCatalog();
    const res = await app.request('/tax-rules/custom', {
      method: 'POST',
      headers: headers({
        'Idempotency-Key': `create_rule_${randomUUID()}`,
        'If-Match': `"${tag}"`,
      }),
      body: JSON.stringify(draft({ code: 'PPN_STANDARD_2025' })),
    });
    expect(res.status).toBe(422);
    const payload = (await res.json()) as { code: string };
    expect(payload.code).toBe('TAX_RULE_CODE_RESERVED');
  });

  it('appends an immutable version with the rule If-Match', async () => {
    const tag = await resolveCatalog();
    const create = await app.request('/tax-rules/custom', {
      method: 'POST',
      headers: headers({
        'Idempotency-Key': `create_rule_${randomUUID()}`,
        'If-Match': `"${tag}"`,
      }),
      body: JSON.stringify(draft({ code: 'VERSIONED_RULE' })),
    });
    expect(create.status).toBe(201);
    const created = (await create.json()) as {
      data: { rule: { id: string; entityVersion: string } };
    };
    const ruleId = created.data.rule.id;

    const append = await app.request(`/tax-rules/custom/${ruleId}/versions`, {
      method: 'POST',
      headers: headers({
        'Idempotency-Key': `append_rule_${randomUUID()}`,
        'If-Match': `"${created.data.rule.entityVersion}"`,
      }),
      body: JSON.stringify(draft({ code: 'VERSIONED_RULE' })),
    });
    expect(append.status).toBe(201);
    const appended = (await append.json()) as { data: { rule: { version: number } } };
    expect(appended.data.rule.version).toBe(2);
  });

  it('replays a create with 200 idempotentReplay true, then rejects a different body', async () => {
    const tag = await resolveCatalog();
    const key = `idem_create_${randomUUID()}`;
    const bodyText = JSON.stringify(draft({ code: 'IDEM_RULE' }));
    const first = await app.request('/tax-rules/custom', {
      method: 'POST',
      headers: headers({ 'Idempotency-Key': key, 'If-Match': `"${tag}"` }),
      body: bodyText,
    });
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as { meta: { idempotentReplay: boolean } };
    expect(firstBody.meta.idempotentReplay).toBe(false);

    const replay = await app.request('/tax-rules/custom', {
      method: 'POST',
      headers: headers({ 'Idempotency-Key': key, 'If-Match': `"stale-ignored-on-replay"` }),
      body: bodyText,
    });
    expect(replay.status).toBe(200);
    const replayBody = (await replay.json()) as { meta: { idempotentReplay: boolean } };
    expect(replayBody.meta.idempotentReplay).toBe(true);

    const reused = await app.request('/tax-rules/custom', {
      method: 'POST',
      headers: headers({ 'Idempotency-Key': key, 'If-Match': '"irrelevant"' }),
      body: JSON.stringify(draft({ code: 'DIFFERENT_RULE' })),
    });
    expect(reused.status).toBe(409);
    const reusedBody = (await reused.json()) as { code: string };
    expect(reusedBody.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });
});

describe('POST /purchase-orders/:id/supplier-tax-recordings', () => {
  const recording = {
    supplierDocumentReference: 'FAK-2026-001',
    label: 'Faktur pemasok',
    documentCurrency: 'IDR',
    dppAmount: '454545.45',
    taxAmount: '50000.00',
    exchangeRateEvidence: null,
    source: {
      authority: 'SUPPLIER',
      title: 'Faktur CV Pemasok',
      url: 'https://supplier.example.com/fak-2026-001',
      publishedAt: null,
      retrievedAt: '2026-08-01T00:00:00.000Z',
    },
    acknowledgment: { accepted: true, acceptedText: 'dipahami' },
  };

  it('records immutable supplier tax facts', async () => {
    const poVersion = await entityVersion('purchase_orders', IDS.purchaseOrder);
    const res = await app.request(`/purchase-orders/${IDS.purchaseOrder}/supplier-tax-recordings`, {
      method: 'POST',
      headers: headers({
        'Idempotency-Key': `recording_${randomUUID()}`,
        'If-Match': `"${poVersion}"`,
      }),
      body: JSON.stringify(recording),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      data: { supplierTaxRecording: { dppAmount: string; taxAmount: string; status: string } };
    };
    expect(body.data.supplierTaxRecording).toMatchObject({
      dppAmount: '454545.45',
      taxAmount: '50000.00',
      status: 'CUSTOM_UNVERIFIED',
    });
  });

  it('rejects a duplicate supplier reference with 409', async () => {
    const poVersion = await entityVersion('purchase_orders', IDS.purchaseOrder);
    const res = await app.request(`/purchase-orders/${IDS.purchaseOrder}/supplier-tax-recordings`, {
      method: 'POST',
      headers: headers({
        'Idempotency-Key': `recording_${randomUUID()}`,
        'If-Match': `"${poVersion}"`,
      }),
      body: JSON.stringify({ ...recording, supplierDocumentReference: 'FAK-2026-001' }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('SUPPLIER_TAX_RECORDING_CONFLICT');
  });

  it('404s for an unknown purchase order', async () => {
    const res = await app.request(`/purchase-orders/${randomUUID()}/supplier-tax-recordings`, {
      method: 'POST',
      headers: headers({
        'Idempotency-Key': `recording_${randomUUID()}`,
        'If-Match': '"irrelevant"',
      }),
      body: JSON.stringify({ ...recording, supplierDocumentReference: 'FAK-2026-002' }),
    });
    expect(res.status).toBe(404);
  });

  it('rejects a stale If-Match with 409', async () => {
    const res = await app.request(`/purchase-orders/${IDS.purchaseOrder}/supplier-tax-recordings`, {
      method: 'POST',
      headers: headers({ 'Idempotency-Key': `recording_${randomUUID()}`, 'If-Match': '"stale"' }),
      body: JSON.stringify({ ...recording, supplierDocumentReference: 'FAK-2026-003' }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('ENTITY_VERSION_CONFLICT');
  });
});

describe('POST /projects/:id/quotations/:quotationId/send — N66 (CEO condition 3)', () => {
  const sendBody = () => ({
    taxApplication: verifiedApplication([IDS.quotationItemA, IDS.quotationItemB]),
  });

  it('426 on build 1 with the legacy body; the key is NOT consumed', async () => {
    const quotationVersion = await entityVersion('quotations', IDS.quotation);
    const key = `n66_${randomUUID()}`;
    const legacyBody = JSON.stringify({ taxRate: '11', taxEvidence: 'legacy' });
    const res = await app.request(`/projects/${IDS.project}/quotations/${IDS.quotation}/send`, {
      method: 'POST',
      headers: headers({
        'x-businessapp-native-build': '1',
        'Idempotency-Key': key,
        'If-Match': `"${quotationVersion}"`,
      }),
      body: legacyBody,
    });
    expect(res.status).toBe(426);
    const payload = (await res.json()) as { code: string };
    expect(payload.code).toBe('NATIVE_BUILD_UPGRADE_REQUIRED');

    // The rejected attempt consumed no idempotency row.
    const rows = await tenant(async (client) => {
      const res = await client.query(
        `SELECT count(*)::int AS n FROM idempotency_keys WHERE key = $1`,
        [key],
      );
      return res.rows[0] as { n: number };
    });
    expect(rows.n).toBe(0);
  });

  it('build 2 writes exactly once and a replay adds no second document or snapshot', async () => {
    const quotationVersion = await entityVersion('quotations', IDS.quotation);
    const tag = await resolveCatalog();
    const key = `n66_${randomUUID()}`;
    const bodyText = JSON.stringify(sendBody());

    const first = await app.request(`/projects/${IDS.project}/quotations/${IDS.quotation}/send`, {
      method: 'POST',
      headers: headers({
        'Idempotency-Key': key,
        'If-Match': `"${quotationVersion}"`,
        'x-stdio-tax-catalog-tag': tag,
      }),
      body: bodyText,
    });
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as {
      data: {
        quotation: { status: string; totalAmount: number };
        taxSnapshot: { mode: string; total: string; dppRounded: string; ppnRounded: string } | null;
      };
      meta: { idempotentReplay: boolean };
    };
    expect(firstBody.data.quotation.status).toBe('SENT');
    expect(firstBody.data.taxSnapshot).toMatchObject({
      ruleId: 'PPN_STANDARD_2025',
      ruleStatus: 'VERIFIED',
      calculationMode: 'RATIONAL_RATE',
      effectiveDateMatched: true,
      sellerPkpStatusConfirmed: true,
      dppRounded: '618750.00',
      ppnRounded: '74250.00',
      total: '749250.00',
    });
    expect(firstBody.meta.idempotentReplay).toBe(false);

    // The replay: same key + same body -> 200, idempotentReplay true, and no
    // second write. The If-Match is deliberately stale to prove that replay
    // fires before preconditions (section 9.8).
    const replay = await app.request(`/projects/${IDS.project}/quotations/${IDS.quotation}/send`, {
      method: 'POST',
      headers: headers({
        'Idempotency-Key': key,
        'If-Match': '"stale-ignored-on-replay"',
        'x-stdio-tax-catalog-tag': 'stale-tag-ignored-on-replay',
      }),
      body: bodyText,
    });
    expect(replay.status).toBe(200);
    const replayBody = (await replay.json()) as { meta: { idempotentReplay: boolean } };
    expect(replayBody.meta.idempotentReplay).toBe(true);

    const counts = await tenant(async (client) => {
      const snapshots = await client.query(
        `SELECT count(*)::int AS n FROM tax_snapshots WHERE document_id = $1`,
        [IDS.quotation],
      );
      const statusRows = await client.query(
        `SELECT status, total_amount FROM quotations WHERE id = $1`,
        [IDS.quotation],
      );
      return {
        snapshots: (snapshots.rows[0] as { n: number }).n,
        quotation: statusRows.rows[0] as { status: string; total_amount: string },
      };
    });
    expect(counts.snapshots).toBe(1);
    expect(counts.quotation.status).toBe('SENT');
    expect(counts.quotation.total_amount).toBe('749250.00');

    // Same key, different body -> 409.
    const reused = await app.request(`/projects/${IDS.project}/quotations/${IDS.quotation}/send`, {
      method: 'POST',
      headers: headers({ 'Idempotency-Key': key }),
      body: JSON.stringify({ taxApplication: null }),
    });
    expect(reused.status).toBe(409);
    const reusedBody = (await reused.json()) as { code: string };
    expect(reusedBody.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('sends without tax when taxApplication is null (taxSnapshot null)', async () => {
    const quotationVersion = await entityVersion('quotations', IDS.quotation);
    const res = await app.request(`/projects/${IDS.project}/quotations/${IDS.quotation}/send`, {
      method: 'POST',
      headers: headers({
        'Idempotency-Key': `send_plain_${randomUUID()}`,
        'If-Match': `"${quotationVersion}"`,
      }),
      body: JSON.stringify({ taxApplication: null }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { taxSnapshot: unknown } };
    expect(body.data.taxSnapshot).toBeNull();
  });

  it('requires the catalog tag when taxApplication is present (422)', async () => {
    const quotationVersion = await entityVersion('quotations', IDS.quotation);
    const res = await app.request(`/projects/${IDS.project}/quotations/${IDS.quotation}/send`, {
      method: 'POST',
      headers: headers({
        'Idempotency-Key': `send_notag_${randomUUID()}`,
        'If-Match': `"${quotationVersion}"`,
      }),
      body: JSON.stringify(sendBody()),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('TAX_CATALOG_TAG_REQUIRED');
  });

  it('rejects a stale catalog tag with 409 TAX_RULE_CATALOG_CONFLICT', async () => {
    const quotationVersion = await entityVersion('quotations', IDS.quotation);
    const res = await app.request(`/projects/${IDS.project}/quotations/${IDS.quotation}/send`, {
      method: 'POST',
      headers: headers({
        'Idempotency-Key': `send_staletag_${randomUUID()}`,
        'If-Match': `"${quotationVersion}"`,
        'x-stdio-tax-catalog-tag': 'stale-catalog',
      }),
      body: JSON.stringify(sendBody()),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('TAX_RULE_CATALOG_CONFLICT');
  });

  it('rejects a non-exhaustive line selection (N31)', async () => {
    const quotationVersion = await entityVersion('quotations', IDS.quotation);
    const tag = await resolveCatalog();
    const res = await app.request(`/projects/${IDS.project}/quotations/${IDS.quotation}/send`, {
      method: 'POST',
      headers: headers({
        'Idempotency-Key': `send_lines_${randomUUID()}`,
        'If-Match': `"${quotationVersion}"`,
        'x-stdio-tax-catalog-tag': tag,
      }),
      body: JSON.stringify({
        taxApplication: verifiedApplication([IDS.quotationItemA]),
      }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('TAX_LINE_SELECTION_INVALID');
  });

  it('denies a non-owner role with 403 CAPABILITY_DENIED', async () => {
    const pmToken = `naa_tax_pm_${randomUUID()}`;
    await tenant(async (client) => {
      await client.query(
        `INSERT INTO access_tokens (studio_id, user_id, token, expires_at)
         VALUES ($1, $2, $3, now() + interval '1 hour')`,
        [IDS.studio, IDS.pm, pmToken],
      );
    });
    const quotationVersion = await entityVersion('quotations', IDS.quotation);
    const res = await app.request(`/projects/${IDS.project}/quotations/${IDS.quotation}/send`, {
      method: 'POST',
      headers: {
        ...headers({
          'Idempotency-Key': `send_pm_${randomUUID()}`,
          'If-Match': `"${quotationVersion}"`,
        }),
        Authorization: `Bearer ${pmToken}`,
      },
      body: JSON.stringify({ taxApplication: null }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('CAPABILITY_DENIED');
  });
});

describe('POST /projects/:id/finance/invoices/:invoiceId/issue', () => {
  // SOL-107 condition 1: the capability flip. The SOL-25 slice has merged
  // (Founding Engineer concurrence), so `canIssueInvoice` is enabled for the
  // OWNER and the issue path must now reach the guarded write.
  it('issues a draft invoice with a verified tax snapshot as OWNER', async () => {
    const invoiceVersion = await entityVersion('invoices', IDS.invoice);
    const tag = await resolveCatalog();
    const res = await app.request(
      `/projects/${IDS.project}/finance/invoices/${IDS.invoice}/issue`,
      {
        method: 'POST',
        headers: headers({
          'Idempotency-Key': `issue_inv_${randomUUID()}`,
          'If-Match': `"${invoiceVersion}"`,
          'x-stdio-tax-catalog-tag': tag,
        }),
        body: JSON.stringify({
          taxApplication: verifiedApplication(['inv-line-1']),
        }),
      },
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      data: { invoice: { status: string }; taxSnapshot: { mode: string; total: string } | null };
    };
    expect(body.data.invoice.status).toBe('ISSUED');
    expect(body.data.taxSnapshot).toMatchObject({
      ruleId: 'PPN_STANDARD_2025',
      ruleStatus: 'VERIFIED',
    });
  });

  it('issues a second draft without tax while the capability is enabled', async () => {
    const draftInvoice = randomUUID();
    await tenant(async (client) => {
      await client.query(
        `INSERT INTO invoices (id, studio_id, invoice_number, client_id, project_id,
                               engagement_id, billing_basis, status, currency, total_amount)
         VALUES ($1, $2, 'INV-TAX-2', $3, $4, $5, 'MANUAL', 'DRAFT', 'IDR', '500000.00')`,
        [draftInvoice, IDS.studio, IDS.client, IDS.project, IDS.engagement],
      );
    });
    const invoiceVersion = await entityVersion('invoices', draftInvoice);
    const res = await app.request(
      `/projects/${IDS.project}/finance/invoices/${draftInvoice}/issue`,
      {
        method: 'POST',
        headers: headers({
          'Idempotency-Key': `issue_inv2_${randomUUID()}`,
          'If-Match': `"${invoiceVersion}"`,
        }),
        body: JSON.stringify({}),
      },
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      data: { invoice: { status: string }; taxSnapshot: unknown };
    };
    expect(body.data.invoice.status).toBe('ISSUED');
    expect(body.data.taxSnapshot).toBeNull();
  });

  it('404s when the invoice belongs to another project', async () => {
    const res = await app.request(
      `/projects/${IDS.project}/finance/invoices/${randomUUID()}/issue`,
      {
        method: 'POST',
        headers: headers({ 'Idempotency-Key': `issue_miss_${randomUUID()}` }),
        body: JSON.stringify({}),
      },
    );
    expect(res.status).toBe(404);
  });
});

describe('POST /projects/:id/finance/milestones/:milestoneId/invoice', () => {
  it('404s until the milestone register lands (documented prerequisite)', async () => {
    const res = await app.request(
      `/projects/${IDS.project}/finance/milestones/${randomUUID()}/invoice`,
      {
        method: 'POST',
        headers: headers({ 'Idempotency-Key': `milestone_${randomUUID()}` }),
        body: JSON.stringify({ dueDate: '2026-09-01' }),
      },
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('MILESTONE_NOT_FOUND');
  });
});
