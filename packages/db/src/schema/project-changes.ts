import { pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { studios, tenantColumns } from './base';
import { projectEngagements, projects } from './projects';

/**
 * A proposed change to a signed engagement. SOL-28 requirement 2: the
 * variation order keeps its project-change source. The native action
 * `approveAndIssueNativeProjectVariationOrder` (contract L3734) consumes one
 * ELIGIBLE change and mints the issued variation order atomically.
 *
 * Status vocabulary (proposed in the SOL-28 contract review):
 * - PROPOSED: recorded, not yet assessed.
 * - ELIGIBLE: assessed; may be approved and issued.
 * - CONSUMED: a variation order was approved and issued from it.
 * - REJECTED: assessed and declined. It never mints a variation order.
 */
export const projectChanges = pgTable(
  'project_changes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    studioId: uuid('studio_id')
      .notNull()
      .references(() => studios.id),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id),
    /** D-019: the change belongs to one engagement, not to the project pot. */
    engagementId: uuid('engagement_id')
      .notNull()
      .references(() => projectEngagements.id),
    changeNumber: text('change_number').notNull(),
    changeType: text('change_type').notNull().default('SCOPE'),
    status: text('status').notNull().default('PROPOSED'),
    title: text('title').notNull(),
    description: text('description'),
    entityVersion: uuid('entity_version').notNull().defaultRandom(),
    ...tenantColumns,
  },
  (table) => [
    uniqueIndex('project_changes_studio_number_idx').on(table.studioId, table.changeNumber),
  ],
);
