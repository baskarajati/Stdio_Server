/**
 * SOL-23: proof that one studio never reads the data of another studio.
 *
 * The suite builds its own scratch database from the `DATABASE_URL`
 * credentials (`stdio` has CREATEDB), applies every migration from zero,
 * seeds two studios and then attacks the boundary as the restricted
 * `studio_app` role. This is the same path the production server takes:
 * `SET LOCAL app.studio_id` + `SET LOCAL ROLE studio_app` per request.
 */
import { randomUUID } from 'node:crypto';
import {
  PPN_2025_APPLICABILITY_CONFIRMATION_TEXT,
  PPN_2025_DISCLAIMER_TEXT,
  PPN_2025_EVIDENCE,
  PPN_2025_EXCLUSIONS,
  PPN_STANDARD_2025,
} from '@stdio/core';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations } from './testing/migrations';

const adminUrl = process.env.DATABASE_URL ?? 'postgres://stdio:stdio@localhost:5432/stdio_dev';
const testDb = `stdio_rls_test_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
const testUrl = adminUrl.replace(/\/[^/]+$/, `/${testDb}`);

const studioA = randomUUID();
const studioB = randomUUID();
const clientA = randomUUID();
const clientB = randomUUID();
const projectA = randomUUID();

const admin = new pg.Client({ connectionString: testUrl });

/** Opens a request-shaped session: tenant setting + restricted role. */
async function studioSession(studioId: string): Promise<pg.Client> {
  const session = new pg.Client({ connectionString: testUrl });
  await session.connect();
  await session.query('BEGIN');
  await session.query('SELECT set_config($1, $2, true)', ['app.studio_id', studioId]);
  await session.query('SET LOCAL ROLE studio_app');
  return session;
}

beforeAll(async () => {
  const creator = new pg.Client({ connectionString: adminUrl });
  await creator.connect();
  await creator.query(`CREATE DATABASE ${testDb}`);
  await creator.end();

  await applyMigrations(testUrl);
  await admin.connect();

  // Seed two studios and their rows. The seed runs on the tenant path,
  // exactly like the application writes.
  const seedA = await studioSession(studioA);
  await seedA.query(
    `INSERT INTO studios (studio_id, name, currency) VALUES ($1, 'Studio A', 'IDR')`,
    [studioA],
  );
  await seedA.query(
    `INSERT INTO clients (id, studio_id, client_number, name)
     VALUES ($1, $2, 'CL-001', 'Pembayar A')`,
    [clientA, studioA],
  );
  await seedA.query(
    `INSERT INTO projects (id, studio_id, project_code, name, client_id, budget_amount)
     VALUES ($1, $2, 'PRJ-001', 'Rumah A', $3, '250000000.00')`,
    [projectA, studioA, clientA],
  );
  await seedA.query('COMMIT');
  await seedA.end();

  const seedB = await studioSession(studioB);
  await seedB.query(
    `INSERT INTO studios (studio_id, name, currency) VALUES ($1, 'Studio B', 'IDR')`,
    [studioB],
  );
  await seedB.query(
    `INSERT INTO clients (id, studio_id, client_number, name)
     VALUES ($1, $2, 'CL-001', 'Pembayar B')`,
    [clientB, studioB],
  );
  await seedB.query('COMMIT');
  await seedB.end();
}, 60_000);

afterAll(async () => {
  await admin.end().catch(() => undefined);
  const cleaner = new pg.Client({ connectionString: adminUrl });
  await cleaner.connect();
  // `DROP DATABASE ... WITH (FORCE)` needs superuser rights to terminate
  // backends, and `stdio` is not a superuser. Terminate the scratch
  // database's remaining `stdio` backends first: a role may always signal
  // its own sessions. Then the drop succeeds without FORCE.
  await cleaner.query(
    'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
    [testDb],
  );
  await cleaner.query(`DROP DATABASE IF EXISTS ${testDb}`);
  await cleaner.end();
}, 60_000);

describe('the studio boundary', () => {
  it('shows studio A only its own rows', async () => {
    const session = await studioSession(studioA);
    try {
      const studios = await session.query('SELECT studio_id, name FROM studios ORDER BY name');
      expect(studios.rows).toEqual([{ studio_id: studioA, name: 'Studio A' }]);

      const clients = await session.query('SELECT id, name FROM clients ORDER BY name');
      expect(clients.rows).toEqual([{ id: clientA, name: 'Pembayar A' }]);

      const projects = await session.query('SELECT id FROM projects');
      expect(projects.rows).toEqual([{ id: projectA }]);
    } finally {
      await session.query('ROLLBACK');
      await session.end();
    }
  });

  it('shows studio B only its own rows', async () => {
    const session = await studioSession(studioB);
    try {
      const studios = await session.query('SELECT studio_id, name FROM studios ORDER BY name');
      expect(studios.rows).toEqual([{ studio_id: studioB, name: 'Studio B' }]);

      const clients = await session.query('SELECT name FROM clients');
      expect(clients.rows).toEqual([{ name: 'Pembayar B' }]);
    } finally {
      await session.query('ROLLBACK');
      await session.end();
    }
  });

  it('lets studio A read nothing of studio B by id', async () => {
    const session = await studioSession(studioA);
    try {
      const direct = await session.query('SELECT name FROM clients WHERE id = $1', [clientB]);
      expect(direct.rows).toEqual([]);

      const project = await session.query('SELECT name FROM projects WHERE studio_id = $1', [
        studioB,
      ]);
      expect(project.rows).toEqual([]);

      const tenant = await session.query('SELECT name FROM studios WHERE studio_id = $1', [
        studioB,
      ]);
      expect(tenant.rows).toEqual([]);
    } finally {
      await session.query('ROLLBACK');
      await session.end();
    }
  });

  it('blocks studio A from updating or deleting rows of studio B', async () => {
    const session = await studioSession(studioA);
    try {
      const update = await session.query('UPDATE clients SET name = $1 WHERE id = $2', [
        'stolen',
        clientB,
      ]);
      expect(update.rowCount).toBe(0);

      const remove = await session.query('DELETE FROM clients WHERE studio_id = $1', [studioB]);
      expect(remove.rowCount).toBe(0);
    } finally {
      await session.query('ROLLBACK');
      await session.end();
    }
  });

  it('rejects a write that carries the id of another studio', async () => {
    const session = await studioSession(studioA);
    try {
      await expect(
        session.query(
          `INSERT INTO clients (id, studio_id, client_number, name)
           VALUES ($1, $2, 'CL-999', 'Penyusup')`,
          [randomUUID(), studioB],
        ),
      ).rejects.toThrow(/row-level security/i);
    } finally {
      await session.query('ROLLBACK');
      await session.end();
    }
  });

  it('shows nothing when the request forgets the tenant setting', async () => {
    const session = new pg.Client({ connectionString: testUrl });
    await session.connect();
    try {
      await session.query('BEGIN');
      await session.query('SET LOCAL ROLE studio_app');
      const studios = await session.query('SELECT studio_id FROM studios');
      expect(studios.rows).toEqual([]);
      const clients = await session.query('SELECT id FROM clients');
      expect(clients.rows).toEqual([]);
    } finally {
      await session.query('ROLLBACK');
      await session.end();
    }
  });

  it('enables and forces the studio isolation policy on every public table', async () => {
    const tables = await admin.query<{
      tablename: string;
      rowsecurity: boolean;
      forcerowsecurity: boolean;
    }>(
      `SELECT c.relname AS tablename,
              c.relrowsecurity AS rowsecurity,
              c.relforcerowsecurity AS forcerowsecurity
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r'
        ORDER BY c.relname`,
    );
    const tenantColumns = await admin.query<{ table_name: string }>(
      `SELECT table_name
         FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name = 'studio_id'
        ORDER BY table_name`,
    );
    const policies = await admin.query<{ tablename: string; qual: string; with_check: string }>(
      `SELECT tablename, qual, with_check
         FROM pg_policies
        WHERE schemaname = 'public' AND policyname = 'studio_isolation'
        ORDER BY tablename`,
    );

    expect(tables.rows.length).toBeGreaterThan(0);
    expect(tables.rows.every((table) => table.rowsecurity && table.forcerowsecurity)).toBe(true);
    expect(tenantColumns.rows.map((column) => column.table_name)).toEqual(
      tables.rows.map((table) => table.tablename),
    );
    expect(policies.rows.map((policy) => policy.tablename)).toEqual(
      tables.rows.map((table) => table.tablename),
    );
    expect(
      policies.rows.every(
        (policy) =>
          policy.qual.includes('studio_id') &&
          policy.qual.includes("current_setting('app.studio_id'::text, true)") &&
          policy.with_check.includes('studio_id') &&
          policy.with_check.includes("current_setting('app.studio_id'::text, true)"),
      ),
    ).toBe(true);
  });
});

describe('money columns', () => {
  it('stores numeric(20,2) exactly', async () => {
    const session = await studioSession(studioA);
    try {
      const result = await session.query('SELECT budget_amount::text FROM projects WHERE id = $1', [
        projectA,
      ]);
      expect(result.rows[0]?.budget_amount).toBe('250000000.00');
    } finally {
      await session.query('ROLLBACK');
      await session.end();
    }
  });

  it('keeps two decimal places and never stores a float', async () => {
    const session = await studioSession(studioA);
    try {
      // Postgres rounds a value with extra decimal places to the column
      // scale. The point of this test: the column never keeps three places
      // and never drifts like a float. The server still rejects values like
      // this at the API boundary; the database is the second net.
      await session.query('UPDATE projects SET budget_amount = $1 WHERE id = $2', [
        '100.999',
        projectA,
      ]);
      const result = await session.query('SELECT budget_amount::text FROM projects WHERE id = $1', [
        projectA,
      ]);
      expect(result.rows[0]?.budget_amount).toBe('101.00');
    } finally {
      await session.query('ROLLBACK');
      await session.end();
    }
  });

  it('defines every money column as numeric(20,2) and defines no float columns', async () => {
    const floats = await admin.query(
      `SELECT table_name, column_name
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND data_type IN ('real', 'double precision')`,
    );
    expect(floats.rows).toEqual([]);

    const moneyColumns = await admin.query<{
      table_name: string;
      column_name: string;
      data_type: string;
      numeric_precision: number;
      numeric_scale: number;
    }>(
      `SELECT table_name, column_name, data_type, numeric_precision, numeric_scale
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND column_name ~ '(_amount|_total|_subtotal|_cost|_rate|budget_amount|contract_value|transaction_price)$'
        ORDER BY table_name, column_name`,
    );

    expect(moneyColumns.rows.length).toBeGreaterThan(0);
    // SOL-19 revision 6: `hourly_rate` and `effective_hourly_rate` are
    // contract-mandated numeric(20,4) snapshots (proposal section 2.6), the
    // same scale as quantities. Every other money column is numeric(20,2).
    const FOUR_DP_RATE_COLUMNS = new Set(['hourly_rate', 'effective_hourly_rate']);
    expect(
      moneyColumns.rows.every(
        (column) =>
          column.data_type === 'numeric' &&
          column.numeric_precision === 20 &&
          (FOUR_DP_RATE_COLUMNS.has(column.column_name)
            ? column.numeric_scale === 4
            : column.numeric_scale === 2),
      ),
    ).toBe(true);
  });
});

/**
 * SOL-25: the tax persistence layer.
 *
 * The central register is tenant-visible but studio-immutable; custom rules,
 * snapshots and supplier recordings are studio-owned and never visible
 * cross-studio. The fixtures are created inside each session transaction
 * (BEGIN/ROLLBACK), so the tests need no shared seed rows.
 */
describe('the tax register (SOL-25)', () => {
  async function seedUser(session: pg.Client, studioId: string): Promise<string> {
    const userId = randomUUID();
    await session.query(
      `INSERT INTO users (id, studio_id, email, name, role)
       VALUES ($1, $2, $3, 'Petugas Pajak', 'FINANCE')`,
      [userId, studioId, `tax-${userId.slice(0, 8)}@studio.test`],
    );
    return userId;
  }

  async function insertCustomRule(
    session: pg.Client,
    ruleId: string,
    studioId: string,
    version: number,
    code: string,
  ) {
    await session.query(
      `INSERT INTO tax_rules (
         id, version, studio_id, owner_type, status, label, code, jurisdiction,
         tax_type, currency, calculation_mode, effective_from,
         statutory_rate_numerator, statutory_rate_denominator,
         dpp_factor_numerator, dpp_factor_denominator, rounding_mode,
         rounding_unit_minor, round_dpp_before_tax, rounding_stage,
         calculation_scope, disclaimer_text)
       VALUES ($1, $2, $3, 'STUDIO', 'CUSTOM_UNVERIFIED', $4, $5, 'ID', 'PPN',
         'IDR', 'RATIONAL_RATE', '2026-01-01', '11', '100', '10', '11',
         'HALF_UP', 100, true, 'DPP_THEN_PPN', 'DOCUMENT_TAX_BUCKET', $6)`,
      [ruleId, version, studioId, `Aturan ${version}`, code, 'Disclaimer aturan.'],
    );
  }

  async function insertSnapshot(
    session: pg.Client,
    studioId: string,
    confirmedById: string,
    mode: string,
    documentId: string,
  ) {
    await session.query(
      `INSERT INTO tax_snapshots (
         studio_id, snapshot_id, document_id, document_type, document_version,
         document_issue_date, document_status, included_line_ids,
         excluded_line_ids, confirmed_by_id, confirmed_at,
         accepted_confirmation_text, mode, payload)
       VALUES ($1, $2, $3, 'QUOTATION', '1', '2026-08-01', 'SENT',
         '["line-1"]'::jsonb, '[]'::jsonb, $4, '2026-08-01T09:00:00Z',
         'Diterima.', $5, '{}'::jsonb)`,
      [studioId, documentId, documentId, confirmedById, mode],
    );
  }

  async function seedVendorAndPurchaseOrder(
    session: pg.Client,
    studioId: string,
    projectId: string,
  ): Promise<{ vendorId: string; purchaseOrderId: string }> {
    const vendorId = randomUUID();
    const purchaseOrderId = randomUUID();
    await session.query(
      `INSERT INTO vendors (id, studio_id, vendor_code, name)
       VALUES ($1, $2, 'VEN-PAJAK', 'Pemasok Pajak')`,
      [vendorId, studioId],
    );
    await session.query(
      `INSERT INTO purchase_orders (
         id, studio_id, purchase_order_number, project_id, vendor_id,
         status, currency, issue_date)
       VALUES ($1, $2, 'PO-PAJAK', $3, $4, 'CONFIRMED', 'IDR', '2026-08-01')`,
      [purchaseOrderId, studioId, projectId, vendorId],
    );
    return { vendorId, purchaseOrderId };
  }

  async function insertRecording(
    session: pg.Client,
    studioId: string,
    recordedById: string,
    purchaseOrderId: string,
    vendorId: string,
    documentCurrency: string,
    exchangeRateEvidence: unknown,
  ) {
    await session.query(
      `INSERT INTO supplier_tax_recordings (
         studio_id, purchase_order_id, supplier_id, status,
         supplier_document_reference, label, document_currency, dpp_amount,
         tax_amount, exchange_rate_evidence, source, accepted_confirmation_text,
         recorded_by_id, recorded_at)
       VALUES ($1, $2, $3, 'CUSTOM_UNVERIFIED', 'INV-2026-0001',
         'Faktur pemasok', $4, '1000000.00', '110000.00', $5,
         '{"kind":"supplier-document"}'::jsonb, 'Diterima.', $6,
         '2026-08-01T09:00:00Z')`,
      [studioId, purchaseOrderId, vendorId, documentCurrency, exchangeRateEvidence, recordedById],
    );
  }

  it('shows the central verified rule to every studio', async () => {
    for (const studioId of [studioA, studioB]) {
      const session = await studioSession(studioId);
      try {
        const rows = await session.query(
          'SELECT id, version, owner_type, code FROM tax_rules WHERE owner_type = $1',
          ['CENTRAL'],
        );
        expect(rows.rows).toEqual([
          { id: 'PPN_STANDARD_2025', version: 1, owner_type: 'CENTRAL', code: 'PPN_STANDARD_2025' },
        ]);
      } finally {
        await session.query('ROLLBACK');
        await session.end();
      }
    }
  });

  it('keeps the central register studio-immutable', async () => {
    const session = await studioSession(studioA);
    try {
      // The row is visible (USING allows CENTRAL rows), but a tenant session
      // can neither rewrite it (the immutability trigger fires first) nor
      // forge a new CENTRAL row (WITH CHECK requires a STUDIO row).
      await session.query('SAVEPOINT attempt');
      await expect(
        session.query('UPDATE tax_rules SET label = $1 WHERE id = $2 AND version = 1', [
          'dicuri',
          'PPN_STANDARD_2025',
        ]),
      ).rejects.toThrow(/immutable/i);
      await session.query('ROLLBACK TO SAVEPOINT attempt');

      await expect(
        session.query(
          `INSERT INTO tax_rules (id, version, studio_id, owner_type, status, code,
                                  jurisdiction, tax_type, currency, calculation_mode,
                                  effective_from, rounding_mode, rounding_unit_minor,
                                  calculation_scope, disclaimer_text)
           VALUES ('PPN_PALSU', 1, NULL, 'CENTRAL', 'VERIFIED', 'PPN_PALSU',
                   'ID', 'PPN', 'IDR', 'RATIONAL_RATE', '2026-01-01',
                   'HALF_UP', 100, 'DOCUMENT_TAX_BUCKET', 'x')`,
        ),
      ).rejects.toThrow(/row-level security/i);
    } finally {
      await session.query('ROLLBACK');
      await session.end();
    }
  });

  it('hides studio B custom rules from studio A', async () => {
    const seedB = await studioSession(studioB);
    await insertCustomRule(seedB, 'rule-b-1', studioB, 1, 'ATURAN_B');
    await seedB.query('COMMIT');
    await seedB.end();

    const session = await studioSession(studioA);
    try {
      const own = await session.query("SELECT id FROM tax_rules WHERE owner_type = 'STUDIO'");
      expect(own.rows).toEqual([]);

      const direct = await session.query('SELECT id, code FROM tax_rules WHERE id = $1', [
        'rule-b-1',
      ]);
      expect(direct.rows).toEqual([]);
    } finally {
      await session.query('ROLLBACK');
      await session.end();
    }
  });

  it('rejects a custom rule that reuses the central code', async () => {
    const session = await studioSession(studioA);
    try {
      await expect(
        insertCustomRule(session, 'rule-a-1', studioA, 1, 'PPN_STANDARD_2025'),
      ).rejects.toThrow(/tax_rules_custom_code_reserved_check/i);
    } finally {
      await session.query('ROLLBACK');
      await session.end();
    }
  });

  it('rejects a custom rule carrying another studio id', async () => {
    const session = await studioSession(studioA);
    try {
      await expect(insertCustomRule(session, 'rule-a-2', studioB, 1, 'ATURAN_A')).rejects.toThrow(
        /row-level security/i,
      );
    } finally {
      await session.query('ROLLBACK');
      await session.end();
    }
  });

  it('keeps every custom rule version immutable', async () => {
    const session = await studioSession(studioA);
    try {
      await insertCustomRule(session, 'rule-a-3', studioA, 1, 'ATURAN_C');

      await session.query('SAVEPOINT attempt');
      await expect(
        session.query('UPDATE tax_rules SET label = $1 WHERE id = $2 AND version = 1', [
          'diubah',
          'rule-a-3',
        ]),
      ).rejects.toThrow(/immutable/i);
      await session.query('ROLLBACK TO SAVEPOINT attempt');

      await expect(
        session.query('DELETE FROM tax_rules WHERE id = $1', ['rule-a-3']),
      ).rejects.toThrow(/immutable/i);
    } finally {
      await session.query('ROLLBACK');
      await session.end();
    }
  });

  it('gives every rule version a fresh entity version for the catalog tag', async () => {
    const session = await studioSession(studioA);
    try {
      await insertCustomRule(session, 'rule-a-4', studioA, 1, 'ATURAN_D');
      await insertCustomRule(session, 'rule-a-4', studioA, 2, 'ATURAN_D');

      const rows = await session.query(
        'SELECT version, entity_version FROM tax_rules WHERE id = $1 ORDER BY version',
        ['rule-a-4'],
      );
      expect(rows.rows).toHaveLength(2);
      expect(rows.rows[0]?.entity_version).not.toBe(rows.rows[1]?.entity_version);
    } finally {
      await session.query('ROLLBACK');
      await session.end();
    }
  });

  it('stores all five snapshot modes and rejects any other mode', async () => {
    const session = await studioSession(studioA);
    try {
      const userId = await seedUser(session, studioA);
      const modes = [
        'VERIFIED_RATIONAL',
        'CUSTOM_RATIONAL',
        'CUSTOM_FIXED',
        'CUSTOM_RECORDING_IDR',
        'CUSTOM_RECORDING_NON_IDR',
      ];
      for (const [index, mode] of modes.entries()) {
        await insertSnapshot(session, studioA, userId, mode, `doc-${index}`);
      }
      const count = await session.query('SELECT count(*)::int AS n FROM tax_snapshots');
      expect(count.rows[0]?.n).toBe(5);

      await expect(
        insertSnapshot(session, studioA, userId, 'MODE_LAIN', 'doc-extra'),
      ).rejects.toThrow(/tax_snapshots_mode_check/i);
    } finally {
      await session.query('ROLLBACK');
      await session.end();
    }
  });

  it('hides studio B snapshots from studio A', async () => {
    const seedB = await studioSession(studioB);
    const userId = await seedUser(seedB, studioB);
    await insertSnapshot(seedB, studioB, userId, 'VERIFIED_RATIONAL', 'doc-b-1');
    await seedB.query('COMMIT');
    await seedB.end();

    const session = await studioSession(studioA);
    try {
      const rows = await session.query('SELECT id FROM tax_snapshots');
      expect(rows.rows).toEqual([]);

      const direct = await session.query(
        'SELECT document_id FROM tax_snapshots WHERE document_id = $1',
        ['doc-b-1'],
      );
      expect(direct.rows).toEqual([]);
    } finally {
      await session.query('ROLLBACK');
      await session.end();
    }
  });

  it('stores the IDR and non-IDR supplier leaves and rejects a mix', async () => {
    const session = await studioSession(studioA);
    try {
      const userId = await seedUser(session, studioA);
      const { vendorId, purchaseOrderId } = await seedVendorAndPurchaseOrder(
        session,
        studioA,
        projectA,
      );

      // The IDR leaf: no exchange-rate evidence.
      await insertRecording(session, studioA, userId, purchaseOrderId, vendorId, 'IDR', null);
      // The non-IDR leaf: evidence required.
      await insertRecording(
        session,
        studioA,
        userId,
        purchaseOrderId,
        vendorId,
        'USD',
        JSON.stringify({ currency: 'USD', rate: '15500', source: 'kurs-bank' }),
      );
      const count = await session.query('SELECT count(*)::int AS n FROM supplier_tax_recordings');
      expect(count.rows[0]?.n).toBe(2);

      // IDR with evidence and non-IDR without evidence are both a leaf mix.
      await session.query('SAVEPOINT attempt');
      await expect(
        insertRecording(
          session,
          studioA,
          userId,
          purchaseOrderId,
          vendorId,
          'IDR',
          JSON.stringify({ currency: 'USD' }),
        ),
      ).rejects.toThrow(/supplier_tax_recordings_currency_evidence_check/i);
      await session.query('ROLLBACK TO SAVEPOINT attempt');

      await expect(
        insertRecording(session, studioA, userId, purchaseOrderId, vendorId, 'USD', null),
      ).rejects.toThrow(/supplier_tax_recordings_currency_evidence_check/i);
    } finally {
      await session.query('ROLLBACK');
      await session.end();
    }
  });

  it('hides studio B supplier recordings from studio A', async () => {
    const seedB = await studioSession(studioB);
    const userId = await seedUser(seedB, studioB);
    const projectB = randomUUID();
    await seedB.query(
      `INSERT INTO projects (id, studio_id, project_code, name, client_id, budget_amount)
       VALUES ($1, $2, 'PRJ-B', 'Proyek B', $3, '100000000.00')`,
      [projectB, studioB, clientB],
    );
    const { vendorId, purchaseOrderId } = await seedVendorAndPurchaseOrder(
      seedB,
      studioB,
      projectB,
    );
    await insertRecording(seedB, studioB, userId, purchaseOrderId, vendorId, 'IDR', null);
    await seedB.query('COMMIT');
    await seedB.end();

    const session = await studioSession(studioA);
    try {
      const rows = await session.query('SELECT id FROM supplier_tax_recordings');
      expect(rows.rows).toEqual([]);
    } finally {
      await session.query('ROLLBACK');
      await session.end();
    }
  });
});

/**
 * SOL-25: the seeded central register must not drift from the approved core
 * preset. The migration seeds the row byte-for-byte from
 * `packages/core/src/tax/ppn-2025.ts`; this test pins the database row to
 * that source so the two copies cannot drift.
 */
describe('the central register (SOL-25)', () => {
  it('pins the seeded register row to the core preset byte-for-byte', async () => {
    const result = await admin.query<Record<string, unknown>>(
      `SELECT id, version, owner_type, status, code, jurisdiction, tax_type,
              currency, calculation_mode, effective_from::text AS effective_from,
              effective_to::text AS effective_to, verified_at::text AS verified_at,
              statutory_rate_numerator, statutory_rate_denominator,
              dpp_factor_numerator, dpp_factor_denominator,
              fixed_amount::text AS fixed_amount, rounding_mode, rounding_unit_minor,
              round_dpp_before_tax, rounding_stage, calculation_scope,
              evidence_json, exclusions_json, sources_json,
              applicability_confirmation_text, disclaimer_text
         FROM tax_rules
        WHERE id = 'PPN_STANDARD_2025' AND version = 1`,
    );
    expect(result.rows).toHaveLength(1);
    const row = result.rows[0] as Record<string, unknown>;

    expect(row.id).toBe(PPN_STANDARD_2025.id);
    expect(row.version).toBe(PPN_STANDARD_2025.version);
    expect(row.owner_type).toBe(PPN_STANDARD_2025.ownerType);
    expect(row.status).toBe(PPN_STANDARD_2025.status);
    expect(row.code).toBe(PPN_STANDARD_2025.code);
    expect(row.jurisdiction).toBe(PPN_STANDARD_2025.jurisdiction);
    expect(row.tax_type).toBe(PPN_STANDARD_2025.taxType);
    expect(row.currency).toBe(PPN_STANDARD_2025.currency);
    expect(row.calculation_mode).toBe(PPN_STANDARD_2025.calculationMode);
    expect(row.effective_from).toBe(PPN_STANDARD_2025.effectiveFrom);
    expect(row.effective_to).toBeNull();
    expect(row.verified_at).toBe(PPN_STANDARD_2025.verifiedAt);
    expect(row.statutory_rate_numerator).toBe(PPN_STANDARD_2025.statutoryRateNumerator);
    expect(row.statutory_rate_denominator).toBe(PPN_STANDARD_2025.statutoryRateDenominator);
    expect(row.dpp_factor_numerator).toBe(PPN_STANDARD_2025.dppFactorNumerator);
    expect(row.dpp_factor_denominator).toBe(PPN_STANDARD_2025.dppFactorDenominator);
    expect(row.fixed_amount).toBeNull();
    expect(row.rounding_mode).toBe(PPN_STANDARD_2025.roundingMode);
    expect(row.rounding_unit_minor).toBe(PPN_STANDARD_2025.roundingUnitMinor);
    expect(row.round_dpp_before_tax).toBe(true);
    expect(row.rounding_stage).toBe(PPN_STANDARD_2025.roundingStage);
    expect(row.calculation_scope).toBe(PPN_STANDARD_2025.calculationScope);
    expect(row.evidence_json).toEqual(PPN_2025_EVIDENCE);
    expect(row.exclusions_json).toEqual(PPN_2025_EXCLUSIONS);
    expect(row.sources_json).toBeNull();
    expect(row.applicability_confirmation_text).toBe(PPN_2025_APPLICABILITY_CONFIRMATION_TEXT);
    expect(row.disclaimer_text).toBe(PPN_2025_DISCLAIMER_TEXT);
  });
});
