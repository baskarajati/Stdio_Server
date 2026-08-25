/**
 * Purchase-order workspace reads (SOL-163 slice 2).
 *
 * Contract surface (contracts/openapi/native-v1.yaml):
 *
 * - `GET /purchase-orders` — tenant-scoped register (`q`, `page`,
 *   `pageSize`; `meta.pagination` envelope; `PurchaseOrderSummary` rows).
 * - `GET /purchase-orders/{id}` — detail with the weak ETag
 *   (`PurchaseOrderDetail`, line items, change control).
 *
 * Every read runs inside the tenant transaction (ADR 0002): a cross-studio
 * purchase-order id is a plain 404 under RLS.
 *
 * Role lenses (native consumer parity, BusinessAppProcurement.swift):
 *
 * - `canReadProcurementCosts` masks the PO totals and the line costs
 *   (`totalLabel`, `unitCostLabel`, `lineTotalLabel`, `confirmedTotalLabel`,
 *   `currentTotalLabel`). OWNER, FINANCE and PROCUREMENT can read them.
 * - `canReadFinance` masks the change-control deltas (`isAmended`,
 *   `amountVarianceLabel`). OWNER and FINANCE can read them.
 *
 * Money numbers are `RawDecimal` (emitted verbatim by `serializeJson`); the
 * labels are formatted from the same `numeric(20,2)` value through integer
 * minor-unit arithmetic, never a float. Quantities are `numeric(20,4)` and
 * travel as canonical decimal strings (`parseScaled` / `formatScaled`).
 *
 * `receivingState` is derived from the stored received/ordered quantities:
 * `received` at or above ordered, `partiallyReceived` in between, `ordered`
 * at zero. The non-quantity states `backordered` and `installed` are only
 * read from the stored column (a later install/receipt write sets them).
 */

import { parseScaled } from '@stdio/core';
import { schema } from '@stdio/db';
import { and, eq, sql } from 'drizzle-orm';
import type { Hono } from 'hono';
import type { Pool } from 'pg';

import type { ServerEnv } from '../app';
import { type Db, type StudioRole, withStudioTx } from '../context/db';
import { etagFor, meta, problem, requestBuildOf } from '../http';
import { jsonResponse, moneyNumber } from '../money';
import { moneyLabel, statusLabel } from '../projections';

const { purchaseOrders, purchaseOrderItems, projects, vendors } = schema;

/** Quantities are `numeric(20,4)` in the schema (matching the contract). */
const QUANTITY_SCALE = 4;
/** Money columns are `numeric(20,2)`. */
const MONEY_SCALE = 2;

type Tone = 'danger' | 'info' | 'neutral' | 'success' | 'warning';

const STAGE_SPECS: Record<
  string,
  {
    stage: 'closed' | 'draft' | 'notProceeding' | 'ordered' | 'received' | 'receiving' | 'sent';
    label: string;
    tone: Tone;
  }
> = {
  DRAFT: { stage: 'draft', label: 'Draft', tone: 'neutral' },
  SENT: { stage: 'sent', label: 'Sent', tone: 'info' },
  CONFIRMED: { stage: 'ordered', label: 'Ordered', tone: 'info' },
  PARTIALLY_RECEIVED: { stage: 'receiving', label: 'Receiving', tone: 'warning' },
  RECEIVED: { stage: 'received', label: 'Received', tone: 'success' },
  CLOSED: { stage: 'closed', label: 'Closed', tone: 'neutral' },
  ARCHIVED: { stage: 'closed', label: 'Closed', tone: 'neutral' },
  CANCELLED: { stage: 'notProceeding', label: 'Not proceeding', tone: 'danger' },
  DECLINED: { stage: 'notProceeding', label: 'Not proceeding', tone: 'danger' },
  VENDOR_DECLINED: { stage: 'notProceeding', label: 'Not proceeding', tone: 'danger' },
  BACKORDERED: { stage: 'notProceeding', label: 'Not proceeding', tone: 'danger' },
};

const DEFAULT_STAGE: { stage: 'draft'; label: string; tone: 'neutral' } = {
  stage: 'draft',
  label: 'Draft',
  tone: 'neutral',
};

const RECEIVING_SIGNALS: Record<string, { label: string; tone: Tone }> = {
  ordered: { label: 'Ordered', tone: 'neutral' },
  backordered: { label: 'Backordered', tone: 'danger' },
  partiallyReceived: { label: 'Partially received', tone: 'warning' },
  received: { label: 'Received', tone: 'success' },
  installed: { label: 'Installed', tone: 'success' },
};

/** The only target statuses the contract's status write declares. */
const TRANSITION_OPTIONS: { label: string; value: 'CONFIRMED' | 'CANCELLED' }[] = [
  { label: 'Confirm', value: 'CONFIRMED' },
  { label: 'Cancel', value: 'CANCELLED' },
];

/** Roles and lenses for the purchase-order workspace. */
function purchaseOrderCapabilities(role: StudioRole) {
  const canReadFinance = role === 'OWNER' || role === 'FINANCE';
  const canReadProcurementCosts = canReadFinance || role === 'PROCUREMENT';
  const canTransitionStatus = role === 'OWNER';
  return {
    canReadFinance,
    canReadProcurementCosts,
    capabilities: {
      read: { enabled: true, reason: '' },
      transitionStatus: {
        enabled: canTransitionStatus,
        reason: canTransitionStatus
          ? ''
          : 'Only the studio owner can change purchase order status.',
      },
    },
  };
}

/** Available transitions for the current status (write surface ships later). */
function availableStatusTransitions(
  status: string,
): { label: string; value: 'CONFIRMED' | 'CANCELLED' }[] {
  switch (status) {
    case 'DRAFT':
    case 'SENT':
      return TRANSITION_OPTIONS;
    case 'CONFIRMED':
    case 'PARTIALLY_RECEIVED':
    case 'RECEIVED':
    case 'BACKORDERED':
      return [{ label: 'Cancel', value: 'CANCELLED' }];
    default:
      return [];
  }
}

/** `minor / 10^scale` as a canonical decimal string with trailing zeros trimmed. */
function canonicalScaled(minor: bigint, scale: number): string {
  const negative = minor < 0n;
  const absolute = negative ? -minor : minor;
  const divisor = 10n ** BigInt(scale);
  const whole = absolute / divisor;
  const fraction = (absolute % divisor).toString().padStart(scale, '0').replace(/0+$/, '');
  const text = fraction === '' ? `${whole}` : `${whole}.${fraction}`;
  return negative ? `-${text}` : text;
}

/** Canonical decimal string for a `numeric(20,4)` quantity column. */
function quantityWire(value: string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return canonicalScaled(parseScaled(value, QUANTITY_SCALE), QUANTITY_SCALE);
}

/** The presentation label for a quantity, e.g. `2` or `2,5`. */
function quantityLabel(value: string | null | undefined): string | null {
  const wire = quantityWire(value);
  if (wire === null) {
    return null;
  }
  const [whole, fraction] = wire.split('.');
  const fractionText = fraction === undefined ? '' : `,${fraction}`;
  return `${new Intl.NumberFormat('id-ID').format(Number(whole))}${fractionText}`;
}

/** Humanized label for a camelCase receiving state: `partiallyReceived` -> `Partially Received`. */
function receivingStateLabel(state: string): string {
  const words = state.replace(/([a-z])([A-Z])/g, '$1 $2').split(' ');
  return words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}

/** `X of Y received` from scaled integers, exact (never a float). */
function progressOf(received: bigint, ordered: bigint): { fraction: number; label: string } {
  const fraction = ordered > 0n ? Math.min(1, Number(received) / Number(ordered)) : 0;
  const label = `${quantityLabel(canonicalScaled(received, QUANTITY_SCALE))} of ${quantityLabel(canonicalScaled(ordered, QUANTITY_SCALE))} received`;
  return { fraction, label };
}

/** `numeric(20,2)` difference `a - b` as a canonical decimal string. */
function moneyDifference(
  a: string | null | undefined,
  b: string | null | undefined,
): string | null {
  if (a === null || a === undefined || b === null || b === undefined) {
    return null;
  }
  return canonicalScaled(parseScaled(a, MONEY_SCALE) - parseScaled(b, MONEY_SCALE), MONEY_SCALE);
}

function isoOrNull(value: Date | null | undefined): string | null {
  return value instanceof Date ? value.toISOString() : null;
}

type PurchaseOrderRow = {
  id: string;
  purchaseOrderNumber: string;
  projectId: string;
  vendorId: string;
  status: string;
  currency: string;
  issueDate: Date;
  expectedDate: Date | null;
  notes: string | null;
  totalAmount: string | null;
  isAmended: boolean;
  confirmedExpectedDate: Date | null;
  confirmedTotal: string | null;
  cancellationReason: string | null;
  changeControlNotes: string | null;
  entityVersion: string;
  updatedAt: Date;
  projectName?: string | null;
  vendorName?: string | null;
};

type PurchaseOrderCounts = {
  itemCount: number;
  ordered: bigint;
  received: bigint;
};

/** The derived per-line receiving state, exact from stored quantities. */
function receivingStateOf(row: {
  receivingState: string | null;
  quantity: string | null;
  receivedQuantity: string | null;
}): 'backordered' | 'installed' | 'ordered' | 'partiallyReceived' | 'received' {
  const stored = row.receivingState;
  if (stored === 'installed' || stored === 'backordered') {
    return stored;
  }
  const ordered = parseScaled(row.quantity ?? '0', QUANTITY_SCALE);
  const received = parseScaled(row.receivedQuantity ?? '0', QUANTITY_SCALE);
  if (ordered <= 0n || received <= 0n) {
    return 'ordered';
  }
  if (received >= ordered) {
    return 'received';
  }
  return 'partiallyReceived';
}

/** One `PurchaseOrderLineItem` wire object (money masked by the cost lens). */
function projectLineItem(
  row: {
    id: string;
    description: string;
    quantity: string | null;
    receivedQuantity: string | null;
    unitCost: string | null;
    lineTotal: string | null;
    receivingState: string | null;
    expectedShipDate: Date | null;
    specItemId: string | null;
  },
  canReadProcurementCosts: boolean,
  currency: string,
): Record<string, unknown> {
  const state = receivingStateOf(row);
  const received = parseScaled(row.receivedQuantity ?? '0', QUANTITY_SCALE);
  const ordered = parseScaled(row.quantity ?? '0', QUANTITY_SCALE);
  const signal = RECEIVING_SIGNALS[state] ?? RECEIVING_SIGNALS.ordered;
  return {
    description: row.description,
    expectedShipDate: isoOrNull(row.expectedShipDate),
    hasSpecLink: row.specItemId !== null,
    id: row.id,
    lineTotal: canReadProcurementCosts ? moneyNumber(row.lineTotal, currency) : null,
    lineTotalLabel: canReadProcurementCosts ? moneyLabel(row.lineTotal, currency) : null,
    quantity: quantityWire(row.quantity),
    quantityLabel: quantityLabel(row.quantity),
    receivedQuantity: quantityWire(row.receivedQuantity),
    receivedProgress: progressOf(received, ordered),
    receivingState: state,
    receivingStateLabel: receivingStateLabel(state),
    receivingStateSignal: signal,
    specItemId: row.specItemId,
    unitCost: canReadProcurementCosts ? moneyNumber(row.unitCost, currency) : null,
    unitCostLabel: canReadProcurementCosts ? moneyLabel(row.unitCost, currency) : null,
  };
}

/** `PurchaseOrderChangeControl` from the stored columns (native parity). */
function projectChangeControl(
  row: PurchaseOrderRow,
  caps: ReturnType<typeof purchaseOrderCapabilities>,
): Record<string, unknown> {
  const confirmedTotal = row.confirmedTotal ?? null;
  const currentTotal = row.totalAmount ?? null;
  const amountVariance = moneyDifference(currentTotal, confirmedTotal);
  const dateAmended =
    row.isAmended &&
    row.confirmedExpectedDate !== null &&
    row.expectedDate !== null &&
    row.confirmedExpectedDate.getTime() !== row.expectedDate.getTime();
  return {
    amountVariance: caps.canReadFinance ? moneyNumber(amountVariance, row.currency) : null,
    amountVarianceLabel: caps.canReadFinance ? moneyLabel(amountVariance, row.currency) : null,
    cancellationReason: row.cancellationReason,
    confirmedExpectedDate: isoOrNull(row.confirmedExpectedDate),
    confirmedTotalLabel: caps.canReadProcurementCosts
      ? moneyLabel(row.confirmedTotal, row.currency)
      : null,
    currentExpectedDate: isoOrNull(row.expectedDate),
    currentTotalLabel: caps.canReadProcurementCosts
      ? moneyLabel(row.totalAmount, row.currency)
      : null,
    dateAmended,
    isAmended: caps.canReadFinance ? row.isAmended : null,
    notes: row.changeControlNotes,
    statusLabel: statusLabel(row.status) ?? row.status,
  };
}

/** `PurchaseOrderSummary` wire object (the register row). */
function projectPurchaseOrderSummary(
  row: PurchaseOrderRow,
  counts: PurchaseOrderCounts,
  caps: ReturnType<typeof purchaseOrderCapabilities>,
): Record<string, unknown> {
  const stage = STAGE_SPECS[row.status] ?? DEFAULT_STAGE;
  return {
    availableStatusTransitions: availableStatusTransitions(row.status),
    canReadFinance: caps.canReadFinance,
    canReadProcurementCosts: caps.canReadProcurementCosts,
    capabilities: caps.capabilities,
    entityVersion: row.entityVersion,
    expectedDate: isoOrNull(row.expectedDate),
    id: row.id,
    issueDate: row.issueDate.toISOString(),
    itemCount: counts.itemCount,
    projectName: row.projectName ?? 'Unknown project',
    purchaseOrderNumber: row.purchaseOrderNumber,
    receivedProgress: progressOf(counts.received, counts.ordered),
    source: { href: `/purchase-orders/${row.id}`, type: 'purchaseOrder' },
    stage: stage.stage,
    stageLabel: stage.label,
    stageSignal: { label: stage.label, tone: stage.tone },
    status: row.status,
    statusLabel: statusLabel(row.status) ?? row.status,
    totalAmount: caps.canReadProcurementCosts ? moneyNumber(row.totalAmount, row.currency) : null,
    totalLabel: caps.canReadProcurementCosts ? moneyLabel(row.totalAmount, row.currency) : null,
    updatedAt: row.updatedAt.toISOString(),
    vendorName: row.vendorName ?? 'Unknown vendor',
  };
}

/** `PurchaseOrderDetail` wire object (summary + items + change control). */
function projectPurchaseOrderDetail(
  row: PurchaseOrderRow,
  counts: PurchaseOrderCounts,
  caps: ReturnType<typeof purchaseOrderCapabilities>,
  items: Parameters<typeof projectLineItem>[0][],
): Record<string, unknown> {
  return {
    ...projectPurchaseOrderSummary(row, counts, caps),
    changeControl: projectChangeControl(row, caps),
    items: items.map((item) => projectLineItem(item, caps.canReadProcurementCosts, row.currency)),
  };
}

/** Loads one purchase order with project and vendor names, tenant-scoped. */
async function loadPurchaseOrder(scoped: Db, id: string): Promise<PurchaseOrderRow | null> {
  const rows = await scoped.db
    .select({
      id: purchaseOrders.id,
      purchaseOrderNumber: purchaseOrders.purchaseOrderNumber,
      projectId: purchaseOrders.projectId,
      vendorId: purchaseOrders.vendorId,
      status: purchaseOrders.status,
      currency: purchaseOrders.currency,
      issueDate: purchaseOrders.issueDate,
      expectedDate: purchaseOrders.expectedDate,
      notes: purchaseOrders.notes,
      totalAmount: purchaseOrders.totalAmount,
      isAmended: purchaseOrders.isAmended,
      confirmedExpectedDate: purchaseOrders.confirmedExpectedDate,
      confirmedTotal: purchaseOrders.confirmedTotal,
      cancellationReason: purchaseOrders.cancellationReason,
      changeControlNotes: purchaseOrders.changeControlNotes,
      entityVersion: purchaseOrders.entityVersion,
      updatedAt: purchaseOrders.updatedAt,
      projectName: projects.name,
      vendorName: vendors.name,
    })
    .from(purchaseOrders)
    .leftJoin(projects, and(eq(projects.id, purchaseOrders.projectId)))
    .leftJoin(vendors, and(eq(vendors.id, purchaseOrders.vendorId)))
    .where(eq(purchaseOrders.id, id))
    .limit(1);
  return rows[0] ?? null;
}

/** Item-count and received/ordered sums for one set of purchase orders. */
async function purchaseOrderCounts(
  scoped: Db,
  ids: string[],
): Promise<Map<string, PurchaseOrderCounts>> {
  if (ids.length === 0) {
    return new Map();
  }
  const idList = sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const rows = await scoped.db
    .select({
      purchaseOrderId: purchaseOrderItems.purchaseOrderId,
      itemCount: sql<number>`count(*)::int`,
      ordered: sql<string>`coalesce(sum(${purchaseOrderItems.quantity}), '0')`,
      received: sql<string>`coalesce(sum(${purchaseOrderItems.receivedQuantity}), '0')`,
    })
    .from(purchaseOrderItems)
    .where(sql`${purchaseOrderItems.purchaseOrderId} in (${idList})`)
    .groupBy(purchaseOrderItems.purchaseOrderId);
  const counts = new Map<string, PurchaseOrderCounts>();
  for (const row of rows) {
    counts.set(row.purchaseOrderId, {
      itemCount: row.itemCount,
      ordered: parseScaled(row.ordered, QUANTITY_SCALE),
      received: parseScaled(row.received, QUANTITY_SCALE),
    });
  }
  return counts;
}

/** All line items of one purchase order, tenant-scoped. */
async function loadPurchaseOrderItems(scoped: Db, purchaseOrderId: string) {
  return scoped.db
    .select({
      id: purchaseOrderItems.id,
      description: purchaseOrderItems.description,
      quantity: purchaseOrderItems.quantity,
      receivedQuantity: purchaseOrderItems.receivedQuantity,
      unitCost: purchaseOrderItems.unitCost,
      lineTotal: purchaseOrderItems.lineTotal,
      receivingState: purchaseOrderItems.receivingState,
      expectedShipDate: purchaseOrderItems.expectedShipDate,
      specItemId: purchaseOrderItems.specItemId,
    })
    .from(purchaseOrderItems)
    .where(eq(purchaseOrderItems.purchaseOrderId, purchaseOrderId))
    .orderBy(sql`${purchaseOrderItems.createdAt} asc`);
}

/** The register 404 problem for a missing purchase order. */
function purchaseOrderNotFound(
  c: Parameters<typeof problem>[0],
  requestId: string,
): ReturnType<typeof problem> {
  return problem(c, {
    status: 404,
    code: 'PURCHASE_ORDER_NOT_FOUND',
    title: 'Purchase order not found',
    detail: 'The purchase order does not exist in this studio.',
    requestId,
  });
}

export function registerPurchaseOrderRoutes(app: Hono<ServerEnv>, pool: Pool): void {
  // GET /purchase-orders — the register (SOL-163 slice 2).
  app.get('/purchase-orders', async (c) => {
    const user = c.get('user');
    const page = Math.max(1, Number(c.req.query('page')) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(c.req.query('pageSize')) || 10));
    const search = c.req.query('q')?.trim() || null;
    const build = requestBuildOf(c);

    const result = await withStudioTx(pool, user, async (scoped) => {
      const conditions = [];
      if (search !== null && search !== '') {
        conditions.push(
          sql`(${purchaseOrders.purchaseOrderNumber} ilike ${`%${search}%`} or ${vendors.name} ilike ${`%${search}%`} or ${projects.name} ilike ${`%${search}%`})`,
        );
      }
      const filter = conditions.length > 0 ? and(...conditions) : sql`true`;

      const totalRows = await scoped.db
        .select({ value: sql<number>`count(*)::int` })
        .from(purchaseOrders)
        .leftJoin(projects, and(eq(projects.id, purchaseOrders.projectId)))
        .leftJoin(vendors, and(eq(vendors.id, purchaseOrders.vendorId)))
        .where(filter);
      const totalItems = Number(totalRows[0]?.value ?? 0);
      const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));

      const rows = await scoped.db
        .select({
          id: purchaseOrders.id,
          purchaseOrderNumber: purchaseOrders.purchaseOrderNumber,
          projectId: purchaseOrders.projectId,
          vendorId: purchaseOrders.vendorId,
          status: purchaseOrders.status,
          currency: purchaseOrders.currency,
          issueDate: purchaseOrders.issueDate,
          expectedDate: purchaseOrders.expectedDate,
          notes: purchaseOrders.notes,
          totalAmount: purchaseOrders.totalAmount,
          isAmended: purchaseOrders.isAmended,
          confirmedExpectedDate: purchaseOrders.confirmedExpectedDate,
          confirmedTotal: purchaseOrders.confirmedTotal,
          cancellationReason: purchaseOrders.cancellationReason,
          changeControlNotes: purchaseOrders.changeControlNotes,
          entityVersion: purchaseOrders.entityVersion,
          updatedAt: purchaseOrders.updatedAt,
          projectName: projects.name,
          vendorName: vendors.name,
        })
        .from(purchaseOrders)
        .leftJoin(projects, and(eq(projects.id, purchaseOrders.projectId)))
        .leftJoin(vendors, and(eq(vendors.id, purchaseOrders.vendorId)))
        .where(filter)
        .orderBy(sql`${purchaseOrders.updatedAt} desc, ${purchaseOrders.id} desc`)
        .limit(pageSize)
        .offset((page - 1) * pageSize);

      const counts = await purchaseOrderCounts(
        scoped,
        rows.map((row) => row.id),
      );
      const caps = purchaseOrderCapabilities(user.role);

      return {
        purchaseOrders: rows.map((row) =>
          projectPurchaseOrderSummary(
            row,
            counts.get(row.id) ?? { itemCount: 0, ordered: 0n, received: 0n },
            caps,
          ),
        ),
        pagination: { page, pageSize, totalItems, totalPages },
      };
    });

    return jsonResponse({
      data: { purchaseOrders: result.purchaseOrders },
      meta: meta(c.get('requestId'), { requestBuild: build, pagination: result.pagination }),
    });
  });

  // GET /purchase-orders/{id} — detail with the weak ETag.
  app.get('/purchase-orders/:id', async (c) => {
    const user = c.get('user');
    const id = c.req.param('id');
    const build = requestBuildOf(c);

    const result = await withStudioTx(pool, user, async (scoped) => {
      const row = await loadPurchaseOrder(scoped, id);
      if (!row) {
        return { status: 404 as const };
      }
      const [countsMap, items] = await Promise.all([
        purchaseOrderCounts(scoped, [row.id]),
        loadPurchaseOrderItems(scoped, row.id),
      ]);
      const counts = countsMap.get(row.id) ?? { itemCount: 0, ordered: 0n, received: 0n };
      return {
        status: 200 as const,
        purchaseOrder: projectPurchaseOrderDetail(
          row,
          counts,
          purchaseOrderCapabilities(user.role),
          items,
        ),
        entityVersion: row.entityVersion,
      };
    });

    if (result.status === 404) {
      return purchaseOrderNotFound(c, c.get('requestId'));
    }
    return jsonResponse(
      {
        data: { purchaseOrder: result.purchaseOrder },
        meta: meta(c.get('requestId'), { requestBuild: build }),
      },
      { headers: { ETag: etagFor(result.entityVersion) } },
    );
  });
}
