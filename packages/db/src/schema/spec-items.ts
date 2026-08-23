import { foreignKey, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { studios, tenantColumns } from './base';
import { projects } from './projects';

/**
 * A specification item on a project. Shape from `SpecItemSummary` /
 * `SpecItemDetail` in `contracts/openapi/native-v1.yaml`. The register
 * writes (SOL-19 revision 6) create and update the draft fields; the stage,
 * signals, alternates and money fields are projected by the server.
 */
export const specItems = pgTable(
  'spec_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    studioId: uuid('studio_id')
      .notNull()
      .references(() => studios.id),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id),
    name: text('name').notNull(),
    room: text('room'),
    quantityLabel: text('quantity_label'),
    brand: text('brand'),
    category: text('category'),
    entityVersion: uuid('entity_version').notNull().defaultRandom(),
    ...tenantColumns,
  },
  (table) => [
    unique('spec_items_studio_id_unq').on(table.studioId, table.id),
    /**
     * Tenant-matching foreign key: the project must belong to the same
     * studio as the spec item. Row-Level Security isolates reads and
     * writes; this constraint proves same-tenant referential integrity.
     */
    foreignKey({
      columns: [table.studioId, table.projectId],
      foreignColumns: [projects.studioId, projects.id],
      name: 'spec_items_project_tenant_fk',
    }),
  ],
);
