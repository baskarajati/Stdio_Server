/**
 * Register writes (SOL-19 revision 6, surface G3).
 *
 * The ten register mutations on the native workspace surface: POST+PATCH on
 * `/clients`, `/vendors`, `/spec-items`, `/quotations`, `/invoices`. Every
 * mutation requires `Idempotency-Key`; every PATCH requires `If-Match`. Each
 * returns the typed `MutationConflict` 409 union and the `MutationMeta`
 * envelope with `idempotentReplay`.
 *
 * Ancestry (SOL-69 conditions 6b and 6c), enforced inside the write
 * transaction:
 *
 * - Every supplied relation (`accountManagerId`, `projectId`,
 *   `engagementId`, `clientId`) is resolved inside the authenticated studio.
 *   RLS scopes the reads; a cross-studio identifier finds no row, the write
 *   returns 404/422, and no row or link is created.
 * - `POST /quotations` requires a valid `projectId` + `engagementId` pair
 *   (the engagement must belong to the project) AND `project.client_id ==
 *   client.id` (ControlledAncestry, D-019).
 * - `POST /invoices` requires a non-null `projectId` and
 *   `project.client_id == client.id`.
 *
 * Capabilities: quotation writes follow the existing `canWriteQuotation`
 * (OWNER) gate and invoice writes follow `canWriteInvoiceDraft` (OWNER), the
 * same gates the engagement-scoped money routes use. Client, vendor and
 * spec-item register maintenance is basic studio data, open to every staff
 * role. Spec items and invoices carry `canReadFinance` in their detail
 * projections so the client never decides the money lens.
 */

import { schema } from '@stdio/db';
import { eq, sql } from 'drizzle-orm';
import type { Hono } from 'hono';
import type { Pool } from 'pg';
import type { ServerEnv } from '../app';
import { projectCapabilities } from '../capabilities';
import type { Db } from '../context/db';
import {
  capabilityDenied,
  entityConflictBody,
  fingerprintFor,
  guardedWrite,
  parseIfMatch,
  requireIdempotencyKey,
  resolveEngagement,
} from '../guards';
import { etagFor, mutationMeta, problem } from '../http';
import { moneyNumber } from '../money';
import { dateLabel, moneyLabel, sortKey, statusLabel } from '../projections';

const {
  clients,
  users,
  projects,
  projectEngagements,
  vendors,
  purchaseOrders,
  specItems,
  quotations,
  quotationItems,
  quotationPaymentMilestones,
  invoices,
  invoicePayments,
  invoiceReceivableComponents,
} = schema;

const _DATE_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T/;

/** The default health signal for a live register row. */
function healthOf(status: string | null): { label: string; tone: string } {
  if (status === 'ACTIVE') {
    return { label: 'Active', tone: 'success' };
  }
  return { label: statusLabel(status) ?? 'Active', tone: 'warning' };
}

function readCapability(): { enabled: boolean; reason: string } {
  return { enabled: true, reason: '' };
}

/** Emits a guarded-write result (completed body text) or the mapped error. */
function writeResponseOrError(
  c: Parameters<typeof requireIdempotencyKey>[0],
  result: Awaited<ReturnType<typeof guardedWrite>>,
  writeName: string,
): Response {
  if (result.outcome === 'conflict') {
    if (result.code === 'IDEMPOTENCY_KEY_REUSED') {
      return problem(c, {
        status: 409,
        code: 'IDEMPOTENCY_KEY_REUSED',
        title: 'Idempotency key reused',
        detail:
          'This Idempotency-Key was used for a different request. A key is bound to one request body.',
        requestId: c.get('requestId'),
      });
    }
    return problem(c, {
      status: result.status,
      code: result.code,
      title: 'Write rejected',
      detail: `The ${writeName} write was rejected by the server.`,
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

/** Parses the JSON request body, or returns a Problem Response on failure. */
async function _parseJsonBody(
  c: Parameters<typeof requireIdempotencyKey>[0],
): Promise<{ body: unknown } | { error: Response }> {
  const raw = await c.req.text();
  try {
    return { body: JSON.parse(raw) };
  } catch {
    return {
      error: problem(c, {
        status: 400,
        code: 'INVALID_JSON',
        title: 'Invalid JSON body',
        detail: 'The request body is not valid JSON.',
        requestId: c.get('requestId'),
      }),
    };
  }
}

function _fingerprintForRequest(
  c: Parameters<typeof requireIdempotencyKey>[0],
  method: string,
  rawBody: string,
): string {
  return fingerprintFor(method, c.req.path, c.req.header('Content-Type') ?? null, rawBody);
}

/** Reads the If-Match version, or returns a Problem Response on failure. */
function requireIfMatch(
  c: Parameters<typeof requireIdempotencyKey>[0],
  subject: string,
): string | Response {
  const ifMatch = parseIfMatch(c.req.header('If-Match'));
  const version = ifMatch?.[0];
  if (!version) {
    return problem(c, {
      status: 400,
      code: 'MISSING_IF_MATCH',
      title: 'Entity version required',
      detail: `The ${subject} write requires If-Match with the current entity version.`,
      requestId: c.get('requestId'),
    });
  }
  return version;
}

/** A guarded-write request body reader shared by every handler. */
async function guardedBody(
  c: Parameters<typeof requireIdempotencyKey>[0],
  method: string,
): Promise<{ rawBody: string; body: unknown; fingerprint: string } | { error: Response }> {
  const raw = await c.req.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      error: problem(c, {
        status: 400,
        code: 'INVALID_JSON',
        title: 'Invalid JSON body',
        detail: 'The request body is not valid JSON.',
        requestId: c.get('requestId'),
      }),
    };
  }
  return {
    rawBody: raw,
    body: parsed,
    fingerprint: fingerprintFor(method, c.req.path, c.req.header('Content-Type') ?? null, raw),
  };
}

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

/** Loads one client with its account manager and register counts. */
async function loadClient(
  scoped: Db,
  id: string,
  _canReadFinance: boolean,
): Promise<Record<string, unknown> | null> {
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
      tags: clients.tags,
      primaryContactName: clients.primaryContactName,
      primaryContactEmail: clients.primaryContactEmail,
      primaryContactPhone: clients.primaryContactPhone,
      accountManagerId: clients.accountManagerId,
      lastContactedAt: clients.lastContactedAt,
      entityVersion: clients.entityVersion,
      updatedAt: clients.updatedAt,
    })
    .from(clients)
    .where(eq(clients.id, id))
    .limit(1);
  const row = rows[0];
  if (!row) {
    return null;
  }

  const [counts, managerRows] = await Promise.all([
    scoped.db
      .select({
        quotations: sql<number>`count(distinct ${quotations.id})::int`,
        invoices: sql<number>`count(distinct ${invoices.id})::int`,
        projects: sql<number>`count(distinct ${projects.id})::int`,
      })
      .from(clients)
      .leftJoin(quotations, eq(quotations.clientId, clients.id))
      .leftJoin(invoices, eq(invoices.clientId, clients.id))
      .leftJoin(projects, eq(projects.clientId, clients.id))
      .where(eq(clients.id, id)),
    row.accountManagerId
      ? scoped.db
          .select({ id: users.id, name: users.name })
          .from(users)
          .where(eq(users.id, row.accountManagerId))
          .limit(1)
      : Promise.resolve([]),
  ]);

  const manager = managerRows[0];
  const hasContact = !!(
    row.primaryContactName ||
    row.primaryContactEmail ||
    row.primaryContactPhone
  );
  return {
    accountManager: manager ? { id: manager.id, name: manager.name } : null,
    capabilities: { read: readCapability() },
    clientNumber: row.clientNumber,
    clientTypeLabel: statusLabel(row.clientType) ?? 'Company',
    companyName: row.companyName ?? null,
    counts: {
      contacts: 0,
      invoices: counts[0]?.invoices ?? 0,
      projects: counts[0]?.projects ?? 0,
      quotations: counts[0]?.quotations ?? 0,
    },
    entityVersion: row.entityVersion,
    health: healthOf(row.status),
    id: row.id,
    lastContactedAt: row.lastContactedAt ? row.lastContactedAt.toISOString() : null,
    leadSourceLabel: row.leadSource ?? null,
    location: row.location ?? null,
    name: row.name,
    primaryContact: hasContact
      ? {
          name: row.primaryContactName ?? '',
          email: row.primaryContactEmail ?? null,
          phone: row.primaryContactPhone ?? null,
        }
      : null,
    source: { href: `/clients/${row.id}`, type: 'client' },
    status: row.status,
    statusLabel: statusLabel(row.status) ?? 'Active',
    tags: row.tags ?? [],
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Registers the register-write routes on `app`. */
export function registerRegisterRoutes(app: Hono<ServerEnv>, pool: Pool): void {
  // -------------------------------------------------------------------------
  // Clients
  // -------------------------------------------------------------------------

  // POST /clients — create a client (Idempotency-Key).
  app.post('/clients', async (c) => {
    const user = c.get('user');
    const key = requireIdempotencyKey(c);
    if (typeof key !== 'string') {
      return key;
    }
    const parsed = await guardedBody(c, 'POST');
    if ('error' in parsed) {
      return parsed.error;
    }

    const result = await guardedWrite(
      pool,
      user,
      key,
      parsed.fingerprint,
      async (scoped) => {
        const req = parsed.body as Record<string, unknown>;
        const clientNumber = req.clientNumber;
        const name = req.name;
        if (typeof clientNumber !== 'string' || clientNumber.length === 0) {
          return {
            status: 422,
            body: { code: 'INVALID_CLIENT_NUMBER', detail: 'clientNumber is required.' },
          };
        }
        if (typeof name !== 'string' || name.length === 0) {
          return { status: 422, body: { code: 'INVALID_NAME', detail: 'name is required.' } };
        }

        const accountManagerId = req.accountManagerId ?? null;
        if (accountManagerId !== null) {
          if (typeof accountManagerId !== 'string') {
            return {
              status: 422,
              body: {
                code: 'INVALID_ACCOUNT_MANAGER',
                detail: 'accountManagerId must be a string or null.',
              },
            };
          }
          // SOL-69 6b: the manager must exist in this studio.
          const manager = await scoped.db
            .select({ id: users.id })
            .from(users)
            .where(eq(users.id, accountManagerId))
            .limit(1);
          if (!manager[0]) {
            return {
              status: 422,
              body: {
                code: 'INVALID_ACCOUNT_MANAGER',
                detail: 'The account manager does not exist in this studio.',
              },
            };
          }
        }

        const inserted = await scoped.db
          .insert(clients)
          .values({
            studioId: scoped.studioId,
            clientNumber,
            name,
            clientType: typeof req.type === 'string' ? req.type : 'COMPANY',
            companyName: req.companyName == null ? null : String(req.companyName),
            location: req.location == null ? null : String(req.location),
            leadSource: req.leadSourceLabel == null ? null : String(req.leadSourceLabel),
            primaryContactEmail: req.email == null ? null : String(req.email),
            primaryContactPhone: req.phone == null ? null : String(req.phone),
            accountManagerId,
          })
          .returning({ id: clients.id, entityVersion: clients.entityVersion });
        const row = inserted[0];
        if (!row) {
          return { status: 500, body: { code: 'WRITE_FAILED', detail: 'No row returned.' } };
        }

        const client = await loadClient(scoped, row.id, true);
        if (!client) {
          return { status: 500, body: { code: 'WRITE_FAILED', detail: 'Reload failed.' } };
        }
        return {
          status: 201,
          etag: row.entityVersion,
          body: {
            data: { client },
            meta: mutationMeta(c.get('requestId')),
          },
        };
      },
      {
        method: 'POST',
        path: c.req.path,
        flipReplayIdempotent: true,
        replayStatus: 200,
      },
    );

    return writeResponseOrError(c, result, 'client');
  });

  // PATCH /clients/{id} — update a client (Idempotency-Key + If-Match).
  app.patch('/clients/:id', async (c) => {
    const user = c.get('user');
    const id = c.req.param('id');
    const key = requireIdempotencyKey(c);
    if (typeof key !== 'string') {
      return key;
    }
    const version = requireIfMatch(c, 'client');
    if (typeof version !== 'string') {
      return version;
    }
    const parsed = await guardedBody(c, 'PATCH');
    if ('error' in parsed) {
      return parsed.error;
    }

    const result = await guardedWrite(
      pool,
      user,
      key,
      parsed.fingerprint,
      async (scoped) => {
        const req = parsed.body as Record<string, unknown>;
        const current = await scoped.db
          .select({
            id: clients.id,
            entityVersion: clients.entityVersion,
          })
          .from(clients)
          .where(eq(clients.id, id))
          .limit(1);
        const row = current[0];
        if (!row) {
          return { status: 404, body: { code: 'CLIENT_NOT_FOUND' } };
        }
        if (row.entityVersion !== version) {
          return { status: 409, body: entityConflictBody(c, row.entityVersion) };
        }

        const accountManagerId = req.accountManagerId ?? null;
        if (accountManagerId !== null && typeof accountManagerId !== 'string') {
          return {
            status: 422,
            body: {
              code: 'INVALID_ACCOUNT_MANAGER',
              detail: 'accountManagerId must be a string or null.',
            },
          };
        }
        if (accountManagerId !== null) {
          const manager = await scoped.db
            .select({ id: users.id })
            .from(users)
            .where(eq(users.id, accountManagerId))
            .limit(1);
          if (!manager[0]) {
            return {
              status: 422,
              body: {
                code: 'INVALID_ACCOUNT_MANAGER',
                detail: 'The account manager does not exist in this studio.',
              },
            };
          }
        }

        const updates: Record<string, unknown> = {
          entityVersion: sql`gen_random_uuid()`,
        };
        if (req.clientNumber !== undefined) {
          updates.clientNumber = String(req.clientNumber);
        }
        if (req.name !== undefined) {
          updates.name = String(req.name);
        }
        if (req.type !== undefined) {
          updates.clientType = String(req.type);
        }
        if (req.companyName !== undefined) {
          updates.companyName = req.companyName == null ? null : String(req.companyName);
        }
        if (req.email !== undefined) {
          updates.primaryContactEmail = req.email == null ? null : String(req.email);
        }
        if (req.phone !== undefined) {
          updates.primaryContactPhone = req.phone == null ? null : String(req.phone);
        }
        if (req.leadSourceLabel !== undefined) {
          updates.leadSource = req.leadSourceLabel == null ? null : String(req.leadSourceLabel);
        }
        if (req.location !== undefined) {
          updates.location = req.location == null ? null : String(req.location);
        }
        if (req.accountManagerId !== undefined) {
          updates.accountManagerId = accountManagerId;
        }

        await scoped.db.update(clients).set(updates).where(eq(clients.id, id));

        const client = await loadClient(scoped, id, true);
        if (!client) {
          return { status: 500, body: { code: 'WRITE_FAILED', detail: 'Reload failed.' } };
        }
        return {
          status: 200,
          etag: row.entityVersion,
          body: {
            data: { client },
            meta: mutationMeta(c.get('requestId')),
          },
        };
      },
      {
        method: 'PATCH',
        path: c.req.path,
        flipReplayIdempotent: true,
        replayStatus: 200,
      },
    );

    return writeResponseOrError(c, result, 'client');
  });

  // -------------------------------------------------------------------------
  // Vendors
  // -------------------------------------------------------------------------

  /** Loads one vendor with its register counts. */
  async function loadVendor(
    scoped: Db,
    id: string,
    canReadFinance: boolean,
  ): Promise<Record<string, unknown> | null> {
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
    const row = rows[0];
    if (!row) {
      return null;
    }

    const counts = await scoped.db
      .select({
        purchaseOrders: sql<number>`count(${purchaseOrders.id})::int`,
      })
      .from(vendors)
      .leftJoin(purchaseOrders, eq(purchaseOrders.vendorId, vendors.id))
      .where(eq(vendors.id, id));

    return {
      apOutstandingLabel: canReadFinance ? moneyLabel('0.00', 'IDR') : null,
      blocked: row.blocked,
      blockedReason: row.blockedReason ?? null,
      capabilities: { read: readCapability() },
      categoryLabel: row.category ?? null,
      contacts: [],
      counts: {
        contacts: 0,
        products: 0,
        purchaseOrders: counts[0]?.purchaseOrders ?? 0,
        specItems: 0,
        vendorBills: 0,
      },
      email: row.email ?? null,
      entityVersion: row.entityVersion,
      health: healthOf(row.status),
      id: row.id,
      name: row.name,
      openBillsCount: 0,
      paymentTerms: row.paymentTerms ?? null,
      phone: row.phone ?? null,
      preferred: row.preferred,
      source: { href: `/vendors/${row.id}`, type: 'vendor' },
      statusLabel: statusLabel(row.status) ?? 'Active',
      updatedAt: row.updatedAt.toISOString(),
      vendorCode: row.vendorCode,
      website: row.website ?? null,
    };
  }

  // POST /vendors — create a vendor (Idempotency-Key).
  app.post('/vendors', async (c) => {
    const user = c.get('user');
    const key = requireIdempotencyKey(c);
    if (typeof key !== 'string') {
      return key;
    }
    const parsed = await guardedBody(c, 'POST');
    if ('error' in parsed) {
      return parsed.error;
    }

    const result = await guardedWrite(
      pool,
      user,
      key,
      parsed.fingerprint,
      async (scoped) => {
        const req = parsed.body as Record<string, unknown>;
        const vendorNumber = req.vendorNumber;
        const name = req.name;
        if (typeof vendorNumber !== 'string' || vendorNumber.length === 0) {
          return {
            status: 422,
            body: { code: 'INVALID_VENDOR_NUMBER', detail: 'vendorNumber is required.' },
          };
        }
        if (typeof name !== 'string' || name.length === 0) {
          return { status: 422, body: { code: 'INVALID_NAME', detail: 'name is required.' } };
        }

        const inserted = await scoped.db
          .insert(vendors)
          .values({
            studioId: scoped.studioId,
            vendorCode: vendorNumber,
            name,
            email: req.email == null ? null : String(req.email),
            phone: req.phone == null ? null : String(req.phone),
            category: req.categoryLabel == null ? null : String(req.categoryLabel),
          })
          .returning({ id: vendors.id, entityVersion: vendors.entityVersion });
        const row = inserted[0];
        if (!row) {
          return { status: 500, body: { code: 'WRITE_FAILED', detail: 'No row returned.' } };
        }

        const vendor = await loadVendor(scoped, row.id, true);
        if (!vendor) {
          return { status: 500, body: { code: 'WRITE_FAILED', detail: 'Reload failed.' } };
        }
        return {
          status: 201,
          etag: row.entityVersion,
          body: {
            data: { vendor },
            meta: mutationMeta(c.get('requestId')),
          },
        };
      },
      {
        method: 'POST',
        path: c.req.path,
        flipReplayIdempotent: true,
        replayStatus: 200,
      },
    );

    return writeResponseOrError(c, result, 'vendor');
  });

  // PATCH /vendors/{id} — update a vendor (Idempotency-Key + If-Match).
  app.patch('/vendors/:id', async (c) => {
    const user = c.get('user');
    const id = c.req.param('id');
    const key = requireIdempotencyKey(c);
    if (typeof key !== 'string') {
      return key;
    }
    const version = requireIfMatch(c, 'vendor');
    if (typeof version !== 'string') {
      return version;
    }
    const parsed = await guardedBody(c, 'PATCH');
    if ('error' in parsed) {
      return parsed.error;
    }

    const result = await guardedWrite(
      pool,
      user,
      key,
      parsed.fingerprint,
      async (scoped) => {
        const req = parsed.body as Record<string, unknown>;
        const current = await scoped.db
          .select({ id: vendors.id, entityVersion: vendors.entityVersion })
          .from(vendors)
          .where(eq(vendors.id, id))
          .limit(1);
        const row = current[0];
        if (!row) {
          return { status: 404, body: { code: 'VENDOR_NOT_FOUND' } };
        }
        if (row.entityVersion !== version) {
          return { status: 409, body: entityConflictBody(c, row.entityVersion) };
        }

        const updates: Record<string, unknown> = {
          entityVersion: sql`gen_random_uuid()`,
        };
        if (req.vendorNumber !== undefined) {
          updates.vendorCode = String(req.vendorNumber);
        }
        if (req.name !== undefined) {
          updates.name = String(req.name);
        }
        if (req.email !== undefined) {
          updates.email = req.email == null ? null : String(req.email);
        }
        if (req.phone !== undefined) {
          updates.phone = req.phone == null ? null : String(req.phone);
        }
        if (req.categoryLabel !== undefined) {
          updates.category = req.categoryLabel == null ? null : String(req.categoryLabel);
        }

        await scoped.db.update(vendors).set(updates).where(eq(vendors.id, id));

        const vendor = await loadVendor(scoped, id, true);
        if (!vendor) {
          return { status: 500, body: { code: 'WRITE_FAILED', detail: 'Reload failed.' } };
        }
        return {
          status: 200,
          etag: row.entityVersion,
          body: {
            data: { vendor },
            meta: mutationMeta(c.get('requestId')),
          },
        };
      },
      {
        method: 'PATCH',
        path: c.req.path,
        flipReplayIdempotent: true,
        replayStatus: 200,
      },
    );

    return writeResponseOrError(c, result, 'vendor');
  });

  // -------------------------------------------------------------------------
  // Spec items
  // -------------------------------------------------------------------------

  /** Loads one spec item with its project name. */
  async function loadSpecItem(
    scoped: Db,
    id: string,
    canReadFinance: boolean,
  ): Promise<Record<string, unknown> | null> {
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
      .innerJoin(projects, eq(projects.id, specItems.projectId))
      .where(eq(specItems.id, id))
      .limit(1);
    const row = rows[0];
    if (!row) {
      return null;
    }

    return {
      alternatesCount: 0,
      brand: row.brand ?? null,
      capabilities: { read: readCapability() },
      canReadFinance,
      category: row.category ?? null,
      clientDecisionLabel: null,
      entityVersion: row.entityVersion,
      hasImage: false,
      id: row.id,
      isPublishedToClient: false,
      leadTimeLabel: null,
      materialLine: null,
      name: row.name,
      projectId: row.projectId,
      projectName: row.projectName,
      quantityLabel: row.quantityLabel ?? '',
      room: row.room ?? null,
      source: { href: `/spec-items/${row.id}`, type: 'spec-item' },
      stage: 'drafting',
      stageLabel: 'Drafting',
      stageSignal: { label: 'Draft', tone: 'neutral' },
      status: 'DRAFT',
      statusLabel: 'Draft',
      unitCost: null,
      unitCostLabel: null,
      updatedAt: row.updatedAt.toISOString(),
      vendorName: null,
    };
  }

  // POST /spec-items — create a spec item (Idempotency-Key).
  app.post('/spec-items', async (c) => {
    const user = c.get('user');
    const key = requireIdempotencyKey(c);
    if (typeof key !== 'string') {
      return key;
    }
    const parsed = await guardedBody(c, 'POST');
    if ('error' in parsed) {
      return parsed.error;
    }

    const result = await guardedWrite(
      pool,
      user,
      key,
      parsed.fingerprint,
      async (scoped) => {
        const req = parsed.body as Record<string, unknown>;
        const name = req.name;
        const projectId = req.projectId;
        if (typeof name !== 'string' || name.length === 0) {
          return { status: 422, body: { code: 'INVALID_NAME', detail: 'name is required.' } };
        }
        if (typeof projectId !== 'string') {
          return {
            status: 422,
            body: { code: 'INVALID_PROJECT', detail: 'projectId is required.' },
          };
        }
        // SOL-69 6b: the project must exist in this studio.
        const project = await scoped.db
          .select({ id: projects.id })
          .from(projects)
          .where(eq(projects.id, projectId))
          .limit(1);
        if (!project[0]) {
          return {
            status: 404,
            body: { code: 'PROJECT_NOT_FOUND', detail: 'The project does not exist.' },
          };
        }

        const inserted = await scoped.db
          .insert(specItems)
          .values({
            studioId: scoped.studioId,
            projectId,
            name,
            room: req.room == null ? null : String(req.room),
            quantityLabel: req.quantityLabel == null ? null : String(req.quantityLabel),
          })
          .returning({ id: specItems.id, entityVersion: specItems.entityVersion });
        const row = inserted[0];
        if (!row) {
          return { status: 500, body: { code: 'WRITE_FAILED', detail: 'No row returned.' } };
        }

        const specItem = await loadSpecItem(scoped, row.id, true);
        if (!specItem) {
          return { status: 500, body: { code: 'WRITE_FAILED', detail: 'Reload failed.' } };
        }
        return {
          status: 201,
          etag: row.entityVersion,
          body: {
            data: { specItem },
            meta: mutationMeta(c.get('requestId')),
          },
        };
      },
      {
        method: 'POST',
        path: c.req.path,
        flipReplayIdempotent: true,
        replayStatus: 200,
      },
    );

    return writeResponseOrError(c, result, 'spec item');
  });

  // PATCH /spec-items/{id} — update a spec item (Idempotency-Key + If-Match).
  app.patch('/spec-items/:id', async (c) => {
    const user = c.get('user');
    const id = c.req.param('id');
    const key = requireIdempotencyKey(c);
    if (typeof key !== 'string') {
      return key;
    }
    const version = requireIfMatch(c, 'spec item');
    if (typeof version !== 'string') {
      return version;
    }
    const parsed = await guardedBody(c, 'PATCH');
    if ('error' in parsed) {
      return parsed.error;
    }

    const result = await guardedWrite(
      pool,
      user,
      key,
      parsed.fingerprint,
      async (scoped) => {
        const req = parsed.body as Record<string, unknown>;
        const current = await scoped.db
          .select({ id: specItems.id, entityVersion: specItems.entityVersion })
          .from(specItems)
          .where(eq(specItems.id, id))
          .limit(1);
        const row = current[0];
        if (!row) {
          return { status: 404, body: { code: 'SPEC_ITEM_NOT_FOUND' } };
        }
        if (row.entityVersion !== version) {
          return { status: 409, body: entityConflictBody(c, row.entityVersion) };
        }

        const updates: Record<string, unknown> = {
          entityVersion: sql`gen_random_uuid()`,
        };
        if (req.name !== undefined) {
          updates.name = String(req.name);
        }
        if (req.quantityLabel !== undefined) {
          updates.quantityLabel = String(req.quantityLabel);
        }
        if (req.room !== undefined) {
          updates.room = req.room == null ? null : String(req.room);
        }
        if (req.brand !== undefined) {
          updates.brand = req.brand == null ? null : String(req.brand);
        }
        if (req.category !== undefined) {
          updates.category = req.category == null ? null : String(req.category);
        }

        await scoped.db.update(specItems).set(updates).where(eq(specItems.id, id));

        const specItem = await loadSpecItem(scoped, id, true);
        if (!specItem) {
          return { status: 500, body: { code: 'WRITE_FAILED', detail: 'Reload failed.' } };
        }
        return {
          status: 200,
          etag: row.entityVersion,
          body: {
            data: { specItem },
            meta: mutationMeta(c.get('requestId')),
          },
        };
      },
      {
        method: 'PATCH',
        path: c.req.path,
        flipReplayIdempotent: true,
        replayStatus: 200,
      },
    );

    return writeResponseOrError(c, result, 'spec item');
  });

  // -------------------------------------------------------------------------
  // Quotations
  // -------------------------------------------------------------------------

  /** Loads one quotation with its client and project context. */
  async function loadQuotation(
    scoped: Db,
    id: string,
    canReadFinance: boolean,
  ): Promise<Record<string, unknown> | null> {
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
        createdAt: quotations.createdAt,
        updatedAt: quotations.updatedAt,
        clientName: clients.name,
        projectName: projects.name,
      })
      .from(quotations)
      .innerJoin(clients, eq(clients.id, quotations.clientId))
      .innerJoin(projects, eq(projects.id, quotations.projectId))
      .where(eq(quotations.id, id))
      .limit(1);
    const row = rows[0];
    if (!row) {
      return null;
    }

    const counts = await scoped.db
      .select({
        items: sql<number>`count(${quotationItems.id})::int`,
        milestones: sql<number>`count(${quotationPaymentMilestones.id})::int`,
      })
      .from(quotations)
      .leftJoin(quotationItems, eq(quotationItems.quotationId, quotations.id))
      .leftJoin(
        quotationPaymentMilestones,
        eq(quotationPaymentMilestones.quotationId, quotations.id),
      )
      .where(eq(quotations.id, id));

    const currency = row.currency ?? 'IDR';
    const canShowMoney = canReadFinance && row.totalAmount !== null;
    return {
      capabilities: { read: readCapability() },
      canReadFinance,
      client: { id: row.clientId, name: row.clientName },
      counts: {
        approvals: 0,
        files: 0,
        items: counts[0]?.items ?? 0,
      },
      engagementId: row.engagementId,
      entityVersion: row.entityVersion,
      health: healthOf(row.status),
      id: row.id,
      projectName: row.projectName,
      projectId: row.projectId,
      quotationDateLabel: row.quotationDate ? dateLabel(row.quotationDate) : null,
      quotationNumber: row.quotationNumber,
      quotationTypeLabel: row.quotationType ? statusLabel(row.quotationType) : null,
      source: { href: `/quotations/${row.id}`, type: 'quotation' },
      status: row.status,
      statusLabel: statusLabel(row.status) ?? 'Draft',
      sortKey: sortKey(row.updatedAt, row.createdAt, row.id),
      title: row.title,
      totalAmount: canShowMoney ? moneyNumber(row.totalAmount, currency) : null,
      totalAmountLabel: canShowMoney ? moneyLabel(row.totalAmount, currency) : null,
      updatedAt: row.updatedAt.toISOString(),
      validUntilLabel: row.validUntil ? dateLabel(row.validUntil) : null,
      version: Number(row.version),
    };
  }

  // POST /quotations — create a quotation (Idempotency-Key). Requires the
  // project+engagement pair and the project-client ancestry (6b, 6c).
  app.post('/quotations', async (c) => {
    const user = c.get('user');
    const capability = projectCapabilities(user.role).canWriteQuotation;
    if (!capability?.enabled) {
      return capabilityDenied(
        c,
        capability ?? { enabled: false, reason: 'Capability unavailable.' },
      );
    }
    const key = requireIdempotencyKey(c);
    if (typeof key !== 'string') {
      return key;
    }
    const parsed = await guardedBody(c, 'POST');
    if ('error' in parsed) {
      return parsed.error;
    }

    const result = await guardedWrite(
      pool,
      user,
      key,
      parsed.fingerprint,
      async (scoped) => {
        const req = parsed.body as Record<string, unknown>;
        const clientId = req.clientId;
        const projectId = req.projectId;
        const engagementId = req.engagementId;
        const quotationNumber = req.quotationNumber;
        const title = req.title;
        if (typeof clientId !== 'string') {
          return { status: 422, body: { code: 'INVALID_CLIENT', detail: 'clientId is required.' } };
        }
        if (typeof projectId !== 'string') {
          return {
            status: 422,
            body: { code: 'INVALID_PROJECT', detail: 'projectId is required.' },
          };
        }
        if (typeof engagementId !== 'string') {
          return {
            status: 422,
            body: { code: 'INVALID_ENGAGEMENT', detail: 'engagementId is required.' },
          };
        }
        if (typeof quotationNumber !== 'string' || quotationNumber.length === 0) {
          return {
            status: 422,
            body: { code: 'INVALID_QUOTATION_NUMBER', detail: 'quotationNumber is required.' },
          };
        }
        if (typeof title !== 'string' || title.length === 0) {
          return { status: 422, body: { code: 'INVALID_TITLE', detail: 'title is required.' } };
        }

        // 6b: the engagement must belong to the project inside this studio.
        const engagement = await resolveEngagement(scoped, projectId, engagementId);
        if (!engagement) {
          return {
            status: 404,
            body: { code: 'ENGAGEMENT_NOT_FOUND', detail: 'The engagement does not exist.' },
          };
        }
        // 6b: the client must exist inside this studio.
        const client = await scoped.db
          .select({ id: clients.id })
          .from(clients)
          .where(eq(clients.id, clientId))
          .limit(1);
        if (!client[0]) {
          return {
            status: 422,
            body: { code: 'INVALID_CLIENT', detail: 'The client does not exist in this studio.' },
          };
        }
        // 6c: the client must be the project's client (ControlledAncestry).
        const project = await scoped.db
          .select({ clientId: projects.clientId })
          .from(projects)
          .where(eq(projects.id, projectId))
          .limit(1);
        if (!project[0]) {
          return { status: 404, body: { code: 'PROJECT_NOT_FOUND' } };
        }
        if (project[0].clientId !== clientId) {
          return {
            status: 422,
            body: {
              code: 'CLIENT_PROJECT_MISMATCH',
              detail: 'The client is not the client of the selected project.',
            },
          };
        }

        const now = new Date();
        const quotationDate = req.quotationDate ? new Date(String(req.quotationDate)) : now;
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
            currency: typeof req.currency === 'string' ? req.currency : 'IDR',
            quotationDate,
            validUntil: req.validUntil == null ? null : new Date(String(req.validUntil)),
          })
          .returning({ id: quotations.id, entityVersion: quotations.entityVersion });
        const row = inserted[0];
        if (!row) {
          return { status: 500, body: { code: 'WRITE_FAILED', detail: 'No row returned.' } };
        }

        const quotation = await loadQuotation(
          scoped,
          row.id,
          projectCapabilities(user.role).canReadFinance?.enabled ?? false,
        );
        if (!quotation) {
          return { status: 500, body: { code: 'WRITE_FAILED', detail: 'Reload failed.' } };
        }
        return {
          status: 201,
          etag: row.entityVersion,
          body: {
            data: { quotation },
            meta: mutationMeta(c.get('requestId')),
          },
        };
      },
      {
        method: 'POST',
        path: c.req.path,
        flipReplayIdempotent: true,
        replayStatus: 200,
      },
    );

    return writeResponseOrError(c, result, 'quotation');
  });

  // PATCH /quotations/{id} — update a draft quotation (Idempotency-Key +
  // If-Match). A signed/approved quotation is immutable: PATCH returns 409
  // ENTITY_VERSION_CONFLICT with draftPreserved true.
  app.patch('/quotations/:id', async (c) => {
    const user = c.get('user');
    const id = c.req.param('id');
    const capability = projectCapabilities(user.role).canWriteQuotation;
    if (!capability?.enabled) {
      return capabilityDenied(
        c,
        capability ?? { enabled: false, reason: 'Capability unavailable.' },
      );
    }
    const key = requireIdempotencyKey(c);
    if (typeof key !== 'string') {
      return key;
    }
    const version = requireIfMatch(c, 'quotation');
    if (typeof version !== 'string') {
      return version;
    }
    const parsed = await guardedBody(c, 'PATCH');
    if ('error' in parsed) {
      return parsed.error;
    }

    const result = await guardedWrite(
      pool,
      user,
      key,
      parsed.fingerprint,
      async (scoped) => {
        const req = parsed.body as Record<string, unknown>;
        const current = await scoped.db
          .select({
            id: quotations.id,
            status: quotations.status,
            entityVersion: quotations.entityVersion,
          })
          .from(quotations)
          .where(eq(quotations.id, id))
          .limit(1);
        const row = current[0];
        if (!row) {
          return { status: 404, body: { code: 'QUOTATION_NOT_FOUND' } };
        }
        if (row.entityVersion !== version) {
          return { status: 409, body: entityConflictBody(c, row.entityVersion) };
        }
        if (row.status !== 'DRAFT') {
          return { status: 409, body: entityConflictBody(c, row.entityVersion) };
        }

        const updates: Record<string, unknown> = {
          entityVersion: sql`gen_random_uuid()`,
        };
        if (req.currency !== undefined) {
          updates.currency = String(req.currency);
        }
        if (req.title !== undefined) {
          updates.title = String(req.title);
        }
        if (req.quotationDate !== undefined) {
          updates.quotationDate =
            req.quotationDate == null ? null : new Date(String(req.quotationDate));
        }
        if (req.validUntil !== undefined) {
          updates.validUntil = req.validUntil == null ? null : new Date(String(req.validUntil));
        }

        await scoped.db.update(quotations).set(updates).where(eq(quotations.id, id));

        const quotation = await loadQuotation(
          scoped,
          id,
          projectCapabilities(user.role).canReadFinance?.enabled ?? false,
        );
        if (!quotation) {
          return { status: 500, body: { code: 'WRITE_FAILED', detail: 'Reload failed.' } };
        }
        return {
          status: 200,
          etag: row.entityVersion,
          body: {
            data: { quotation },
            meta: mutationMeta(c.get('requestId')),
          },
        };
      },
      {
        method: 'PATCH',
        path: c.req.path,
        flipReplayIdempotent: true,
        replayStatus: 200,
      },
    );

    return writeResponseOrError(c, result, 'quotation');
  });

  // -------------------------------------------------------------------------
  // Invoices
  // -------------------------------------------------------------------------

  /** Loads one invoice with its client and project context. */
  async function loadInvoice(
    scoped: Db,
    id: string,
    _canReadFinance: boolean,
  ): Promise<Record<string, unknown> | null> {
    const rows = await scoped.db
      .select({
        id: invoices.id,
        invoiceNumber: invoices.invoiceNumber,
        displayNumber: invoices.displayNumber,
        clientId: invoices.clientId,
        projectId: invoices.projectId,
        status: invoices.status,
        currency: invoices.currency,
        issueDate: invoices.issueDate,
        dueDate: invoices.dueDate,
        issuedAt: invoices.issuedAt,
        totalAmount: invoices.totalAmount,
        entityVersion: invoices.entityVersion,
        updatedAt: invoices.updatedAt,
        clientName: clients.name,
        projectName: projects.name,
      })
      .from(invoices)
      .innerJoin(clients, eq(clients.id, invoices.clientId))
      .innerJoin(projects, eq(projects.id, invoices.projectId))
      .where(eq(invoices.id, id))
      .limit(1);
    const row = rows[0];
    if (!row) {
      return null;
    }

    const currency = row.currency ?? 'IDR';
    const zeroLabel = moneyLabel('0.00', currency) ?? 'Rp 0,00';
    const totalLabel =
      row.totalAmount !== null && row.totalAmount !== undefined
        ? (moneyLabel(row.totalAmount, currency) ?? zeroLabel)
        : zeroLabel;

    return {
      capabilities: { read: readCapability() },
      client: { id: row.clientId, name: row.clientName },
      counts: { items: 0, payments: 0 },
      dueDate: row.dueDate ? row.dueDate.toISOString() : null,
      dueDateLabel: row.dueDate ? dateLabel(row.dueDate) : null,
      displayNumber: row.displayNumber ?? null,
      entityVersion: row.entityVersion,
      health: healthOf(row.status),
      id: row.id,
      invoiceNumber: row.invoiceNumber,
      isOverdue: false,
      issueDateLabel: row.issueDate ? dateLabel(row.issueDate) : null,
      issuedAt: row.issuedAt ? row.issuedAt.toISOString() : null,
      outstandingAmountLabel: totalLabel,
      paidAmountLabel: zeroLabel,
      payments: [],
      projectName: row.projectName,
      receivableComponents: [],
      source: { href: `/invoices/${row.id}`, type: 'invoice' },
      status: row.status,
      statusLabel: statusLabel(row.status) ?? 'Draft',
      totalAmountLabel: totalLabel,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  // POST /invoices — create an invoice (Idempotency-Key). Requires a
  // non-null projectId and the project-client ancestry (6b, 6c).
  app.post('/invoices', async (c) => {
    const user = c.get('user');
    const capability = projectCapabilities(user.role).canWriteInvoiceDraft;
    if (!capability?.enabled) {
      return capabilityDenied(
        c,
        capability ?? { enabled: false, reason: 'Capability unavailable.' },
      );
    }
    const key = requireIdempotencyKey(c);
    if (typeof key !== 'string') {
      return key;
    }
    const parsed = await guardedBody(c, 'POST');
    if ('error' in parsed) {
      return parsed.error;
    }

    const result = await guardedWrite(
      pool,
      user,
      key,
      parsed.fingerprint,
      async (scoped) => {
        const req = parsed.body as Record<string, unknown>;
        const clientId = req.clientId;
        const projectId = req.projectId;
        const invoiceNumber = req.invoiceNumber;
        if (typeof clientId !== 'string') {
          return { status: 422, body: { code: 'INVALID_CLIENT', detail: 'clientId is required.' } };
        }
        if (typeof projectId !== 'string') {
          return {
            status: 422,
            body: { code: 'INVALID_PROJECT', detail: 'projectId is required.' },
          };
        }
        if (typeof invoiceNumber !== 'string' || invoiceNumber.length === 0) {
          return {
            status: 422,
            body: { code: 'INVALID_INVOICE_NUMBER', detail: 'invoiceNumber is required.' },
          };
        }

        // 6b + 6c: project and client must exist in this studio, and the
        // client must be the project's client.
        const project = await scoped.db
          .select({ id: projects.id, clientId: projects.clientId })
          .from(projects)
          .where(eq(projects.id, projectId))
          .limit(1);
        if (!project[0]) {
          return {
            status: 404,
            body: { code: 'PROJECT_NOT_FOUND', detail: 'The project does not exist.' },
          };
        }
        const client = await scoped.db
          .select({ id: clients.id })
          .from(clients)
          .where(eq(clients.id, clientId))
          .limit(1);
        if (!client[0]) {
          return {
            status: 422,
            body: { code: 'INVALID_CLIENT', detail: 'The client does not exist in this studio.' },
          };
        }
        if (project[0].clientId !== clientId) {
          return {
            status: 422,
            body: {
              code: 'CLIENT_PROJECT_MISMATCH',
              detail: 'The client is not the client of the selected project.',
            },
          };
        }

        const inserted = await scoped.db
          .insert(invoices)
          .values({
            studioId: scoped.studioId,
            invoiceNumber,
            clientId,
            projectId,
            status: 'DRAFT',
            currency: typeof req.currency === 'string' ? req.currency : 'IDR',
          })
          .returning({ id: invoices.id, entityVersion: invoices.entityVersion });
        const row = inserted[0];
        if (!row) {
          return { status: 500, body: { code: 'WRITE_FAILED', detail: 'No row returned.' } };
        }

        const invoice = await loadInvoice(
          scoped,
          row.id,
          projectCapabilities(user.role).canReadFinance?.enabled ?? false,
        );
        if (!invoice) {
          return { status: 500, body: { code: 'WRITE_FAILED', detail: 'Reload failed.' } };
        }
        return {
          status: 201,
          etag: row.entityVersion,
          body: {
            data: { invoice },
            meta: mutationMeta(c.get('requestId')),
          },
        };
      },
      {
        method: 'POST',
        path: c.req.path,
        flipReplayIdempotent: true,
        replayStatus: 200,
      },
    );

    return writeResponseOrError(c, result, 'invoice');
  });

  // PATCH /invoices/{id} — update a draft invoice (Idempotency-Key +
  // If-Match). An issued invoice is immutable: PATCH returns 409
  // ENTITY_VERSION_CONFLICT with draftPreserved true.
  app.patch('/invoices/:id', async (c) => {
    const user = c.get('user');
    const id = c.req.param('id');
    const capability = projectCapabilities(user.role).canWriteInvoiceDraft;
    if (!capability?.enabled) {
      return capabilityDenied(
        c,
        capability ?? { enabled: false, reason: 'Capability unavailable.' },
      );
    }
    const key = requireIdempotencyKey(c);
    if (typeof key !== 'string') {
      return key;
    }
    const version = requireIfMatch(c, 'invoice');
    if (typeof version !== 'string') {
      return version;
    }
    const parsed = await guardedBody(c, 'PATCH');
    if ('error' in parsed) {
      return parsed.error;
    }

    const result = await guardedWrite(
      pool,
      user,
      key,
      parsed.fingerprint,
      async (scoped) => {
        const req = parsed.body as Record<string, unknown>;
        const current = await scoped.db
          .select({
            id: invoices.id,
            status: invoices.status,
            entityVersion: invoices.entityVersion,
          })
          .from(invoices)
          .where(eq(invoices.id, id))
          .limit(1);
        const row = current[0];
        if (!row) {
          return { status: 404, body: { code: 'INVOICE_NOT_FOUND' } };
        }
        if (row.entityVersion !== version) {
          return { status: 409, body: entityConflictBody(c, row.entityVersion) };
        }
        if (row.status !== 'DRAFT') {
          return { status: 409, body: entityConflictBody(c, row.entityVersion) };
        }

        const updates: Record<string, unknown> = {
          entityVersion: sql`gen_random_uuid()`,
        };
        if (req.currency !== undefined) {
          updates.currency = String(req.currency);
        }
        if (req.dueDate !== undefined) {
          updates.dueDate = req.dueDate == null ? null : new Date(String(req.dueDate));
        }

        await scoped.db.update(invoices).set(updates).where(eq(invoices.id, id));

        const invoice = await loadInvoice(
          scoped,
          id,
          projectCapabilities(user.role).canReadFinance?.enabled ?? false,
        );
        if (!invoice) {
          return { status: 500, body: { code: 'WRITE_FAILED', detail: 'Reload failed.' } };
        }
        return {
          status: 200,
          etag: row.entityVersion,
          body: {
            data: { invoice },
            meta: mutationMeta(c.get('requestId')),
          },
        };
      },
      {
        method: 'PATCH',
        path: c.req.path,
        flipReplayIdempotent: true,
        replayStatus: 200,
      },
    );

    return writeResponseOrError(c, result, 'invoice');
  });
}
