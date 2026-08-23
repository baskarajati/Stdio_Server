/**
 * Seeds one test studio into the database at `DATABASE_URL`.
 *
 * One command: `pnpm db:seed` from the repository root.
 *
 * The seed runs on the tenant path (`app.studio_id` + `studio_app` role),
 * exactly like the production server writes. Even the studio row itself is
 * written that way: Row-Level Security is forced on the owner, so no path
 * in this script bypasses the boundary.
 *
 * Running the seed twice updates the same rows; it never duplicates them.
 *
 * The function is also exported so integration suites can seed their own
 * scratch database (SOL-134: the tax-slice suite must never write TEST- rows
 * into the shared `stdio_dev` database).
 */
import { pathToFileURL } from 'node:url';
import pg from 'pg';

/** Stable ids so the seed is idempotent and the fixtures are addressable. */
const IDS = {
  studio: '00000000-0000-4000-8000-000000000001',
  owner: '00000000-0000-4000-8000-000000000002',
  client: '00000000-0000-4000-8000-000000000003',
  project: '00000000-0000-4000-8000-000000000004',
  vendor: '00000000-0000-4000-8000-000000000005',
  quotation: '00000000-0000-4000-8000-000000000006',
  quotationItem: '00000000-0000-4000-8000-000000000007',
  invoice: '00000000-0000-4000-8000-000000000008',
  invoicePayment: '00000000-0000-4000-8000-000000000009',
  purchaseOrder: '00000000-0000-4000-8000-00000000000a',
  purchaseOrderItem: '00000000-0000-4000-8000-00000000000b',
  variationOrder: '00000000-0000-4000-8000-00000000000c',
  timesheetEntry: '00000000-0000-4000-8000-00000000000d',
  designEngagement: '00000000-0000-4000-8000-00000000000e',
  buildEngagement: '00000000-0000-4000-8000-00000000000f',
  projectChange: '00000000-0000-4000-8000-000000000010',
};

/** Seeds the Studio Contoh fixtures. See the module doc comment. */
export async function seedDatabase(connectionString: string): Promise<void> {
  const session = new pg.Client({ connectionString });
  await session.connect();
  try {
    await session.query('BEGIN');
    await session.query('SELECT set_config($1, $2, true)', ['app.studio_id', IDS.studio]);
    await session.query('SET LOCAL ROLE studio_app');

    await session.query(
      `INSERT INTO studios (studio_id, name, currency, timezone)
       VALUES ($1, 'Studio Contoh', 'IDR', 'Asia/Jakarta')
       ON CONFLICT (studio_id) DO UPDATE SET name = EXCLUDED.name`,
      [IDS.studio],
    );

    await session.query(
      `INSERT INTO users (id, studio_id, email, name, role, hourly_rate)
       VALUES ($1, $2, 'owner@contoh.studio', 'Pemilik Studio', 'OWNER', '125000.0000')
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, hourly_rate = EXCLUDED.hourly_rate`,
      [IDS.owner, IDS.studio],
    );

    await session.query(
      `INSERT INTO clients (id, studio_id, client_number, name, company_name, location, status)
       VALUES ($1, $2, 'CL-001', 'PT Klien Contoh', 'PT Klien Contoh', 'Jakarta', 'ACTIVE')
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
      [IDS.client, IDS.studio],
    );

    await session.query(
      `INSERT INTO projects (id, studio_id, project_code, name, client_id, manager_id,
                             start_date, status, budget_amount)
       VALUES ($1, $2, 'PRJ-001', 'Apartemen Klien Contoh', $3, $4,
               '2026-08-01', 'ACTIVE', '850000000.00')
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
      [IDS.project, IDS.studio, IDS.client, IDS.owner],
    );

    // SOL-28/D-019: money and scope belong to the engagement. The seed gives
    // the design-build example project two engagements, exactly like the
    // decision record's Rumah Pak Andi case (design Rp 150jt, build Rp 850jt).
    await session.query(
      `INSERT INTO project_engagements (id, studio_id, project_id, kind, sort_order,
                                        lifecycle_status, contract_state, contract_value,
                                        current_phase_key, phase_count, completed_phase_count)
       VALUES ($1, $2, $3, 'DESIGN', 1, 'ACTIVE', 'SIGNED', '150000000.00',
               'design-development', 3, 1)
       ON CONFLICT (id) DO UPDATE SET kind = EXCLUDED.kind,
             sort_order = EXCLUDED.sort_order,
             lifecycle_status = EXCLUDED.lifecycle_status,
             contract_state = EXCLUDED.contract_state,
             contract_value = EXCLUDED.contract_value,
             current_phase_key = EXCLUDED.current_phase_key,
             phase_count = EXCLUDED.phase_count,
             completed_phase_count = EXCLUDED.completed_phase_count`,
      [IDS.designEngagement, IDS.studio, IDS.project],
    );

    await session.query(
      `INSERT INTO project_engagements (id, studio_id, project_id, kind, sort_order,
                                        lifecycle_status, contract_state, contract_value,
                                        current_phase_key, phase_count, completed_phase_count)
       VALUES ($1, $2, $3, 'BUILD', 2, 'ACTIVE', 'SIGNED', '850000000.00', 'construction', 1, 0)
       ON CONFLICT (id) DO UPDATE SET kind = EXCLUDED.kind,
             sort_order = EXCLUDED.sort_order,
             lifecycle_status = EXCLUDED.lifecycle_status,
             contract_state = EXCLUDED.contract_state,
             contract_value = EXCLUDED.contract_value,
             current_phase_key = EXCLUDED.current_phase_key,
             phase_count = EXCLUDED.phase_count,
             completed_phase_count = EXCLUDED.completed_phase_count`,
      [IDS.buildEngagement, IDS.studio, IDS.project],
    );

    // SOL-28: an eligible project change that the variation-order write can
    // consume. The change belongs to the build engagement.
    await session.query(
      `INSERT INTO project_changes (id, studio_id, project_id, engagement_id, change_number,
                                    change_type, status, title)
       VALUES ($1, $2, $3, $4, 'PC-001', 'SCOPE', 'ELIGIBLE',
               'Tambah dinding partisi ruang kerja')
       ON CONFLICT (id) DO UPDATE
         SET title = EXCLUDED.title,
             status = 'ELIGIBLE',
             entity_version = gen_random_uuid()`,
      [IDS.projectChange, IDS.studio, IDS.project, IDS.buildEngagement],
    );

    await session.query(
      `INSERT INTO vendors (id, studio_id, vendor_code, name, category)
       VALUES ($1, $2, 'VEN-001', 'CV Mebel Jaya', 'FURNITURE')
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
      [IDS.vendor, IDS.studio],
    );

    await session.query(
      `INSERT INTO quotations (id, studio_id, quotation_number, title, client_id, project_id,
                               engagement_id, version, status, currency, subtotal_amount,
                               total_amount, quotation_date)
       VALUES ($1, $2, 'QUO-001', 'Desain Interior Apartemen', $3, $4, $5, 1, 'SENT', 'IDR',
               '850000000.00', '943500000.00', '2026-08-01')
       ON CONFLICT (id) DO UPDATE
         SET title = EXCLUDED.title,
             engagement_id = EXCLUDED.engagement_id`,
      [IDS.quotation, IDS.studio, IDS.client, IDS.project, IDS.buildEngagement],
    );

    await session.query(
      `INSERT INTO quotation_items (id, studio_id, quotation_id, line_order, line_type,
                                    description, unit, quantity, unit_rate, line_subtotal,
                                    line_total)
       VALUES ($1, $2, $3, 1, 'FEE', 'Jasa desain interior', 'lot', '1.0000',
               '850000000.00', '850000000.00', '850000000.00')
       ON CONFLICT (id) DO UPDATE SET description = EXCLUDED.description`,
      [IDS.quotationItem, IDS.studio, IDS.quotation],
    );

    await session.query(
      `INSERT INTO invoices (id, studio_id, invoice_number, client_id, project_id,
                             engagement_id, billing_basis, status, currency, issue_date,
                             due_date, issued_at, total_amount, created_by_user_id)
       VALUES ($1, $2, 'INV-001', $3, $4, $5, 'MANUAL', 'PAID', 'IDR', '2026-08-05',
               '2026-08-19', '2026-08-05T09:00:00Z', '283050000.00', $6)
       ON CONFLICT (id) DO UPDATE
         SET status = EXCLUDED.status,
             engagement_id = EXCLUDED.engagement_id`,
      [IDS.invoice, IDS.studio, IDS.client, IDS.project, IDS.buildEngagement, IDS.owner],
    );

    await session.query(
      `INSERT INTO invoice_payments (id, studio_id, invoice_id, amount, paid_at, method)
       VALUES ($1, $2, $3, '283050000.00', '2026-08-10T10:00:00Z', 'TRANSFER')
       ON CONFLICT (id) DO NOTHING`,
      [IDS.invoicePayment, IDS.studio, IDS.invoice],
    );

    await session.query(
      `INSERT INTO purchase_orders (id, studio_id, purchase_order_number, project_id, vendor_id,
                                    status, currency, issue_date, total_amount)
       VALUES ($1, $2, 'PO-001', $3, $4, 'CONFIRMED', 'IDR', '2026-08-12', '120000000.00')
       ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status`,
      [IDS.purchaseOrder, IDS.studio, IDS.project, IDS.vendor],
    );

    await session.query(
      `INSERT INTO purchase_order_items (id, studio_id, purchase_order_id, description,
                                         quantity, unit_cost, line_total, receiving_state)
       VALUES ($1, $2, $3, 'Sofa 3 dudukan', '2.0000', '60000000.00', '120000000.00', 'ordered')
       ON CONFLICT (id) DO UPDATE SET description = EXCLUDED.description`,
      [IDS.purchaseOrderItem, IDS.studio, IDS.purchaseOrder],
    );

    await session.query(
      `INSERT INTO variation_orders (id, studio_id, project_id, engagement_id, display_number,
                                     system_number, status, currency, issued_at, effective_date,
                                     fee_effect, boq_effect, total_amount)
       VALUES ($1, $2, $3, $4, 'VO-001', 'VO-001', 'ISSUED', 'IDR',
               '2026-08-15T08:00:00Z', '2026-08-15',
               '25000000.00', '95000000.00', '131950000.00')
       ON CONFLICT (id) DO UPDATE
         SET status = EXCLUDED.status,
             engagement_id = EXCLUDED.engagement_id`,
      [IDS.variationOrder, IDS.studio, IDS.project, IDS.buildEngagement],
    );

    await session.query(
      `INSERT INTO timesheet_entries (id, studio_id, user_id, project_id, entry_date, hours,
                                      notes, status, effective_hourly_rate)
       VALUES ($1, $2, $3, $4, '2026-08-20T00:00:00.000Z', '7.50', 'Survei lokasi', 'LOGGED',
               '125000.0000')
       ON CONFLICT (id) DO UPDATE SET hours = EXCLUDED.hours`,
      [IDS.timesheetEntry, IDS.studio, IDS.owner, IDS.project],
    );

    await session.query('COMMIT');
  } catch (error) {
    await session.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await session.end();
  }

  console.log(`Seeded studio ${IDS.studio} (Studio Contoh) into the database.`);
}

async function main(): Promise<void> {
  const connectionString =
    process.env.DATABASE_URL ?? 'postgres://stdio:stdio@localhost:5432/stdio_dev';
  await seedDatabase(connectionString);
}

/** Runs the seed only when executed directly (pnpm db:seed), not on import. */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
