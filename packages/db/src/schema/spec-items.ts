import { foreignKey, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { studios, tenantColumns } from './base';
import { projects } from './projects';

/**
 * One specification item on a project. Shape from `SpecItemSummary` and
 * `SpecItemDetail` in `contracts/openapi/native-v1.yaml` (SOL-19 register
 * writes). The tenant-matching foreign key proves the project belongs to the
 * same studio as the spec item; Row-Level Security isolates reads and writes.
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
    /** Tenant-matching foreign key: the project must belong to this studio. */
    foreignKey({
      columns: [table.studioId, table.projectId],
      foreignColumns: [projects.studioId, projects.id],
      name: 'spec_items_project_tenant_fk',
    }),
  ],
);
