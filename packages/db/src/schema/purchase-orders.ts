import {
  type AnyPgColumn,
  boolean,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { studios, tenantColumns } from './base';
import { projects } from './projects';
import { vendors } from './vendors';

/**
 * What the studio buys from a supplier for a project. Shape from
 * `PurchaseOrderSummary`, `PurchaseOrderDetail`, `PurchaseOrderLineItem`,
 * `GoodsReceipt` and `GoodsReceiptLine` in `contracts/openapi/native-v1.yaml`.
 */
export const purchaseOrders = pgTable('purchase_orders', {
  id: uuid('id').primaryKey().defaultRandom(),
  studioId: uuid('studio_id')
    .notNull()
    .references(() => studios.id),
  purchaseOrderNumber: text('purchase_order_number').notNull(),
  projectId: uuid('project_id')
    .notNull()
    .references(() => projects.id),
  vendorId: uuid('vendor_id')
    .notNull()
    .references(() => vendors.id),
  /** One of the contract statuses: DRAFT, SENT, CONFIRMED, ... */
  status: text('status').notNull().default('DRAFT'),
  currency: text('currency').notNull().default('IDR'),
  issueDate: timestamp('issue_date', { withTimezone: true }).notNull(),
  expectedDate: timestamp('expected_date', { withTimezone: true }),
  notes: text('notes'),
  totalAmount: numeric('total_amount', { precision: 20, scale: 2 }),
  /** Change-control snapshot. `PurchaseOrderChangeControl`. */
  isAmended: boolean('is_amended').notNull().default(false),
  confirmedExpectedDate: timestamp('confirmed_expected_date', { withTimezone: true }),
  confirmedTotal: numeric('confirmed_total', { precision: 20, scale: 2 }),
  cancellationReason: text('cancellation_reason'),
  changeControlNotes: text('change_control_notes'),
  entityVersion: uuid('entity_version').notNull().defaultRandom(),
  ...tenantColumns,
});

/** One line of a purchase order. Shape from `PurchaseOrderLineItem`. */
export const purchaseOrderItems = pgTable('purchase_order_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  studioId: uuid('studio_id')
    .notNull()
    .references(() => studios.id),
  purchaseOrderId: uuid('purchase_order_id')
    .notNull()
    .references(() => purchaseOrders.id),
  description: text('description').notNull(),
  /** Quantities travel as decimal strings in the contract. */
  quantity: numeric('quantity', { precision: 20, scale: 4 }).notNull(),
  receivedQuantity: numeric('received_quantity', { precision: 20, scale: 4 })
    .notNull()
    .default('0'),
  unitCost: numeric('unit_cost', { precision: 20, scale: 2 }),
  lineTotal: numeric('line_total', { precision: 20, scale: 2 }),
  /** One of ordered, backordered, partiallyReceived, received, installed. */
  receivingState: text('receiving_state').notNull().default('ordered'),
  expectedShipDate: timestamp('expected_ship_date', { withTimezone: true }),
  specItemId: uuid('spec_item_id'),
  ...tenantColumns,
});

/** One goods receipt against a purchase order. Shape from `GoodsReceipt`. */
export const goodsReceipts = pgTable('goods_receipts', {
  id: uuid('id').primaryKey().defaultRandom(),
  studioId: uuid('studio_id')
    .notNull()
    .references(() => studios.id),
  purchaseOrderId: uuid('purchase_order_id')
    .notNull()
    .references(() => purchaseOrders.id),
  number: text('number').notNull(),
  /** One of ORIGINAL, REVERSAL. */
  kind: text('kind').notNull().default('ORIGINAL'),
  reversalOfId: uuid('reversal_of_id').references((): AnyPgColumn => goodsReceipts.id),
  reversalReason: text('reversal_reason'),
  deliveryReference: text('delivery_reference').notNull(),
  receiptDate: timestamp('receipt_date', { withTimezone: true }).notNull(),
  issuedAt: timestamp('issued_at', { withTimezone: true }).notNull(),
  receiverNameSnapshot: text('receiver_name_snapshot').notNull(),
  evidenceFileId: uuid('evidence_file_id'),
  evidenceUrl: text('evidence_url'),
  ...tenantColumns,
});

/** One received line inside a goods receipt. Shape from `GoodsReceiptLine`. */
export const goodsReceiptLines = pgTable('goods_receipt_lines', {
  id: uuid('id').primaryKey().defaultRandom(),
  studioId: uuid('studio_id')
    .notNull()
    .references(() => studios.id),
  goodsReceiptId: uuid('goods_receipt_id')
    .notNull()
    .references(() => goodsReceipts.id),
  purchaseOrderItemId: uuid('purchase_order_item_id')
    .notNull()
    .references(() => purchaseOrderItems.id),
  descriptionSnapshot: text('description_snapshot').notNull(),
  quantity: numeric('quantity', { precision: 20, scale: 4 }).notNull(),
  ...tenantColumns,
});
