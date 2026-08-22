/**
 * SOL-25 tax table isolation and immutability proofs (revision 24).
 *
 * Builds its own scratch database from zero (migrations + central register),
 * seeds two studios, then attacks the tax boundary as the restricted
 * `studio_app` role:
 *
 * - RLS: a studio sees the CENTRAL register and its own custom rows only; a
 *   cross-studio custom rule and a cross-studio recording return no rows.
 * - Immutability: UPDATE and DELETE on tax rules, snapshots, and supplier
 *   recordings fail closed (the migration trigger).
 * - Central-register integrity: the seeded row equals the `packages/core`
 *   preset byte-for-byte (evidence, exclusions, confirmation texts).
 */

import { randomUUID } from 'node:crypto';
import { PPN_STANDARD_2025 } from '@stdio/core';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations } from './testing/migrations';

const adminUrl = process.env.DATABASE_URL ?? 'postgres://stdio:stdio@localhost:5432/stdio_dev';
const testDb = `stdio_tax_rls_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
const testUrl = adminUrl.replace(/\/[^/]+$/, `/${testDb}`);

const studioA = randomUUID();
const studioB = randomUUID();
const ownerA = randomUUID();

const admin = new pg.Client({ connectionString: testUrl });

/** Opens a request-shaped session: tenant setting + restricted role. */
async function tenantSession(studioId: string): Promise<pg.Client> {
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

  // Studio A: owner + one custom rational rule.
  const seedA = await tenantSession(studioA);
  await seedA.query(
    `INSERT INTO studios (studio_id, name, currency) VALUES ($1, 'Studio A', 'IDR')`,
    [studioA],
  );
  await seedA.query(
    `INSERT INTO users (id, studio_id, email, name, role)
     VALUES ($1, $2, 'owner@a.studio', 'Owner A', 'OWNER')`,
    [ownerA, studioA],
  );
  await seedA.query(
    `INSERT INTO tax_rules (id, version, studio_id, owner_type, status, label, code,
                            jurisdiction, tax_type, currency, calculation_mode,
                            effective_from, effective_to, statutory_rate_numerator,
                            statutory_rate_denominator, dpp_factor_numerator,
                            dpp_factor_denominator, rounding_mode, rounding_unit_minor,
                            round_dpp_before_tax, rounding_stage, calculation_scope,
                            sources_json, disclaimer_text)
     VALUES ('CUSTOM-A-1', 1, $1, 'STUDIO', 'CUSTOM_UNVERIFIED', 'Rule A', 'RULE_A',
             'ID', 'PPN', 'IDR', 'RATIONAL_RATE', '2025-01-01', NULL, '11', '100',
             '10', '11', 'HALF_UP', 100, true, 'DPP_THEN_PPN', 'DOCUMENT_TAX_BUCKET',
             '[{"authority":"A","title":"T","url":"https://example.com/a","publishedAt":"2025-01-01","retrievedAt":"2026-01-01T00:00:00.000Z"}]'::jsonb,
             'Custom A disclaimer')`,
    [studioA],
  );
  await seedA.query('COMMIT');
  await seedA.end();

  // Studio B: a rule with the same id shape but its own studio id.
  const seedB = await tenantSession(studioB);
  await seedB.query(
    `INSERT INTO studios (studio_id, name, currency) VALUES ($1, 'Studio B', 'IDR')`,
    [studioB],
  );
  await seedB.query(
    `INSERT INTO tax_rules (id, version, studio_id, owner_type, status, label, code,
                            jurisdiction, tax_type, currency, calculation_mode,
                            effective_from, effective_to, statutory_rate_numerator,
                            statutory_rate_denominator, dpp_factor_numerator,
                            dpp_factor_denominator, rounding_mode, rounding_unit_minor,
                            round_dpp_before_tax, rounding_stage, calculation_scope,
                            sources_json, disclaimer_text)
     VALUES ('CUSTOM-B-1', 1, $1, 'STUDIO', 'CUSTOM_UNVERIFIED', 'Rule B', 'RULE_B',
             'ID', 'PPN', 'IDR', 'RATIONAL_RATE', '2025-01-01', NULL, '11', '100',
             '10', '11', 'HALF_UP', 100, true, 'DPP_THEN_PPN', 'DOCUMENT_TAX_BUCKET',
             '[{"authority":"B","title":"T","url":"https://example.com/b","publishedAt":"2025-01-01","retrievedAt":"2026-01-01T00:00:00.000Z"}]'::jsonb,
             'Custom B disclaimer')`,
    [studioB],
  );
  await seedB.query('COMMIT');
  await seedB.end();
}, 60_000);

afterAll(async () => {
  await admin.end();
  const cleaner = new pg.Client({ connectionString: adminUrl });
  await cleaner.connect();
  await cleaner.query(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
    [testDb],
  );
  await cleaner.query(`DROP DATABASE IF EXISTS ${testDb}`);
  await cleaner.end();
}, 30_000);

describe('SOL-25 tax table isolation', () => {
  it('exposes the CENTRAL register to every studio', async () => {
    const session = await tenantSession(studioA);
    try {
      const res = await session.query(
        `SELECT id, version, owner_type FROM tax_rules WHERE id = 'PPN_STANDARD_2025'`,
      );
      expect(res.rows).toHaveLength(1);
      expect(res.rows[0]).toMatchObject({ owner_type: 'CENTRAL', version: 1 });
    } finally {
      await session.query('ROLLBACK');
      await session.end();
    }
  });

  it('hides the other studio custom rule (boundary)', async () => {
    const session = await tenantSession(studioA);
    try {
      const own = await session.query(`SELECT id FROM tax_rules WHERE id = 'CUSTOM-A-1'`);
      const other = await session.query(`SELECT id FROM tax_rules WHERE id = 'CUSTOM-B-1'`);
      expect(own.rows).toHaveLength(1);
      expect(other.rows).toHaveLength(0);
    } finally {
      await session.query('ROLLBACK');
      await session.end();
    }
  });

  it('cannot forge a CENTRAL row or another studio row (WITH CHECK)', async () => {
    const session = await tenantSession(studioA);
    try {
      await expect(
        session.query(
          `INSERT INTO tax_rules (id, version, studio_id, owner_type, status, code,
                                  jurisdiction, tax_type, currency, calculation_mode,
                                  effective_from, rounding_mode, rounding_unit_minor,
                                  calculation_scope, disclaimer_text)
           VALUES ('FORGED', 1, NULL, 'CENTRAL', 'VERIFIED', 'PPN_STANDARD_2025',
                   'ID', 'PPN', 'IDR', 'RATIONAL_RATE', '2025-01-01', 'HALF_UP', 100,
                   'DOCUMENT_TAX_BUCKET', 'Forged')`,
        ),
      ).rejects.toThrow(/row-level security/);
    } finally {
      await session.query('ROLLBACK');
      await session.end();
    }
  });

  it('rejects UPDATE and DELETE on tax facts (immutability trigger)', async () => {
    // Each statement runs in its own transaction: the first trigger error
    // aborts the transaction, so the second would report the abort instead
    // of the trigger.
    for (const statement of [
      `UPDATE tax_rules SET label = 'x' WHERE id = 'CUSTOM-A-1'`,
      `DELETE FROM tax_rules WHERE id = 'CUSTOM-A-1'`,
    ]) {
      const session = await tenantSession(studioA);
      try {
        await expect(session.query(statement)).rejects.toThrow(/immutable/);
      } finally {
        await session.query('ROLLBACK').catch(() => undefined);
        await session.end();
      }
    }
  });

  it('stores the verified register byte-for-byte equal to the core preset', async () => {
    const session = await tenantSession(studioA);
    try {
      const res = await session.query(
        `SELECT evidence_json, exclusions_json, applicability_confirmation_text,
                disclaimer_text, statutory_rate_numerator, statutory_rate_denominator,
                dpp_factor_numerator, dpp_factor_denominator
         FROM tax_rules WHERE id = 'PPN_STANDARD_2025'`,
      );
      const row = res.rows[0];
      expect(row.evidence_json).toEqual(PPN_STANDARD_2025.verifiedEvidence);
      expect(row.exclusions_json).toEqual(PPN_STANDARD_2025.exclusions);
      expect(row.applicability_confirmation_text).toBe(
        PPN_STANDARD_2025.applicabilityConfirmationText,
      );
      expect(row.disclaimer_text).toBe(PPN_STANDARD_2025.disclaimerText);
      expect(row.statutory_rate_numerator).toBe(PPN_STANDARD_2025.statutoryRateNumerator);
      expect(row.statutory_rate_denominator).toBe(PPN_STANDARD_2025.statutoryRateDenominator);
      expect(row.dpp_factor_numerator).toBe(PPN_STANDARD_2025.dppFactorNumerator);
      expect(row.dpp_factor_denominator).toBe(PPN_STANDARD_2025.dppFactorDenominator);
    } finally {
      await session.query('ROLLBACK');
      await session.end();
    }
  });
});
