/**
 * Register write routes (SOL-19 revision 6, section 6 "Register writes").
 *
 * Contract surface: guarded `POST` + `PATCH` on `/clients`, `/vendors`,
 * `/spec-items`, `/quotations` and `/invoices`. Every write:
 *
 * - requires `Idempotency-Key` (replay returns 200 with
 *   `meta.idempotentReplay: true`);
 * - `PATCH` additionally requires `If-Match` and returns the typed
 *   `409 ENTITY_VERSION_CONFLICT` with `details.draftPreserved: true` on a
 *   stale version;
 * - resolves every supplied relation inside the authenticated studio and one
 *   transaction (SOL-69 condition 3): a cross-studio identifier is a normal
 *   404 and creates no row or link;
 * - keeps same-studio ancestry (SOL-69 condition 4): a quotation requires
 *   `engagement.project_id == project.id` and `project.client_id ==
 *   client.id`; an invoice requires `project.client_id == client.id`.
 *
 * The write responses project the full contract detail shapes
 * (`ClientDetail`, `VendorDetail`, `SpecItemDetail`, `QuotationDetail`,
 * `InvoiceDetail`), so the register reads can reuse the same projections.
 */

import { MoneyInputError, moneyOutput, parseStrictMoneyInput } from '@stdio/core';
import { schema } from '@stdio/db';
import { and, count, eq } from 'drizzle-orm';
import type { Hono } from 'hono';
import type { Pool } from 'pg';

import type { ServerEnv } from '../app';
import { type Capability, projectCapabilities } from '../capabilities';
import type { Db } from '../context/db';
import { fingerprintFor, guardedWrite, parseIfMatch, requireIdempotencyKey } from '../guards';
import { etagFor, meta, problem } from '../http';
import { moneyNumber } from '../money';
import { dateLabel, moneyLabel, sortKey, statusLabel } from '../projections';

const {
  clients,
  vendors,
  specItems,
  quotations,
  quotationItems,
  invoices,
  invoicePayments,
  invoiceReceivableComponents,
  users,
  projects,
  projectEngagements,
} = schema;

/** One typed 409 body (contract `EntityVersionConflictProblem`). */
function versionConflictBody(
  requestId: string,
  detail: string,
  currentEntityVersion: string,
): Record<string, unknown> {
  return {
    type: 'urn:stdio:error',
    title: 'Entity version conflict',
    status: 409,
    code: 'ENTITY_VERSION_CONFLICT',
    detail,
    requestId,
    details: { draftPreserved: true, currentEntityVersion },
  };
}

const readCapability = (_role: Parameters<typeof projectCapabilities>[0]): Capability => ({
  enabled: true,
  reason: '',
});

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

type ClientRow = {
  id: string;
  clientNumber: string;
  name: string;
  clientType: string;
  companyName: string | null;
  location: string | null;
  leadSource: string | null;
  status: string;
  accountManagerId: string | null;
  primaryContactName: string | null;
  primaryContactEmail: string | null;
  primaryContactPhone: string | null;
  lastContactedAt: Date | null;
  entityVersion: string;
  updatedAt: Date;
  managerName?: string | null;
};

async function loadClient(
  scoped: Db,
  id: string,
): Promise<{
  row: ClientRow;
  counts: { invoices: number; projects: number; quotations: number };
} | null> {
  const rows = await scoped.db
    .select({
      id: clients.id,
      clientNumber: clients.clientNumber,
      name: clients.name,
      clientType: clients.clientType,
      companyName: clients.companyName,
      location: clients.location,
      leadSource: clients.leadSource,
      status: clients.status,
      accountManagerId: clients.accountManagerId,
      primaryContactName: clients.primaryContactName,
      primaryContactEmail: clients.primaryContactEmail,
      primaryContactPhone: clients.primaryContactPhone,
      lastContactedAt: clients.lastContactedAt,
      entityVersion: clients.entityVersion,
      updatedAt: clients.updatedAt,
      managerName: users.name,
    })
    .from(clients)
    .leftJoin(users, and(eq(users.id, clients.accountManagerId)))
    .where(eq(clients.id, id))
    .limit(1);
  const row = rows[0];
  if (!row) {
    return null;
  }
  const [invoiceCount, projectCount, quotationCount] = await Promise.all([
    scoped.db.select({ value: count() }).from(invoices).where(eq(invoices.clientId, id)),
    scoped.db.select({ value: count() }).from(projects).where(eq(projects.clientId, id)),
    scoped.db.select({ value: count() }).from(quotations).where(eq(quotations.clientId, id)),
  ]);
  return {
    row,
    counts: {
      invoices: Number(invoiceCount[0]?.value ?? 0),
      projects: Number(projectCount[0]?.value ?? 0),
      quotations: Number(quotationCount[0]?.value ?? 0),
    },
  };
}

function projectClient(
  row: ClientRow,
  counts: { invoices: number; projects: number; quotations: number },
  role: Parameters<typeof projectCapabilities>[0],
): Record<string, unknown> {
  const status = row.status;
  return {
    accountManager: row.accountManagerId
      ? { id: row.accountManagerId, name: row.managerName ?? 'Unknown user' }
      : null,
    capabilities: { read: readCapability(role) },
    clientNumber: row.clientNumber,
    clientTypeLabel: statusLabel(row.clientType) ?? row.clientType,
    companyName: row.companyName,
    counts: {
      contacts: 0,
      invoices: counts.invoices,
      projects: counts.projects,
      quotations: counts.quotations,
    },
    entityVersion: row.entityVersion,
    health:
      status === 'ACTIVE'
        ? { label: 'Active', tone: 'success' }
        : { label: statusLabel(status) ?? status, tone: 'neutral' },
    id: row.id,
    lastContactedAt: row.lastContactedAt ? row.lastContactedAt.toISOString() : null,
    leadSourceLabel: row.leadSource,
    location: row.location,
    name: row.name,
    primaryContact:
      row.primaryContactName || row.primaryContactEmail || row.primaryContactPhone
        ? {
            name: row.primaryContactName ?? '',
            email: row.primaryContactEmail,
            phone: row.primaryContactPhone,
          }
        : null,
    source: { href: `/clients/${row.id}`, type: 'client' },
    status,
    statusLabel: statusLabel(status) ?? status,
    tags: [],
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Vendors
// ---------------------------------------------------------------------------

type VendorRow = {
  id: string;
  vendorCode: string;
  name: string;
  email: string | null;
  phone: string | null;
  website: string | null;
  category: string | null;
  paymentTerms: string | null;
  preferred: boolean;
  blocked: boolean;
  blockedReason: string | null;
  status: string;
  entityVersion: string;
  updatedAt: Date;
};

async function loadVendor(scoped: Db, id: string): Promise<VendorRow | null> {
  const rows = await scoped.db
    .select({
      id: vendors.id,
      vendorCode: vendors.vendorCode,
      name: vendors.name,
      email: vendors.email,
      phone: vendors.phone,
      website: vendors.website,
      category: vendors.category,
      paymentTerms: vendors.paymentTerms,
      preferred: vendors.preferred,
      blocked: vendors.blocked,
      blockedReason: vendors.blockedReason,
      status: vendors.status,
      entityVersion: vendors.entityVersion,
      updatedAt: vendors.updatedAt,
    })
    .from(vendors)
    .where(eq(vendors.id, id))
    .limit(1);
  return rows[0] ?? null;
}

function projectVendor(
  row: VendorRow,
  purchaseOrderCount: number,
  role: Parameters<typeof projectCapabilities>[0],
): Record<string, unknown> {
  return {
    apOutstandingLabel: null,
    blocked: row.blocked,
    blockedReason: row.blockedReason,
    capabilities: { read: readCapability(role) },
    categoryLabel: row.category,
    counts: {
      contacts: 0,
      products: 0,
      purchaseOrders: purchaseOrderCount,
      specItems: 0,
      vendorBills: 0,
    },
    email: row.email,
    entityVersion: row.entityVersion,
    health: row.blocked
      ? { label: 'Blocked', tone: 'danger' }
      : row.status === 'ACTIVE'
        ? { label: 'Active', tone: 'success' }
        : { label: statusLabel(row.status) ?? row.status, tone: 'neutral' },
    id: row.id,
    name: row.name,
    openBillsCount: 0,
    paymentTerms: row.paymentTerms,
    phone: row.phone,
    preferred: row.preferred,
    source: { href: `/vendors/${row.id}`, type: 'vendor' },
    statusLabel: statusLabel(row.status) ?? row.status,
    updatedAt: row.updatedAt.toISOString(),
    vendorCode: row.vendorCode,
    website: row.website,
  };
}

// ---------------------------------------------------------------------------
// Spec items
// ---------------------------------------------------------------------------

type SpecItemRow = {
  id: string;
  projectId: string;
  name: string;
  room: string | null;
  quantityLabel: string | null;
  brand: string | null;
  category: string | null;
  entityVersion: string;
  updatedAt: Date;
  projectName?: string | null;
};

async function loadSpecItem(scoped: Db, id: string): Promise<SpecItemRow | null> {
  const rows = await scoped.db
    .select({
      id: specItems.id,
      projectId: specItems.projectId,
      name: specItems.name,
      room: specItems.room,
      quantityLabel: specItems.quantityLabel,
      brand: specItems.brand,
      category: specItems.category,
      entityVersion: specItems.entityVersion,
      updatedAt: specItems.updatedAt,
      projectName: projects.name,
    })
    .from(specItems)
    .leftJoin(projects, and(eq(projects.id, specItems.projectId)))
    .where(eq(specItems.id, id))
    .limit(1);
  return rows[0] ?? null;
}

function projectSpecItem(
  row: SpecItemRow,
  canReadFinance: boolean,
  role: Parameters<typeof projectCapabilities>[0],
): Record<string, unknown> {
  const stage = 'drafting';
  return {
    alternatesCount: 0,
    brand: row.brand,
    capabilities: { read: readCapability(role) },
    canReadFinance,
    category: row.category,
    clientDecisionLabel: null,
    entityVersion: row.entityVersion,
    hasImage: false,
    id: row.id,
    isPublishedToClient: false,
    leadTimeLabel: null,
    materialLine: null,
    name: row.name,
    projectId: row.projectId,
    projectName: row.projectName ?? 'Unknown project',
    quantityLabel: row.quantityLabel,
    room: row.room,
    source: { href: `/spec-items/${row.id}`, type: 'spec-item' },
    stage,
    stageLabel: statusLabel(stage) ?? stage,
    stageSignal: { label: 'Draft', tone: 'neutral' },
    status: 'DRAFT',
    statusLabel: 'Draft',
    unitCost: null,
    unitCostLabel: null,
    updatedAt: row.updatedAt.toISOString(),
    vendorName: null,
  };
}

// ---------------------------------------------------------------------------
// Quotations (register projection; the detail = summary shape)
// ---------------------------------------------------------------------------

type QuotationRegisterRow = {
  id: string;
  quotationNumber: string;
  title: string;
  clientId: string;
  projectId: string | null;
  engagementId: string | null;
  version: string;
  status: string;
  quotationType: string | null;
  currency: string | null;
  totalAmount: string | null;
  validUntil: Date | null;
  quotationDate: Date | null;
  entityVersion: string;
  updatedAt: Date;
  createdAt: Date;
  clientName?: string | null;
  projectName?: string | null;
};

async function loadQuotationRegister(
  scoped: Db,
  id: string,
): Promise<{ row: QuotationRegisterRow; itemCount: number } | null> {
  const rows = await scoped.db
    .select({
      id: quotations.id,
      quotationNumber: quotations.quotationNumber,
      title: quotations.title,
      clientId: quotations.clientId,
      projectId: quotations.projectId,
      engagementId: quotations.engagementId,
      version: quotations.version,
      status: quotations.status,
      quotationType: quotations.quotationType,
      currency: quotations.currency,
      totalAmount: quotations.totalAmount,
      validUntil: quotations.validUntil,
      quotationDate: quotations.quotationDate,
      entityVersion: quotations.entityVersion,
      updatedAt: quotations.updatedAt,
      createdAt: quotations.createdAt,
      clientName: clients.name,
      projectName: projects.name,
    })
    .from(quotations)
    .leftJoin(clients, and(eq(clients.id, quotations.clientId)))
    .leftJoin(projects, and(eq(projects.id, quotations.projectId)))
    .where(eq(quotations.id, id))
    .limit(1);
  const row = rows[0];
  if (!row) {
    return null;
  }
  const itemRows = await scoped.db
    .select({ value: count() })
    .from(quotationItems)
    .where(eq(quotationItems.quotationId, id));
  return { row, itemCount: Number(itemRows[0]?.value ?? 0) };
}

function projectQuotationRegister(
  row: QuotationRegisterRow,
  itemCount: number,
  canReadFinance: boolean,
  role: Parameters<typeof projectCapabilities>[0],
): Record<string, unknown> {
  const currency = row.currency ?? 'IDR';
  const total = canReadFinance ? moneyNumber(row.totalAmount, currency) : null;
  const status = row.status;
  return {
    capabilities: { read: readCapability(role) },
    canReadFinance,
    client: { id: row.clientId, name: row.clientName ?? 'Unknown client' },
    counts: { approvals: 0, files: 0, items: itemCount },
    engagementId: row.engagementId,
    entityVersion: row.entityVersion,
    health: { label: statusLabel(status) ?? status, tone: 'neutral' },
    id: row.id,
    projectName: row.projectName,
    projectId: row.projectId,
    quotationDateLabel: row.quotationDate ? dateLabel(row.quotationDate) : null,
    quotationNumber: row.quotationNumber,
    quotationTypeLabel: row.quotationType
      ? (statusLabel(row.quotationType) ?? row.quotationType)
      : null,
    source: { href: `/quotations/${row.id}`, type: 'quotation' },
    status,
    statusLabel: statusLabel(status) ?? status,
    sortKey: sortKey(row.updatedAt, row.createdAt, row.id),
    title: row.title,
    totalAmount: total,
    totalAmountLabel: canReadFinance ? moneyLabel(row.totalAmount, currency) : null,
    updatedAt: row.updatedAt.toISOString(),
    validUntilLabel: row.validUntil ? dateLabel(row.validUntil) : null,
    version: Number(row.version),
  };
}

// ---------------------------------------------------------------------------
// Invoices (register projection; detail = summary + payments)
// ---------------------------------------------------------------------------

type InvoiceRegisterRow = {
  id: string;
  invoiceNumber: string;
  displayNumber: string | null;
  clientId: string;
  projectId: string | null;
  status: string;
  currency: string | null;
  totalAmount: string | null;
  issueDate: Date | null;
  dueDate: Date | null;
  issuedAt: Date | null;
  entityVersion: string;
  updatedAt: Date;
  clientName?: string | null;
  projectName?: string | null;
};

/**
 * SOL-129: parses one contract `MoneyInput` for the invoice draft-total
 * writes. Throws `MoneyInputError`; callers map it to the 422 Problem.
 */
function parseDraftTotal(raw: unknown): bigint {
  return parseStrictMoneyInput(raw as string | number);
}

/** One validated receivable-component input (SOL-129). */
type ParsedComponent = { kind: string; amountMinor: bigint };

/**
 * Validates and parses the `receivableComponents` request array. Returns
 * null when the shape is not a valid component list. An empty array is a
 * valid "clear the components" instruction.
 */
function parseDraftComponents(
  raw: unknown,
): { ok: true; components: ParsedComponent[] } | { ok: false } {
  if (!Array.isArray(raw)) {
    return { ok: false };
  }
  const components: ParsedComponent[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return { ok: false };
    }
    const record = entry as Record<string, unknown>;
    const kind = record.kind;
    const amount = record.amount;
    if (
      typeof kind !== 'string' ||
      !['DEPOSIT', 'RETENTION', 'BALANCE'].includes(kind) ||
      (typeof amount !== 'string' && typeof amount !== 'number')
    ) {
      return { ok: false };
    }
    try {
      components.push({ kind, amountMinor: parseDraftTotal(amount) });
    } catch {
      throw new MoneyInputError(
        'MONEY_FORMAT_INVALID',
        `Receivable component amount is not valid money input.`,
      );
    }
  }
  return { ok: true, components };
}

async function loadInvoiceRegister(
  scoped: Db,
  id: string,
): Promise<{
  row: InvoiceRegisterRow;
  paymentCount: number;
  components: { kind: string; amount: string; settledAmount: string }[];
  paidAmount: string | null;
} | null> {
  const rows = await scoped.db
    .select({
      id: invoices.id,
      invoiceNumber: invoices.invoiceNumber,
      displayNumber: invoices.displayNumber,
      clientId: invoices.clientId,
      projectId: invoices.projectId,
      status: invoices.status,
      currency: invoices.currency,
      totalAmount: invoices.totalAmount,
      issueDate: invoices.issueDate,
      dueDate: invoices.dueDate,
      issuedAt: invoices.issuedAt,
      entityVersion: invoices.entityVersion,
      updatedAt: invoices.updatedAt,
      clientName: clients.name,
      projectName: projects.name,
    })
    .from(invoices)
    .leftJoin(clients, and(eq(clients.id, invoices.clientId)))
    .leftJoin(projects, and(eq(projects.id, invoices.projectId)))
    .where(eq(invoices.id, id))
    .limit(1);
  const row = rows[0];
  if (!row) {
    return null;
  }
  const [paymentRows, componentRows] = await Promise.all([
    scoped.db
      .select({ value: count() })
      .from(invoicePayments)
      .where(eq(invoicePayments.invoiceId, id)),
    scoped.db
      .select({
        kind: invoiceReceivableComponents.kind,
        amount: invoiceReceivableComponents.amount,
        settledAmount: invoiceReceivableComponents.settledAmount,
      })
      .from(invoiceReceivableComponents)
      .where(eq(invoiceReceivableComponents.invoiceId, id))
      .orderBy(invoiceReceivableComponents.kind),
  ]);
  return {
    row,
    paymentCount: Number(paymentRows[0]?.value ?? 0),
    components: componentRows,
    paidAmount: null,
  };
}

function projectInvoiceRegister(
  row: InvoiceRegisterRow,
  paymentCount: number,
  canReadFinance: boolean,
  role: Parameters<typeof projectCapabilities>[0],
  components: { kind: string; amount: string; settledAmount: string }[] = [],
): Record<string, unknown> {
  const currency = row.currency ?? 'IDR';
  const status = row.status;
  return {
    capabilities: { read: readCapability(role) },
    client: { id: row.clientId, name: row.clientName ?? 'Unknown client' },
    counts: { items: 0, payments: paymentCount },
    dueDate: row.dueDate ? row.dueDate.toISOString() : null,
    dueDateLabel: row.dueDate ? dateLabel(row.dueDate) : null,
    displayNumber: row.displayNumber,
    entityVersion: row.entityVersion,
    health:
      status === 'DRAFT'
        ? { label: 'Draft', tone: 'neutral' }
        : status === 'ISSUED'
          ? { label: 'Issued', tone: 'info' }
          : { label: statusLabel(status) ?? status, tone: 'neutral' },
    id: row.id,
    invoiceNumber: row.invoiceNumber,
    isOverdue: false,
    issueDateLabel: row.issueDate ? dateLabel(row.issueDate) : null,
    issuedAt: row.issuedAt ? row.issuedAt.toISOString() : null,
    outstandingAmountLabel: canReadFinance ? moneyLabel(row.totalAmount, currency) : '',
    paidAmountLabel: canReadFinance ? moneyLabel(null, currency) : '',
    receivableComponents: components.map((component) => ({
      kind: component.kind,
      amountLabel: canReadFinance ? moneyLabel(component.amount, currency) : '',
      settledAmountLabel: canReadFinance ? moneyLabel(component.settledAmount, currency) : '',
      outstandingAmountLabel: canReadFinance
        ? moneyLabel(subtractDecimal(component.amount, component.settledAmount), currency)
        : '',
    })),
    projectName: row.projectName,
    source: { href: `/invoices/${row.id}`, type: 'invoice' },
    status,
    statusLabel: statusLabel(status) ?? status,
    totalAmountLabel: canReadFinance ? moneyLabel(row.totalAmount, currency) : '',
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Guarded-write plumbing shared by the five registers
// ---------------------------------------------------------------------------

async function parseBody(
  c: Parameters<typeof requireIdempotencyKey>[0],
): Promise<
  { ok: true; body: Record<string, unknown>; raw: string } | { ok: false; response: Response }
> {
  const raw = await c.req.text();
  try {
    return { ok: true, body: JSON.parse(raw) as Record<string, unknown>, raw };
  } catch {
    return {
      ok: false,
      response: problem(c, {
        status: 400,
        code: 'INVALID_JSON',
        title: 'Invalid JSON body',
        detail: 'The request body is not valid JSON.',
        requestId: c.get('requestId'),
      }),
    };
  }
}

/** Runs the shared guarded-write shell for a register write. */
async function guardedRegisterWrite(
  c: Parameters<typeof requireIdempotencyKey>[0],
  pool: Pool,
  method: string,
  handler: Parameters<typeof guardedWrite>[4],
): Promise<Response> {
  const user = c.get('user');
  const key = requireIdempotencyKey(c);
  if (typeof key !== 'string') {
    return key;
  }
  const raw = await c.req.text();
  const fingerprint = fingerprintFor(method, c.req.path, c.req.header('Content-Type') ?? null, raw);
  const result = await guardedWrite(pool, user, key, fingerprint, handler, {
    requestId: c.get('requestId'),
    method,
    path: c.req.path,
    flipReplayIdempotent: true,
    replayStatus: 200,
  });
  if (result.outcome === 'conflict') {
    return problem(c, {
      status: 409,
      code: 'IDEMPOTENCY_KEY_REUSED',
      title: 'Idempotency key reused',
      detail:
        'This Idempotency-Key was used for a different request. A key is bound to one request body.',
      requestId: c.get('requestId'),
    });
  }
  return new Response(result.bodyText, {
    status: result.status,
    headers: {
      'content-type': 'application/json',
      ...(result.etag ? { ETag: etagFor(result.etag) } : {}),
    },
  });
}

const mutationMeta = (requestId: string) => ({ ...meta(requestId), idempotentReplay: false });

export function registerRegisterRoutes(app: Hono<ServerEnv>, pool: Pool): void {
  // --- Clients -----------------------------------------------------------
  app.post('/clients', async (c) => {
    const user = c.get('user');
    const capability = projectCapabilities(user.role).canWriteClient;
    if (!capability.enabled) {
      return problem(c, {
        status: 403,
        code: 'CAPABILITY_DENIED',
        title: 'Capability disabled',
        detail: capability.reason,
        requestId: c.get('requestId'),
      });
    }
    const parsed = await parseBody(c);
    if (!parsed.ok) {
      return parsed.response;
    }
    const req = parsed.body;
    const clientNumber = req.clientNumber as string | undefined;
    const name = req.name as string | undefined;
    if (typeof clientNumber !== 'string' || typeof name !== 'string') {
      return problem(c, {
        status: 422,
        code: 'INVALID_CLIENT',
        title: 'Invalid client',
        detail: 'clientNumber and name are required.',
        requestId: c.get('requestId'),
      });
    }
    return guardedRegisterWrite(c, pool, 'POST', async (scoped) => {
      const accountManagerId = req.accountManagerId as string | null | undefined;
      if (accountManagerId) {
        const manager = await scoped.db
          .select({ id: users.id })
          .from(users)
          .where(eq(users.id, accountManagerId))
          .limit(1);
        if (!manager[0]) {
          return { status: 404, body: { code: 'USER_NOT_FOUND' } };
        }
      }
      const inserted = await scoped.db
        .insert(clients)
        .values({
          studioId: scoped.studioId,
          clientNumber,
          name,
          clientType: (req.type as string | undefined) ?? 'COMPANY',
          companyName:
            req.companyName === null ? null : ((req.companyName as string | undefined) ?? null),
          location: req.location === null ? null : ((req.location as string | undefined) ?? null),
          leadSource:
            req.leadSourceLabel === null
              ? null
              : ((req.leadSourceLabel as string | undefined) ?? null),
          primaryContactName: name,
          primaryContactEmail:
            req.email === null ? null : ((req.email as string | undefined) ?? null),
          primaryContactPhone:
            req.phone === null ? null : ((req.phone as string | undefined) ?? null),
          accountManagerId: accountManagerId ?? null,
          entityVersion: crypto.randomUUID(),
        })
        .returning({ id: clients.id });
      const created = inserted[0];
      if (!created) {
        return { status: 500, body: { code: 'WRITE_FAILED' } };
      }
      const loaded = await loadClient(scoped, created.id);
      if (!loaded) {
        return { status: 500, body: { code: 'WRITE_FAILED' } };
      }
      return {
        status: 201,
        etag: loaded.row.entityVersion,
        body: {
          data: { client: projectClient(loaded.row, loaded.counts, user.role) },
          meta: mutationMeta(c.get('requestId')),
        },
      };
    });
  });

  app.patch('/clients/:id', async (c) => {
    const user = c.get('user');
    const capability = projectCapabilities(user.role).canWriteClient;
    if (!capability.enabled) {
      return problem(c, {
        status: 403,
        code: 'CAPABILITY_DENIED',
        title: 'Capability disabled',
        detail: capability.reason,
        requestId: c.get('requestId'),
      });
    }
    const id = c.req.param('id');
    const ifMatch = parseIfMatch(c.req.header('If-Match'));
    if (!ifMatch || ifMatch.length < 1) {
      return problem(c, {
        status: 400,
        code: 'MISSING_IF_MATCH',
        title: 'Entity version required',
        detail: 'The update requires If-Match with the client entity version.',
        requestId: c.get('requestId'),
      });
    }
    const [version] = ifMatch;
    const parsed = await parseBody(c);
    if (!parsed.ok) {
      return parsed.response;
    }
    const req = parsed.body;
    return guardedRegisterWrite(c, pool, 'PATCH', async (scoped) => {
      const current = await scoped.db
        .select({ id: clients.id, entityVersion: clients.entityVersion })
        .from(clients)
        .where(eq(clients.id, id))
        .for('update')
        .limit(1);
      const row = current[0];
      if (!row) {
        return { status: 404, body: { code: 'CLIENT_NOT_FOUND' } };
      }
      if (row.entityVersion !== version) {
        return {
          status: 409,
          body: versionConflictBody(
            c.get('requestId'),
            'The If-Match entity version does not match the current entity. Refetch and retry.',
            row.entityVersion,
          ),
        };
      }
      const accountManagerId = req.accountManagerId as string | null | undefined;
      if (accountManagerId) {
        const manager = await scoped.db
          .select({ id: users.id })
          .from(users)
          .where(eq(users.id, accountManagerId))
          .limit(1);
        if (!manager[0]) {
          return { status: 404, body: { code: 'USER_NOT_FOUND' } };
        }
      }
      const values: Record<string, unknown> = { entityVersion: crypto.randomUUID() };
      if (req.clientNumber !== undefined) values.clientNumber = req.clientNumber;
      if (req.name !== undefined) values.name = req.name;
      if (req.type !== undefined) values.clientType = req.type;
      if ('companyName' in req)
        values.companyName =
          req.companyName === null ? null : ((req.companyName as string | undefined) ?? null);
      if ('location' in req)
        values.location =
          req.location === null ? null : ((req.location as string | undefined) ?? null);
      if ('leadSourceLabel' in req)
        values.leadSource =
          req.leadSourceLabel === null
            ? null
            : ((req.leadSourceLabel as string | undefined) ?? null);
      if ('email' in req)
        values.primaryContactEmail =
          req.email === null ? null : ((req.email as string | undefined) ?? null);
      if ('phone' in req)
        values.primaryContactPhone =
          req.phone === null ? null : ((req.phone as string | undefined) ?? null);
      if (accountManagerId !== undefined) values.accountManagerId = accountManagerId;
      await scoped.db.update(clients).set(values).where(eq(clients.id, id));
      const loaded = await loadClient(scoped, id);
      if (!loaded) {
        return { status: 500, body: { code: 'WRITE_FAILED' } };
      }
      return {
        status: 200,
        etag: loaded.row.entityVersion,
        body: {
          data: { client: projectClient(loaded.row, loaded.counts, user.role) },
          meta: mutationMeta(c.get('requestId')),
        },
      };
    });
  });

  // --- Vendors -----------------------------------------------------------
  app.post('/vendors', async (c) => {
    const user = c.get('user');
    const capability = projectCapabilities(user.role).canWriteVendor;
    if (!capability.enabled) {
      return problem(c, {
        status: 403,
        code: 'CAPABILITY_DENIED',
        title: 'Capability disabled',
        detail: capability.reason,
        requestId: c.get('requestId'),
      });
    }
    const parsed = await parseBody(c);
    if (!parsed.ok) {
      return parsed.response;
    }
    const req = parsed.body;
    const vendorNumber = req.vendorNumber as string | undefined;
    const name = req.name as string | undefined;
    if (typeof vendorNumber !== 'string' || typeof name !== 'string') {
      return problem(c, {
        status: 422,
        code: 'INVALID_VENDOR',
        title: 'Invalid vendor',
        detail: 'vendorNumber and name are required.',
        requestId: c.get('requestId'),
      });
    }
    return guardedRegisterWrite(c, pool, 'POST', async (scoped) => {
      const inserted = await scoped.db
        .insert(vendors)
        .values({
          studioId: scoped.studioId,
          vendorCode: vendorNumber,
          name,
          email: req.email === null ? null : ((req.email as string | undefined) ?? null),
          phone: req.phone === null ? null : ((req.phone as string | undefined) ?? null),
          category:
            req.categoryLabel === null ? null : ((req.categoryLabel as string | undefined) ?? null),
          entityVersion: crypto.randomUUID(),
        })
        .returning({ id: vendors.id });
      const created = inserted[0];
      if (!created) {
        return { status: 500, body: { code: 'WRITE_FAILED' } };
      }
      const row = await loadVendor(scoped, created.id);
      if (!row) {
        return { status: 500, body: { code: 'WRITE_FAILED' } };
      }
      const poCount = await scoped.db
        .select({ value: count() })
        .from(schema.purchaseOrders)
        .where(eq(schema.purchaseOrders.vendorId, created.id));
      return {
        status: 201,
        etag: row.entityVersion,
        body: {
          data: { vendor: projectVendor(row, Number(poCount[0]?.value ?? 0), user.role) },
          meta: mutationMeta(c.get('requestId')),
        },
      };
    });
  });

  app.patch('/vendors/:id', async (c) => {
    const user = c.get('user');
    const capability = projectCapabilities(user.role).canWriteVendor;
    if (!capability.enabled) {
      return problem(c, {
        status: 403,
        code: 'CAPABILITY_DENIED',
        title: 'Capability disabled',
        detail: capability.reason,
        requestId: c.get('requestId'),
      });
    }
    const id = c.req.param('id');
    const ifMatch = parseIfMatch(c.req.header('If-Match'));
    if (!ifMatch || ifMatch.length < 1) {
      return problem(c, {
        status: 400,
        code: 'MISSING_IF_MATCH',
        title: 'Entity version required',
        detail: 'The update requires If-Match with the vendor entity version.',
        requestId: c.get('requestId'),
      });
    }
    const [version] = ifMatch;
    const parsed = await parseBody(c);
    if (!parsed.ok) {
      return parsed.response;
    }
    const req = parsed.body;
    return guardedRegisterWrite(c, pool, 'PATCH', async (scoped) => {
      const current = await scoped.db
        .select({ id: vendors.id, entityVersion: vendors.entityVersion })
        .from(vendors)
        .where(eq(vendors.id, id))
        .for('update')
        .limit(1);
      const row = current[0];
      if (!row) {
        return { status: 404, body: { code: 'VENDOR_NOT_FOUND' } };
      }
      if (row.entityVersion !== version) {
        return {
          status: 409,
          body: versionConflictBody(
            c.get('requestId'),
            'The If-Match entity version does not match the current entity. Refetch and retry.',
            row.entityVersion,
          ),
        };
      }
      const values: Record<string, unknown> = { entityVersion: crypto.randomUUID() };
      if (req.vendorNumber !== undefined) values.vendorCode = req.vendorNumber;
      if (req.name !== undefined) values.name = req.name;
      if ('email' in req)
        values.email = req.email === null ? null : ((req.email as string | undefined) ?? null);
      if ('phone' in req)
        values.phone = req.phone === null ? null : ((req.phone as string | undefined) ?? null);
      if ('categoryLabel' in req)
        values.category =
          req.categoryLabel === null ? null : ((req.categoryLabel as string | undefined) ?? null);
      await scoped.db.update(vendors).set(values).where(eq(vendors.id, id));
      const updated = await loadVendor(scoped, id);
      if (!updated) {
        return { status: 500, body: { code: 'WRITE_FAILED' } };
      }
      const poCount = await scoped.db
        .select({ value: count() })
        .from(schema.purchaseOrders)
        .where(eq(schema.purchaseOrders.vendorId, id));
      return {
        status: 200,
        etag: updated.entityVersion,
        body: {
          data: { vendor: projectVendor(updated, Number(poCount[0]?.value ?? 0), user.role) },
          meta: mutationMeta(c.get('requestId')),
        },
      };
    });
  });

  // --- Spec items --------------------------------------------------------
  app.post('/spec-items', async (c) => {
    const user = c.get('user');
    const capability = projectCapabilities(user.role).canWriteSpecItem;
    if (!capability.enabled) {
      return problem(c, {
        status: 403,
        code: 'CAPABILITY_DENIED',
        title: 'Capability disabled',
        detail: capability.reason,
        requestId: c.get('requestId'),
      });
    }
    const parsed = await parseBody(c);
    if (!parsed.ok) {
      return parsed.response;
    }
    const req = parsed.body;
    const name = req.name as string | undefined;
    const projectId = req.projectId as string | undefined;
    if (typeof name !== 'string' || typeof projectId !== 'string') {
      return problem(c, {
        status: 422,
        code: 'INVALID_SPEC_ITEM',
        title: 'Invalid spec item',
        detail: 'name and projectId are required.',
        requestId: c.get('requestId'),
      });
    }
    return guardedRegisterWrite(c, pool, 'POST', async (scoped) => {
      const project = await scoped.db
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.id, projectId))
        .limit(1);
      if (!project[0]) {
        return { status: 404, body: { code: 'PROJECT_NOT_FOUND' } };
      }
      const inserted = await scoped.db
        .insert(specItems)
        .values({
          studioId: scoped.studioId,
          projectId,
          name,
          room: req.room === null ? null : ((req.room as string | undefined) ?? null),
          quantityLabel: (req.quantityLabel as string | undefined) ?? null,
          entityVersion: crypto.randomUUID(),
        })
        .returning({ id: specItems.id });
      const created = inserted[0];
      if (!created) {
        return { status: 500, body: { code: 'WRITE_FAILED' } };
      }
      const row = await loadSpecItem(scoped, created.id);
      if (!row) {
        return { status: 500, body: { code: 'WRITE_FAILED' } };
      }
      return {
        status: 201,
        etag: row.entityVersion,
        body: {
          data: {
            specItem: projectSpecItem(
              row,
              projectCapabilities(user.role).canReadFinance.enabled,
              user.role,
            ),
          },
          meta: mutationMeta(c.get('requestId')),
        },
      };
    });
  });

  app.patch('/spec-items/:id', async (c) => {
    const user = c.get('user');
    const capability = projectCapabilities(user.role).canWriteSpecItem;
    if (!capability.enabled) {
      return problem(c, {
        status: 403,
        code: 'CAPABILITY_DENIED',
        title: 'Capability disabled',
        detail: capability.reason,
        requestId: c.get('requestId'),
      });
    }
    const id = c.req.param('id');
    const ifMatch = parseIfMatch(c.req.header('If-Match'));
    if (!ifMatch || ifMatch.length < 1) {
      return problem(c, {
        status: 400,
        code: 'MISSING_IF_MATCH',
        title: 'Entity version required',
        detail: 'The update requires If-Match with the spec item entity version.',
        requestId: c.get('requestId'),
      });
    }
    const [version] = ifMatch;
    const parsed = await parseBody(c);
    if (!parsed.ok) {
      return parsed.response;
    }
    const req = parsed.body;
    return guardedRegisterWrite(c, pool, 'PATCH', async (scoped) => {
      const current = await scoped.db
        .select({ id: specItems.id, entityVersion: specItems.entityVersion })
        .from(specItems)
        .where(eq(specItems.id, id))
        .for('update')
        .limit(1);
      const row = current[0];
      if (!row) {
        return { status: 404, body: { code: 'SPEC_ITEM_NOT_FOUND' } };
      }
      if (row.entityVersion !== version) {
        return {
          status: 409,
          body: versionConflictBody(
            c.get('requestId'),
            'The If-Match entity version does not match the current entity. Refetch and retry.',
            row.entityVersion,
          ),
        };
      }
      const values: Record<string, unknown> = { entityVersion: crypto.randomUUID() };
      if (req.name !== undefined) values.name = req.name;
      if ('room' in req)
        values.room = req.room === null ? null : ((req.room as string | undefined) ?? null);
      if ('quantityLabel' in req)
        values.quantityLabel = (req.quantityLabel as string | undefined) ?? null;
      if ('brand' in req)
        values.brand = req.brand === null ? null : ((req.brand as string | undefined) ?? null);
      if ('category' in req)
        values.category =
          req.category === null ? null : ((req.category as string | undefined) ?? null);
      await scoped.db.update(specItems).set(values).where(eq(specItems.id, id));
      const updated = await loadSpecItem(scoped, id);
      if (!updated) {
        return { status: 500, body: { code: 'WRITE_FAILED' } };
      }
      return {
        status: 200,
        etag: updated.entityVersion,
        body: {
          data: {
            specItem: projectSpecItem(
              updated,
              projectCapabilities(user.role).canReadFinance.enabled,
              user.role,
            ),
          },
          meta: mutationMeta(c.get('requestId')),
        },
      };
    });
  });

  // --- Quotations (register write; D-019 ancestry) ----------------------
  app.post('/quotations', async (c) => {
    const user = c.get('user');
    const capability = projectCapabilities(user.role).canWriteQuotation;
    if (!capability.enabled) {
      return problem(c, {
        status: 403,
        code: 'CAPABILITY_DENIED',
        title: 'Capability disabled',
        detail: capability.reason,
        requestId: c.get('requestId'),
      });
    }
    const parsed = await parseBody(c);
    if (!parsed.ok) {
      return parsed.response;
    }
    const req = parsed.body;
    const clientId = req.clientId as string | undefined;
    const engagementId = req.engagementId as string | undefined;
    const projectId = req.projectId as string | undefined;
    const quotationNumber = req.quotationNumber as string | undefined;
    const title = req.title as string | undefined;
    if (
      typeof clientId !== 'string' ||
      typeof engagementId !== 'string' ||
      typeof projectId !== 'string' ||
      typeof quotationNumber !== 'string' ||
      typeof title !== 'string'
    ) {
      return problem(c, {
        status: 422,
        code: 'INVALID_QUOTATION',
        title: 'Invalid quotation',
        detail: 'clientId, engagementId, projectId, quotationNumber and title are required.',
        requestId: c.get('requestId'),
      });
    }
    return guardedRegisterWrite(c, pool, 'POST', async (scoped) => {
      // Tenant + ancestry (SOL-69 conditions 3 and 4).
      const engagement = await resolveEngagementForRegister(scoped, projectId, engagementId);
      if (!engagement) {
        return { status: 404, body: { code: 'ENGAGEMENT_NOT_FOUND' } };
      }
      const project = await scoped.db
        .select({ id: projects.id, clientId: projects.clientId })
        .from(projects)
        .where(eq(projects.id, projectId))
        .limit(1);
      const projectRow = project[0];
      if (!projectRow) {
        return { status: 404, body: { code: 'PROJECT_NOT_FOUND' } };
      }
      const client = await scoped.db
        .select({ id: clients.id })
        .from(clients)
        .where(eq(clients.id, clientId))
        .limit(1);
      if (!client[0]) {
        return { status: 404, body: { code: 'CLIENT_NOT_FOUND' } };
      }
      // D-019 / FamilyContract.swift: the engagement must belong to the
      // project and the project must belong to the client.
      if (projectRow.clientId !== clientId) {
        return {
          status: 422,
          body: {
            code: 'INVALID_QUOTATION_ANCESTRY',
            detail: 'The project does not belong to this client.',
          },
        };
      }
      const inserted = await scoped.db
        .insert(quotations)
        .values({
          studioId: scoped.studioId,
          quotationNumber,
          title,
          clientId,
          projectId,
          engagementId,
          version: '1',
          status: 'DRAFT',
          quotationType: (req.quotationType as string | undefined) ?? null,
          currency: (req.currency as string | undefined) ?? 'IDR',
          quotationDate: req.quotationDate ? new Date(req.quotationDate as string) : new Date(),
          validUntil: req.validUntil ? new Date(req.validUntil as string) : null,
          entityVersion: crypto.randomUUID(),
        })
        .returning({ id: quotations.id });
      const created = inserted[0];
      if (!created) {
        return { status: 500, body: { code: 'WRITE_FAILED' } };
      }
      const loaded = await loadQuotationRegister(scoped, created.id);
      if (!loaded) {
        return { status: 500, body: { code: 'WRITE_FAILED' } };
      }
      return {
        status: 201,
        etag: loaded.row.entityVersion,
        body: {
          data: {
            quotation: projectQuotationRegister(
              loaded.row,
              loaded.itemCount,
              projectCapabilities(user.role).canReadFinance.enabled,
              user.role,
            ),
          },
          meta: mutationMeta(c.get('requestId')),
        },
      };
    });
  });

  app.patch('/quotations/:id', async (c) => {
    const user = c.get('user');
    const capability = projectCapabilities(user.role).canWriteQuotation;
    if (!capability.enabled) {
      return problem(c, {
        status: 403,
        code: 'CAPABILITY_DENIED',
        title: 'Capability disabled',
        detail: capability.reason,
        requestId: c.get('requestId'),
      });
    }
    const id = c.req.param('id');
    const ifMatch = parseIfMatch(c.req.header('If-Match'));
    if (!ifMatch || ifMatch.length < 1) {
      return problem(c, {
        status: 400,
        code: 'MISSING_IF_MATCH',
        title: 'Entity version required',
        detail: 'The update requires If-Match with the quotation entity version.',
        requestId: c.get('requestId'),
      });
    }
    const [version] = ifMatch;
    const parsed = await parseBody(c);
    if (!parsed.ok) {
      return parsed.response;
    }
    const req = parsed.body;
    return guardedRegisterWrite(c, pool, 'PATCH', async (scoped) => {
      const current = await scoped.db
        .select({
          id: quotations.id,
          entityVersion: quotations.entityVersion,
          status: quotations.status,
        })
        .from(quotations)
        .where(eq(quotations.id, id))
        .for('update')
        .limit(1);
      const row = current[0];
      if (!row) {
        return { status: 404, body: { code: 'QUOTATION_NOT_FOUND' } };
      }
      if (row.entityVersion !== version) {
        return {
          status: 409,
          body: versionConflictBody(
            c.get('requestId'),
            'The If-Match entity version does not match the current entity. Refetch and retry.',
            row.entityVersion,
          ),
        };
      }
      // Only a DRAFT quotation is editable (contract QuotationUpdateRequest).
      if (row.status !== 'DRAFT') {
        return {
          status: 409,
          body: versionConflictBody(
            c.get('requestId'),
            'A signed or approved quotation is immutable. Only a DRAFT is editable.',
            row.entityVersion,
          ),
        };
      }
      const values: Record<string, unknown> = { entityVersion: crypto.randomUUID() };
      if (req.currency !== undefined) values.currency = req.currency;
      if ('quotationDate' in req)
        values.quotationDate = req.quotationDate ? new Date(req.quotationDate as string) : null;
      if (req.title !== undefined) values.title = req.title;
      if ('validUntil' in req)
        values.validUntil = req.validUntil ? new Date(req.validUntil as string) : null;
      await scoped.db.update(quotations).set(values).where(eq(quotations.id, id));
      const loaded = await loadQuotationRegister(scoped, id);
      if (!loaded) {
        return { status: 500, body: { code: 'WRITE_FAILED' } };
      }
      return {
        status: 200,
        etag: loaded.row.entityVersion,
        body: {
          data: {
            quotation: projectQuotationRegister(
              loaded.row,
              loaded.itemCount,
              projectCapabilities(user.role).canReadFinance.enabled,
              user.role,
            ),
          },
          meta: mutationMeta(c.get('requestId')),
        },
      };
    });
  });

  // --- Invoices (register write; project link) ---------------------------
  app.post('/invoices', async (c) => {
    const user = c.get('user');
    const capability = projectCapabilities(user.role).canWriteInvoice;
    if (!capability.enabled) {
      return problem(c, {
        status: 403,
        code: 'CAPABILITY_DENIED',
        title: 'Capability disabled',
        detail: capability.reason,
        requestId: c.get('requestId'),
      });
    }
    const parsed = await parseBody(c);
    if (!parsed.ok) {
      return parsed.response;
    }
    const req = parsed.body;
    const clientId = req.clientId as string | undefined;
    const projectId = req.projectId as string | undefined;
    const invoiceNumber = req.invoiceNumber as string | undefined;
    if (
      typeof clientId !== 'string' ||
      typeof projectId !== 'string' ||
      typeof invoiceNumber !== 'string'
    ) {
      return problem(c, {
        status: 422,
        code: 'INVALID_INVOICE',
        title: 'Invalid invoice',
        detail: 'clientId, projectId and invoiceNumber are required.',
        requestId: c.get('requestId'),
      });
    }
    // SOL-167: an optional engagementId attaches the DRAFT to the engagement
    // (D-019). It must be a string; it is validated against projectId inside
    // the transaction where the studio scope is live.
    const rawEngagementId = req.engagementId;
    const engagementProvided = rawEngagementId !== undefined;
    const engagementId = typeof rawEngagementId === 'string' ? rawEngagementId : undefined;
    if (engagementProvided && engagementId === undefined) {
      return problem(c, {
        status: 422,
        code: 'INVALID_INVOICE',
        title: 'Invalid invoice',
        detail: 'engagementId must be a string.',
        requestId: c.get('requestId'),
      });
    }
    // SOL-129: a draft may carry its total and receivable components.
    const hasTotal = req.totalAmount !== undefined;
    const hasComponents = req.receivableComponents !== undefined;
    let totalMinor = 0n;
    let components: ParsedComponent[] = [];
    try {
      if (hasTotal) {
        totalMinor = parseDraftTotal(req.totalAmount);
        if (totalMinor <= 0n) {
          throw new MoneyInputError('MONEY_OUT_OF_RANGE', 'The invoice total must be positive.');
        }
      }
      if (hasComponents) {
        const parsedComponents = parseDraftComponents(req.receivableComponents);
        if (!parsedComponents.ok) {
          return problem(c, {
            status: 422,
            code: 'INVALID_INVOICE',
            title: 'Invalid invoice',
            detail:
              'receivableComponents must be a list of { kind, amount } parts with kinds DEPOSIT, RETENTION or BALANCE.',
            requestId: c.get('requestId'),
          });
        }
        components = parsedComponents.components;
      }
      if (hasComponents && !hasTotal) {
        return problem(c, {
          status: 422,
          code: 'INVALID_INVOICE',
          title: 'Invalid invoice',
          detail: 'receivableComponents require totalAmount on the same request.',
          requestId: c.get('requestId'),
        });
      }
      if (hasTotal && components.length > 0) {
        const sumMinor = components.reduce((sum, part) => sum + part.amountMinor, 0n);
        if (sumMinor !== totalMinor) {
          return problem(c, {
            status: 422,
            code: 'COMPONENT_SUM_MISMATCH',
            title: 'Component sum mismatch',
            detail: 'The receivable component amounts must sum to the invoice total.',
            requestId: c.get('requestId'),
            details: { sumMinor: String(sumMinor), totalMinor: String(totalMinor) },
          });
        }
      }
    } catch (error) {
      if (error instanceof MoneyInputError) {
        return problem(c, {
          status: 422,
          code: error.code,
          title: 'Money input invalid',
          detail: error.message,
          requestId: c.get('requestId'),
        });
      }
      throw error;
    }
    return guardedRegisterWrite(c, pool, 'POST', async (scoped) => {
      const project = await scoped.db
        .select({ id: projects.id, clientId: projects.clientId })
        .from(projects)
        .where(eq(projects.id, projectId))
        .limit(1);
      const projectRow = project[0];
      if (!projectRow) {
        return { status: 404, body: { code: 'PROJECT_NOT_FOUND' } };
      }
      // SOL-167: the engagement must belong to this project inside this
      // studio (D-019). A foreign-studio or cross-project id is a 404 and
      // creates no invoice.
      if (engagementProvided) {
        const engagement = await resolveEngagementForRegister(
          scoped,
          projectId,
          engagementId as string,
        );
        if (!engagement) {
          return { status: 404, body: { code: 'ENGAGEMENT_NOT_FOUND' } };
        }
      }
      const client = await scoped.db
        .select({ id: clients.id })
        .from(clients)
        .where(eq(clients.id, clientId))
        .limit(1);
      if (!client[0]) {
        return { status: 404, body: { code: 'CLIENT_NOT_FOUND' } };
      }
      // One project has one client (SOL-69 condition 4).
      if (projectRow.clientId !== clientId) {
        return {
          status: 422,
          body: {
            code: 'INVALID_INVOICE_ANCESTRY',
            detail: 'The project does not belong to this client.',
          },
        };
      }
      // SOL-129: a draft may carry its total; components replace wholesale.
      const inserted = await scoped.db
        .insert(invoices)
        .values({
          studioId: scoped.studioId,
          invoiceNumber,
          clientId,
          projectId,
          // SOL-167: attach the DRAFT to the engagement when supplied (D-019).
          ...(engagementProvided ? { engagementId: engagementId as string } : {}),
          status: 'DRAFT',
          currency: (req.currency as string | undefined) ?? 'IDR',
          ...(hasTotal ? { totalAmount: moneyOutput(totalMinor) } : {}),
          entityVersion: crypto.randomUUID(),
        })
        .returning({ id: invoices.id });
      const created = inserted[0];
      if (!created) {
        return { status: 500, body: { code: 'WRITE_FAILED' } };
      }
      if (hasComponents) {
        await scoped.db
          .delete(invoiceReceivableComponents)
          .where(eq(invoiceReceivableComponents.invoiceId, created.id));
        if (components.length > 0) {
          await scoped.db.insert(invoiceReceivableComponents).values(
            components.map((part) => ({
              studioId: scoped.studioId,
              invoiceId: created.id,
              kind: part.kind,
              amount: moneyOutput(part.amountMinor),
            })),
          );
        }
      }
      const loaded = await loadInvoiceRegister(scoped, created.id);
      if (!loaded) {
        return { status: 500, body: { code: 'WRITE_FAILED' } };
      }
      return {
        status: 201,
        etag: loaded.row.entityVersion,
        body: {
          data: {
            invoice: projectInvoiceRegister(
              loaded.row,
              loaded.paymentCount,
              projectCapabilities(user.role).canReadFinance.enabled,
              user.role,
              loaded.components,
            ),
          },
          meta: mutationMeta(c.get('requestId')),
        },
      };
    });
  });

  app.patch('/invoices/:id', async (c) => {
    const user = c.get('user');
    const capability = projectCapabilities(user.role).canWriteInvoice;
    if (!capability.enabled) {
      return problem(c, {
        status: 403,
        code: 'CAPABILITY_DENIED',
        title: 'Capability disabled',
        detail: capability.reason,
        requestId: c.get('requestId'),
      });
    }
    const id = c.req.param('id');
    const ifMatch = parseIfMatch(c.req.header('If-Match'));
    if (!ifMatch || ifMatch.length < 1) {
      return problem(c, {
        status: 400,
        code: 'MISSING_IF_MATCH',
        title: 'Entity version required',
        detail: 'The update requires If-Match with the invoice entity version.',
        requestId: c.get('requestId'),
      });
    }
    const [version] = ifMatch;
    const parsed = await parseBody(c);
    if (!parsed.ok) {
      return parsed.response;
    }
    const req = parsed.body;
    // SOL-167: PATCH may attach the DRAFT to an engagement or detach it with
    // null (D-019). The engagement must belong to the invoice project; the
    // check runs inside the transaction where the row is locked.
    const hasEngagementField = 'engagementId' in req;
    const rawEngagementId = req.engagementId;
    const engagementId = typeof rawEngagementId === 'string' ? rawEngagementId : null;
    if (hasEngagementField && rawEngagementId !== null && engagementId === null) {
      return problem(c, {
        status: 422,
        code: 'INVALID_INVOICE',
        title: 'Invalid invoice',
        detail: 'engagementId must be a string or null.',
        requestId: c.get('requestId'),
      });
    }
    // SOL-129: validate total/components up front; the DRAFT-only guard runs
    // inside the transaction where the current status is locked.
    const patchTotal = req.totalAmount !== undefined;
    const patchComponents = req.receivableComponents !== undefined;
    let patchTotalMinor = 0n;
    let patchParts: ParsedComponent[] = [];
    try {
      if (patchTotal) {
        patchTotalMinor = parseDraftTotal(req.totalAmount);
        if (patchTotalMinor <= 0n) {
          throw new MoneyInputError('MONEY_OUT_OF_RANGE', 'The invoice total must be positive.');
        }
      }
      if (patchComponents) {
        const parsedComponents = parseDraftComponents(req.receivableComponents);
        if (!parsedComponents.ok) {
          return problem(c, {
            status: 422,
            code: 'INVALID_INVOICE',
            title: 'Invalid invoice',
            detail:
              'receivableComponents must be a list of { kind, amount } parts with kinds DEPOSIT, RETENTION or BALANCE.',
            requestId: c.get('requestId'),
          });
        }
        patchParts = parsedComponents.components;
      }
      if (patchComponents && !patchTotal) {
        return problem(c, {
          status: 422,
          code: 'INVALID_INVOICE',
          title: 'Invalid invoice',
          detail: 'receivableComponents require totalAmount on the same request.',
          requestId: c.get('requestId'),
        });
      }
      if (patchTotal && patchParts.length > 0) {
        const sumMinor = patchParts.reduce((sum, part) => sum + part.amountMinor, 0n);
        if (sumMinor !== patchTotalMinor) {
          return problem(c, {
            status: 422,
            code: 'COMPONENT_SUM_MISMATCH',
            title: 'Component sum mismatch',
            detail: 'The receivable component amounts must sum to the invoice total.',
            requestId: c.get('requestId'),
            details: { sumMinor: String(sumMinor), totalMinor: String(patchTotalMinor) },
          });
        }
      }
    } catch (error) {
      if (error instanceof MoneyInputError) {
        return problem(c, {
          status: 422,
          code: error.code,
          title: 'Money input invalid',
          detail: error.message,
          requestId: c.get('requestId'),
        });
      }
      throw error;
    }
    return guardedRegisterWrite(c, pool, 'PATCH', async (scoped) => {
      const current = await scoped.db
        .select({
          id: invoices.id,
          entityVersion: invoices.entityVersion,
          status: invoices.status,
          projectId: invoices.projectId,
        })
        .from(invoices)
        .where(eq(invoices.id, id))
        .for('update')
        .limit(1);
      const row = current[0];
      if (!row) {
        return { status: 404, body: { code: 'INVOICE_NOT_FOUND' } };
      }
      if (row.entityVersion !== version) {
        return {
          status: 409,
          body: versionConflictBody(
            c.get('requestId'),
            'The If-Match entity version does not match the current entity. Refetch and retry.',
            row.entityVersion,
          ),
        };
      }
      // Only a DRAFT invoice is editable (contract InvoiceUpdateRequest).
      if (row.status !== 'DRAFT') {
        return {
          status: 409,
          body: versionConflictBody(
            c.get('requestId'),
            'An issued invoice is immutable. Only a DRAFT is editable.',
            row.entityVersion,
          ),
        };
      }
      // SOL-167: an engagement move must stay on the invoice project (D-019).
      // A cross-project or foreign-studio id is a 404 and changes nothing.
      if (hasEngagementField && engagementId !== null) {
        if (!row.projectId) {
          return { status: 404, body: { code: 'ENGAGEMENT_NOT_FOUND' } };
        }
        const engagement = await resolveEngagementForRegister(scoped, row.projectId, engagementId);
        if (!engagement) {
          return { status: 404, body: { code: 'ENGAGEMENT_NOT_FOUND' } };
        }
      }
      // SOL-156 condition 1: a total-only PATCH must not desync the stored
      // components. The stored parts must still sum to the new total; the
      // caller can send components on the same request to replace them.
      if (patchTotal && !patchComponents) {
        const storedComponents = await scoped.db
          .select({ amount: invoiceReceivableComponents.amount })
          .from(invoiceReceivableComponents)
          .where(eq(invoiceReceivableComponents.invoiceId, id));
        // A draft may carry a total without parts (POST totalAmount only).
        if (storedComponents.length > 0) {
          const storedSum = storedComponents.reduce(
            (sum, part) => sum + parseStrictMoneyInput(part.amount),
            0n,
          );
          if (storedSum !== patchTotalMinor) {
            return {
              status: 422,
              body: {
                type: 'urn:stdio:error',
                title: 'Component sum mismatch',
                status: 422,
                code: 'COMPONENT_SUM_MISMATCH',
                detail:
                  'The stored receivable component amounts must sum to the new invoice total.',
                requestId: c.get('requestId'),
                details: { sumMinor: String(storedSum), totalMinor: String(patchTotalMinor) },
              },
            };
          }
        }
      }
      const values: Record<string, unknown> = { entityVersion: crypto.randomUUID() };
      if (req.currency !== undefined) values.currency = req.currency;
      if ('dueDate' in req) values.dueDate = req.dueDate ? new Date(req.dueDate as string) : null;
      // SOL-167: attach the DRAFT to an engagement, or detach with null (D-019).
      if (hasEngagementField) values.engagementId = engagementId;
      // SOL-129: a draft may carry its total; components replace wholesale.
      if (patchTotal) {
        values.totalAmount = moneyOutput(patchTotalMinor);
      }
      await scoped.db.update(invoices).set(values).where(eq(invoices.id, id));
      if (patchComponents) {
        await scoped.db
          .delete(invoiceReceivableComponents)
          .where(eq(invoiceReceivableComponents.invoiceId, id));
        if (patchParts.length > 0) {
          await scoped.db.insert(invoiceReceivableComponents).values(
            patchParts.map((part) => ({
              studioId: scoped.studioId,
              invoiceId: id,
              kind: part.kind,
              amount: moneyOutput(part.amountMinor),
            })),
          );
        }
      }
      const loaded = await loadInvoiceRegister(scoped, id);
      if (!loaded) {
        return { status: 500, body: { code: 'WRITE_FAILED' } };
      }
      return {
        status: 200,
        etag: loaded.row.entityVersion,
        body: {
          data: {
            invoice: projectInvoiceRegister(
              loaded.row,
              loaded.paymentCount,
              projectCapabilities(user.role).canReadFinance.enabled,
              user.role,
              loaded.components,
            ),
          },
          meta: mutationMeta(c.get('requestId')),
        },
      };
    });
  });
}

/** Subtracts two canonical `numeric(20,2)` strings exactly (BigInt minor units). */
function subtractDecimal(minuend: string, subtrahend: string): string {
  const toMinor = (value: string): bigint => {
    const negative = value.startsWith('-');
    const unsigned = negative ? value.slice(1) : value;
    const [whole = '0', frac = '00'] = unsigned.split('.');
    const absMinor = BigInt(whole || '0') * 100n + BigInt(`${frac}00`.slice(0, 2));
    return negative ? -absMinor : absMinor;
  };
  return moneyOutput(toMinor(minuend) - toMinor(subtrahend));
}

/** Verifies an engagement belongs to the route's project inside this studio. */
async function resolveEngagementForRegister(
  scoped: Db,
  projectId: string,
  engagementId: string,
): Promise<{ id: string; projectId: string } | null> {
  const rows = await scoped.db
    .select({ id: projectEngagements.id, projectId: projectEngagements.projectId })
    .from(projectEngagements)
    .where(
      and(eq(projectEngagements.id, engagementId), eq(projectEngagements.projectId, projectId)),
    )
    .limit(1);
  return rows[0] ?? null;
}
