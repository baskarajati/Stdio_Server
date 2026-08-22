import { boolean, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { studios, tenantColumns } from './base';

/**
 * The supplier a purchase order is raised against. Shape from
 * `VendorSummary` in `contracts/openapi/native-v1.yaml`. `apOutstandingLabel`
 * and the counts are derived by the server, not stored.
 */
export const vendors = pgTable('vendors', {
  id: uuid('id').primaryKey().defaultRandom(),
  studioId: uuid('studio_id')
    .notNull()
    .references(() => studios.id),
  vendorCode: text('vendor_code').notNull(),
  name: text('name').notNull(),
  email: text('email'),
  phone: text('phone'),
  website: text('website'),
  category: text('category'),
  paymentTerms: text('payment_terms'),
  preferred: boolean('preferred').notNull().default(false),
  blocked: boolean('blocked').notNull().default(false),
  blockedReason: text('blocked_reason'),
  status: text('status').notNull().default('ACTIVE'),
  entityVersion: uuid('entity_version').notNull().defaultRandom(),
  ...tenantColumns,
});
