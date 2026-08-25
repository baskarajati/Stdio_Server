/**
 * Integration tests for the purchase-order workspace reads (SOL-163 slice 2).
 *
 * Runs against the live `stdio_dev` database (seed: Studio Contoh). Proves:
 *
 * - The register list (`GET /purchase-orders`) projects the contract
 *   `PurchaseOrderSummary`: stage/status labels and signals, the
 *   received-progress fraction (exact from stored quantities), the money
 *   number + label pair, the source object, and the capability/transition
 *   surface.
 * - The detail (`GET /purchase-orders/{id}`) adds line items and change
 *   control and returns the weak ETag of the entity version.
 * - The tenant boundary: a foreign-studio purchase order is a 404 under RLS.
 * - The role lenses: DESIGNER loses every money field (costs and finance),
 *   PROCUREMENT keeps the costs but loses the finance-only deltas, FINANCE
 *   keeps both.
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
const SEED_PO = '00000000-0000-4000-8000-00000000000a';
const OTHER_STUDIO = '00000000-0000-4000-8000-0000000000aa';
const OTHER_USER = '00000000-0000-4000-8000-0000000000bb';
const OTHER_PROJECT = '00000000-0000-4000-8000-0000000000cc';

let pool: Pool;
let app: ReturnType<typeof createApp>;
let ownerToken = '';
let designerToken = '';
let procurementToken = '';
let financeToken = '';
let draftPoId = '';
let recvPoId = '';
let foreignPoId = '';

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

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

/** The contract Problem envelope (components/schemas/Problem). */
type ProblemEnvelope = {
  type: string;
  status: number;
  code: string;
  title: string;
  detail: string;
  requestId: string;
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

async function addUser(studioId: string, email: string, name: string, role: string): Promise<void> {
  await tenantQuery(studioId, async (client) => {
    await client.query(
      `INSERT INTO users (id, studio_id, email, name, role)
       VALUES (gen_random_uuid(), $1, $2, $3, $4)
       ON CONFLICT DO NOTHING`,
      [studioId, email, name, role],
    );
  });
}

async function userIdOf(studioId: string, email: string): Promise<string> {
  return tenantQuery(studioId, async (client) => {
    const rows = (await client.query(`SELECT id FROM users WHERE studio_id = $1 AND email = $2`, [
      studioId,
      email,
    ])) as { rows: { id: string }[] };
    const id = rows.rows[0]?.id;
    if (!id) {
      throw new Error(`user fixture missing: ${email}`);
    }
    return id;
  });
}

beforeAll(async () => {
  pool = new Pool({ connectionString, max: 5 });
  app = createApp(pool);

  await addUser(SEED_STUDIO, 'po-designer@contoh.studio', 'Desainer PO', 'DESIGNER');
  await addUser(SEED_STUDIO, 'po-procurement@contoh.studio', 'Pengadaan PO', 'PROCUREMENT');
  await addUser(SEED_STUDIO, 'po-finance@contoh.studio', 'Keuangan PO', 'FINANCE');

  const designerId = await userIdOf(SEED_STUDIO, 'po-designer@contoh.studio');
  const procurementId = await userIdOf(SEED_STUDIO, 'po-procurement@contoh.studio');
  const financeId = await userIdOf(SEED_STUDIO, 'po-finance@contoh.studio');

  ownerToken = `naa_po_owner_${randomUUID()}`;
  designerToken = `naa_po_designer_${randomUUID()}`;
  procurementToken = `naa_po_procurement_${randomUUID()}`;
  financeToken = `naa_po_finance_${randomUUID()}`;
  await mintToken(SEED_STUDIO, SEED_OWNER, ownerToken);
  await mintToken(SEED_STUDIO, designerId, designerToken);
  await mintToken(SEED_STUDIO, procurementId, procurementToken);
  await mintToken(SEED_STUDIO, financeId, financeToken);

  // PO fixtures for this suite (unique number prefix, cleaned in afterAll).
  await tenantQuery(SEED_STUDIO, async (client) => {
    draftPoId = randomUUID();
    await client.query(
      `INSERT INTO purchase_orders
         (id, studio_id, purchase_order_number, project_id, vendor_id, status,
          currency, issue_date, expected_date, total_amount)
       VALUES ($1, $2, 'PO-SOL163-DRAFT', $3, $4, 'DRAFT', 'IDR',
               '2026-08-10', '2026-08-30', '50000000.00')`,
      [draftPoId, SEED_STUDIO, SEED_PROJECT, SEED_VENDOR],
    );
    await client.query(
      `INSERT INTO purchase_order_items
         (id, studio_id, purchase_order_id, description, quantity, unit_cost, line_total)
       VALUES (gen_random_uuid(), $1, $2, 'Item DRAFT A', '3.0000', '10000000.00', '30000000.00'),
              (gen_random_uuid(), $1, $2, 'Item DRAFT B', '1.0000', '20000000.00', '20000000.00')`,
      [SEED_STUDIO, draftPoId],
    );

    recvPoId = randomUUID();
    await client.query(
      `INSERT INTO purchase_orders
         (id, studio_id, purchase_order_number, project_id, vendor_id, status,
          currency, issue_date, total_amount)
       VALUES ($1, $2, 'PO-SOL163-RECV', $3, $4, 'PARTIALLY_RECEIVED', 'IDR',
               '2026-08-11', '80000000.00')`,
      [recvPoId, SEED_STUDIO, SEED_PROJECT, SEED_VENDOR],
    );
    await client.query(
      `INSERT INTO purchase_order_items
         (id, studio_id, purchase_order_id, description, quantity, received_quantity,
          unit_cost, line_total)
       VALUES (gen_random_uuid(), $1, $2, 'Item RECV A', '4.0000', '2.0000',
               '20000000.00', '80000000.00')`,
      [SEED_STUDIO, recvPoId],
    );
  });

  // A foreign-studio purchase order for the tenant-boundary negative.
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
       VALUES (gen_random_uuid(), $1, 'C-PO-LAIN', 'Klien Lain') ON CONFLICT DO NOTHING`,
      [OTHER_STUDIO],
    );
    const clients = (await client.query(
      `SELECT id FROM clients WHERE studio_id = $1 AND client_number = 'C-PO-LAIN'`,
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
    await client.query(
      `INSERT INTO vendors (id, studio_id, vendor_code, name)
       VALUES (gen_random_uuid(), $1, 'V-PO-LAIN', 'Vendor Lain') ON CONFLICT DO NOTHING`,
      [OTHER_STUDIO],
    );
    const vendors = (await client.query(
      `SELECT id FROM vendors WHERE studio_id = $1 AND vendor_code = 'V-PO-LAIN'`,
      [OTHER_STUDIO],
    )) as { rows: { id: string }[] };
    const otherVendorId = vendors.rows[0]?.id;
    if (!otherVendorId) {
      throw new Error('other-studio vendor fixture missing');
    }
    foreignPoId = randomUUID();
    await client.query(
      `INSERT INTO purchase_orders
         (id, studio_id, purchase_order_number, project_id, vendor_id, status,
          currency, issue_date, total_amount)
       VALUES ($1, $2, 'PO-SOL163-FOREIGN', $3, $4, 'SENT', 'IDR',
               '2026-08-12', '10000000.00')`,
      [foreignPoId, OTHER_STUDIO, OTHER_PROJECT, otherVendorId],
    );
  });
});

afterAll(async () => {
  await tenantQuery(SEED_STUDIO, async (client) => {
    await client.query(`DELETE FROM purchase_order_items WHERE purchase_order_id IN
      (SELECT id FROM purchase_orders WHERE purchase_order_number LIKE 'PO-SOL163-%')`);
    await client.query(
      `DELETE FROM purchase_orders WHERE purchase_order_number LIKE 'PO-SOL163-%'`,
    );
  });
  await tenantQuery(OTHER_STUDIO, async (client) => {
    await client.query(`DELETE FROM purchase_order_items WHERE purchase_order_id = $1`, [
      foreignPoId,
    ]);
    await client.query(`DELETE FROM purchase_orders WHERE id = $1`, [foreignPoId]);
  });
  await pool.end();
});

type ListBody = {
  data: { purchaseOrders: Record<string, unknown>[] };
  meta: { pagination: { page: number; pageSize: number; totalItems: number; totalPages: number } };
};

describe('GET /purchase-orders (register list)', () => {
  it('lists the seeded CONFIRMED purchase order with the full summary shape', async () => {
    const res = await app.request('/purchase-orders', { headers: auth(ownerToken) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListBody;
    const po = body.data.purchaseOrders.find((row) => row.id === SEED_PO) as any;
    expect(po).toBeDefined();
    expect(po).toMatchObject({
      purchaseOrderNumber: 'PO-001',
      projectName: expect.any(String),
      vendorName: expect.any(String),
      status: 'CONFIRMED',
      statusLabel: 'Confirmed',
      stage: 'ordered',
      stageLabel: 'Ordered',
      stageSignal: { label: 'Ordered', tone: 'info' },
      itemCount: 1,
      receivedProgress: { fraction: 0, label: '0 of 2 received' },
      totalAmount: 120000000,
      totalLabel: 'Rp 120.000.000,00',
      canReadFinance: true,
      canReadProcurementCosts: true,
      capabilities: {
        read: { enabled: true, reason: '' },
        transitionStatus: { enabled: true, reason: '' },
      },
      availableStatusTransitions: [{ label: 'Cancel', value: 'CANCELLED' }],
      source: { href: `/purchase-orders/${SEED_PO}`, type: 'purchaseOrder' },
    });
    expect(po).toHaveProperty('entityVersion');
    expect(typeof po.entityVersion).toBe('string');
    expect(po).toHaveProperty('issueDate');
    expect(po).toHaveProperty('updatedAt');
    expect(po).toHaveProperty('expectedDate');
    expect(body.meta.pagination).toMatchObject({
      page: 1,
      pageSize: 10,
      totalItems: expect.any(Number),
      totalPages: expect.any(Number),
    });
  });

  it('filters by q on the purchase order number', async () => {
    const res = await app.request('/purchase-orders?q=PO-SOL163-RECV', {
      headers: auth(ownerToken),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListBody;
    expect(body.data.purchaseOrders).toHaveLength(1);
    expect(body.data.purchaseOrders[0]).toMatchObject({
      purchaseOrderNumber: 'PO-SOL163-RECV',
      status: 'PARTIALLY_RECEIVED',
      stage: 'receiving',
      stageLabel: 'Receiving',
      stageSignal: { label: 'Receiving', tone: 'warning' },
      statusLabel: 'Partially Received',
      receivedProgress: { fraction: 0.5, label: '2 of 4 received' },
    });
  });

  it('returns an empty list for a q with no match', async () => {
    const res = await app.request('/purchase-orders?q=PO-ZZZ-NO-MATCH', {
      headers: auth(ownerToken),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListBody;
    expect(body.data.purchaseOrders).toHaveLength(0);
    expect(body.meta.pagination.totalItems).toBe(0);
    expect(body.meta.pagination.totalPages).toBe(1);
  });

  it('clamps page and pageSize and pages correctly', async () => {
    const res = await app.request('/purchase-orders?page=2&pageSize=1', {
      headers: auth(ownerToken),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListBody;
    expect(body.data.purchaseOrders).toHaveLength(1);
    expect(body.meta.pagination).toMatchObject({ page: 2, pageSize: 1 });
    expect(body.meta.pagination.totalPages).toBeGreaterThanOrEqual(2);

    const clamped = await app.request('/purchase-orders?page=0&pageSize=0', {
      headers: auth(ownerToken),
    });
    const clampedBody = (await clamped.json()) as ListBody;
    expect(clampedBody.meta.pagination).toMatchObject({ page: 1, pageSize: 10 });
  });

  it('exposes both transitions on a DRAFT purchase order', async () => {
    const res = await app.request(`/purchase-orders?q=PO-SOL163-DRAFT`, {
      headers: auth(ownerToken),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListBody;
    const po = body.data.purchaseOrders[0] as any;
    expect(po).toMatchObject({
      status: 'DRAFT',
      stage: 'draft',
      stageLabel: 'Draft',
      stageSignal: { label: 'Draft', tone: 'neutral' },
      itemCount: 2,
      receivedProgress: { fraction: 0, label: '0 of 4 received' },
      totalAmount: 50000000,
    });
    expect(po.availableStatusTransitions).toEqual([
      { label: 'Confirm', value: 'CONFIRMED' },
      { label: 'Cancel', value: 'CANCELLED' },
    ]);
  });
});

describe('GET /purchase-orders/{id} (detail)', () => {
  it('returns the detail with line items, change control and the weak ETag', async () => {
    const res = await app.request(`/purchase-orders/${SEED_PO}`, { headers: auth(ownerToken) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { purchaseOrder: Record<string, unknown> };
      meta: Record<string, unknown>;
    };
    const po = body.data.purchaseOrder;
    expect(po.id).toBe(SEED_PO);
    expect(po.items).toHaveLength(1);
    expect((po.items as Record<string, unknown>[])[0]).toMatchObject({
      description: 'Sofa 3 dudukan',
      quantity: '2',
      quantityLabel: '2',
      receivedQuantity: '0',
      receivingState: 'ordered',
      receivingStateLabel: 'Ordered',
      receivingStateSignal: { label: 'Ordered', tone: 'neutral' },
      receivedProgress: { fraction: 0, label: '0 of 2 received' },
      unitCost: 60000000,
      unitCostLabel: 'Rp 60.000.000,00',
      lineTotal: 120000000,
      lineTotalLabel: 'Rp 120.000.000,00',
      hasSpecLink: false,
    });
    expect(po.changeControl as Record<string, unknown>).toMatchObject({
      statusLabel: 'Confirmed',
      isAmended: false,
      amountVariance: null,
      amountVarianceLabel: null,
      confirmedTotalLabel: null,
      currentTotalLabel: 'Rp 120.000.000,00',
      dateAmended: false,
    });
    const etag = res.headers.get('ETag');
    expect(etag).toBe(`W/"${po.entityVersion}"`);
  });

  it('derives partiallyReceived on a line with partial receipts', async () => {
    const res = await app.request(`/purchase-orders/${recvPoId}`, { headers: auth(ownerToken) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { purchaseOrder: { items: Record<string, unknown>[] } };
    };
    expect(body.data.purchaseOrder.items[0]).toMatchObject({
      quantity: '4',
      receivedQuantity: '2',
      receivingState: 'partiallyReceived',
      receivingStateLabel: 'Partially Received',
      receivingStateSignal: { label: 'Partially received', tone: 'warning' },
      receivedProgress: { fraction: 0.5, label: '2 of 4 received' },
    });
  });

  it('404s an unknown purchase order with the contract problem envelope', async () => {
    const res = await app.request(`/purchase-orders/${randomUUID()}`, {
      headers: auth(ownerToken),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as ProblemEnvelope;
    expectProblem(body, 404, 'PURCHASE_ORDER_NOT_FOUND');
  });

  it('404s a foreign-studio purchase order under RLS', async () => {
    const res = await app.request(`/purchase-orders/${foreignPoId}`, {
      headers: auth(ownerToken),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as ProblemEnvelope;
    expectProblem(body, 404, 'PURCHASE_ORDER_NOT_FOUND');
  });
});

describe('role lenses', () => {
  it('masks every money field for a DESIGNER but keeps the shape', async () => {
    const res = await app.request(`/purchase-orders/${SEED_PO}`, {
      headers: auth(designerToken),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { purchaseOrder: Record<string, unknown> };
    };
    const po = body.data.purchaseOrder;
    expect(po).toMatchObject({
      canReadFinance: false,
      canReadProcurementCosts: false,
      totalAmount: null,
      totalLabel: null,
      itemCount: 1,
    });
    expect((po.items as Record<string, unknown>[])[0]).toMatchObject({
      quantity: '2',
      quantityLabel: '2',
      receivingState: 'ordered',
      unitCost: null,
      unitCostLabel: null,
      lineTotal: null,
      lineTotalLabel: null,
    });
    expect(po.changeControl as Record<string, unknown>).toMatchObject({
      isAmended: null,
      amountVariance: null,
      amountVarianceLabel: null,
      confirmedTotalLabel: null,
      currentTotalLabel: null,
    });
    expect(po.capabilities).toMatchObject({
      transitionStatus: { enabled: false },
    });
  });

  it('keeps the costs for PROCUREMENT but masks the finance-only deltas', async () => {
    const res = await app.request(`/purchase-orders/${SEED_PO}`, {
      headers: auth(procurementToken),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { purchaseOrder: Record<string, unknown> };
    };
    const po = body.data.purchaseOrder;
    expect(po).toMatchObject({
      canReadFinance: false,
      canReadProcurementCosts: true,
      totalAmount: 120000000,
      totalLabel: 'Rp 120.000.000,00',
    });
    expect((po.items as Record<string, unknown>[])[0]).toMatchObject({
      unitCost: 60000000,
      lineTotal: 120000000,
    });
    expect(po.changeControl as Record<string, unknown>).toMatchObject({
      isAmended: null,
      amountVariance: null,
      confirmedTotalLabel: null,
      currentTotalLabel: 'Rp 120.000.000,00',
    });
  });

  it('keeps the finance deltas for FINANCE', async () => {
    const res = await app.request(`/purchase-orders/${SEED_PO}`, {
      headers: auth(financeToken),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { purchaseOrder: Record<string, unknown> };
    };
    expect(body.data.purchaseOrder).toMatchObject({
      canReadFinance: true,
      canReadProcurementCosts: true,
      totalAmount: 120000000,
    });
    expect(body.data.purchaseOrder.changeControl).toMatchObject({
      isAmended: false,
      amountVariance: null,
    });
  });
});
