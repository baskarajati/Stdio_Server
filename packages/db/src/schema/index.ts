/**
 * The Stdio schema.
 *
 * Every table carries a `studio_id` column, because the studio is the tenant.
 * Every table gets a Row-Level Security policy in the SQL migration. Read
 * `docs/adr/0001-stack.md` for the reason.
 *
 * This file stays as the single export point for the schema. The migration
 * tool reads it through `drizzle.config.ts`.
 */

export * from './auth';
export * from './base';
export * from './clients';
export * from './idempotency';
export * from './invoices';
export * from './project-changes';
export * from './projects';
export * from './purchase-orders';
export * from './quotations';
export * from './tax';
export * from './timesheets';
export * from './variation-orders';
export * from './vendors';
