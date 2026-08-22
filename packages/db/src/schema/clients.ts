import { sql } from 'drizzle-orm';
import { foreignKey, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { studios, tenantColumns, users } from './base';

/**
 * The person or company who pays. Shape from `ClientSummary` in
 * `contracts/openapi/native-v1.yaml`. Label fields (`statusLabel`,
 * `clientTypeLabel`, `leadSourceLabel`) are derived by the server, not stored.
 */
export const clients = pgTable(
  'clients',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    studioId: uuid('studio_id')
      .notNull()
      .references(() => studios.id),
    clientNumber: text('client_number').notNull(),
    name: text('name').notNull(),
    /** `clientTypeLabel` source value. */
    clientType: text('client_type').notNull().default('COMPANY'),
    companyName: text('company_name'),
    location: text('location'),
    leadSource: text('lead_source'),
    status: text('status').notNull().default('ACTIVE'),
    tags: text('tags').array().notNull().default(sql`'{}'`),
    primaryContactName: text('primary_contact_name'),
    primaryContactEmail: text('primary_contact_email'),
    primaryContactPhone: text('primary_contact_phone'),
    /** `accountManager` is a `Person` reference, matched below to this studio. */
    accountManagerId: uuid('account_manager_id'),
    lastContactedAt: timestamp('last_contacted_at', { withTimezone: true }),
    entityVersion: uuid('entity_version').notNull().defaultRandom(),
    ...tenantColumns,
  },
  (table) => [
    /** Referenced by child tables through tenant-matching foreign keys. */
    unique('clients_studio_id_unq').on(table.studioId, table.id),
    /**
     * Tenant-matching foreign key: the account manager must belong to the
     * same studio as the client. Row-Level Security isolates reads and
     * writes; this constraint proves same-tenant referential integrity.
     */
    foreignKey({
      columns: [table.studioId, table.accountManagerId],
      foreignColumns: [users.studioId, users.id],
      name: 'clients_account_manager_tenant_fk',
    }),
  ],
);
