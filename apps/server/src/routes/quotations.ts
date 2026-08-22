/**
 * Engagement-scoped quotation routes (SOL-28 revision 7).
 *
 * Money and scope belong to the engagement (D-019). Quotation reads and
 * writes anchor on `/projects/{id}/engagements/{engagementId}`. The project
 * has no quotation pot: a quotation may carry `engagementId` null only when
 * it is unassigned (D-043); the `assign` operation sets it.
 *
 * Money wire: quotation totals and rates are NUMBER-form (`ProjectQuotation`
 * declares `type: number`), so they MUST be emitted losslessly via
 * `moneyNumber` + `serializeJson` (never `c.json`). The `*Label` twins are
 * derived from the same `numeric(20,2)` value. The finance lens
 * (`canReadFinance`) masks every money field.
 *
 * Guards (guards.ts): every write carries `Idempotency-Key` (+ `If-Match` on
 * entity writes) and the capability projection (`canWriteQuotation`, OWNER).
 */

import { money, moneyToDecimal, parseMoneyInput } from '@stdio/core';
import { schema } from '@stdio/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Hono } from 'hono';
import type { Pool } from 'pg';

import type { ServerEnv } from '../app';
import { projectCapabilities } from '../capabilities';
import { type Db, withStudioTx } from '../context/db';
import {
  capabilityDenied,
  entityConflict,
  fingerprintFor,
  guardedWrite,
  idempotencyReused,
  parseIfMatch,
  requireIdempotencyKey,
  resolveEngagement,
} from '../guards';
import { etagFor, meta, problem } from '../http';
import { jsonResponse, moneyNumber } from '../money';
import { moneyLabel } from '../projections';

const { quotations, quotationItems, quotationPaymentMilestones } = schema;

/** A `MoneyInput` (string or number) to the canonical `numeric(20,2)` string. */
function moneyInputToColumn(raw: unknown, currency: string): string | null {
  if (typeof raw !== 'string' && typeof raw !== 'number') {
    return null;
  }
  return moneyToDecimal(parseMoneyInput(raw, currency));
}

type QuotationRow = {
  id: string;
  quotationNumber: string;
  title: string;
  clientId: string;
  projectId: string | null;
  engagementId: string | null;
  version: string;
  status: string;
  quotationType: string | null;
  feeModel: string | null;
  currency: string;
  subtotalAmount: string | null;
  discountPercent: string | null;
  discountAmount: string | null;
  taxAmount: string | null;
  totalAmount: string | null;
  defaultRatePerSqm: string | null;
  validUntil: Date | null;
  quotationDate: Date | null;
  lastAcceptedAt: Date | null;
  lastDeclinedAt: Date | null;
  entityVersion: string;
  updatedAt: Date;
};

type FeeItemRow = {
  id: string;
  lineOrder: string;
  lineType: string;
  code: string | null;
  description: string;
  unit: string | null;
  quantity: string | null;
  unitRate: string | null;
  lineSubtotal: string | null;
  lineTaxAmount: string | null;
  lineTotal: string | null;
  sourceType: string | null;
  sourceId: string | null;
};

type PaymentMilestoneRow = {
  id: string;
  sortOrder: string;
  name: string;
  description: string | null;
  dueTrigger: string | null;
  percentage: string | null;
  amount: string | null;
};

/** Projects one quotation row into the contract `ProjectQuotation` shape. */
function projectQuotation(
  row: QuotationRow,
  canReadFinance: boolean,
  feeItems: FeeItemRow[],
  milestones: PaymentMilestoneRow[],
): Record<string, unknown> {
  const currency = row.currency ?? 'IDR';
  const num = (value: string | null) => (canReadFinance ? moneyNumber(value, currency) : null);
  const label = (value: string | null) => (canReadFinance ? moneyLabel(value, currency) : null);

  return {
    canReadFinance,
    entityVersion: row.entityVersion,
    engagementId: row.engagementId,
    defaultRatePerSqm: num(row.defaultRatePerSqm),
    defaultRatePerSqmLabel: label(row.defaultRatePerSqm),
    discountAmount: num(row.discountAmount),
    discountAmountLabel: label(row.discountAmount),
    // `discount_percent` is `numeric(10,4)` — a percentage, not 2dp money (SOL-96).
    discountPercent:
      canReadFinance && row.discountPercent !== null ? Number(row.discountPercent) : null,
    feeItems: feeItems.map((f) => ({
      id: f.id,
      label: f.description,
      area: f.quantity === null ? 0 : Number(f.quantity),
      ratePerSqm: num(f.unitRate),
      ratePerSqmLabel: label(f.unitRate),
      lineTotal: num(f.lineTotal),
      lineTotalLabel: label(f.lineTotal),
    })),
    feeModel: row.feeModel,
    id: row.id,
    projectId: row.projectId,
    items: feeItems.map((f) => ({
      id: f.id,
      description: f.description,
      quantity: f.quantity === null ? 0 : Number(f.quantity),
      unitPrice: num(f.unitRate),
      unitPriceLabel: label(f.unitRate),
      lineTotal: num(f.lineTotal),
      lineTotalLabel: label(f.lineTotal),
    })),
    paymentMilestones: milestones.map((m) => ({
      id: m.id,
      name: m.name,
      description: m.description,
      dueTrigger: m.dueTrigger,
      sortOrder: Number(m.sortOrder),
      // Milestone `percentage` is `numeric(10,4)` too — emit exact, not 2dp money.
      percentage: canReadFinance && m.percentage !== null ? Number(m.percentage) : null,
      amount: num(m.amount),
      amountLabel: label(m.amount),
    })),
    quotationNumber: row.quotationNumber,
    revision: {
      next: [],
      previous: null,
      version: Number(row.version),
    },
    reviewState: {
      hasActiveLink: false,
      lastAcceptedAt: row.lastAcceptedAt ? row.lastAcceptedAt.toISOString() : null,
      lastDeclinedAt: row.lastDeclinedAt ? row.lastDeclinedAt.toISOString() : null,
    },
    status: row.status,
    sortKey: [String(row.version).padStart(4, '0'), row.updatedAt.toISOString(), row.id].join('|'),
    subtotalAmount: num(row.subtotalAmount),
    subtotalAmountLabel: label(row.subtotalAmount),
    terms: [],
    title: row.title,
    totalAmount: num(row.totalAmount),
    totalAmountLabel: label(row.totalAmount),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function loadQuotation(
  scoped: Db,
  projectId: string,
  engagementId: string,
  quotationId?: string,
) {
  const where = quotationId
    ? and(
        eq(quotations.id, quotationId),
        eq(quotations.projectId, projectId),
        eq(quotations.engagementId, engagementId),
      )
    : and(eq(quotations.projectId, projectId), eq(quotations.engagementId, engagementId));
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
      feeModel: quotations.feeModel,
      currency: quotations.currency,
      subtotalAmount: quotations.subtotalAmount,
      discountPercent: quotations.discountPercent,
      discountAmount: quotations.discountAmount,
      taxAmount: quotations.taxAmount,
      totalAmount: quotations.totalAmount,
      defaultRatePerSqm: quotations.defaultRatePerSqm,
      validUntil: quotations.validUntil,
      quotationDate: quotations.quotationDate,
      lastAcceptedAt: quotations.lastAcceptedAt,
      lastDeclinedAt: quotations.lastDeclinedAt,
      entityVersion: quotations.entityVersion,
      updatedAt: quotations.updatedAt,
    })
    .from(quotations)
    .where(where)
    .orderBy(sql`${quotations.version} desc`);

  const ids = rows.map((r) => r.id);
  const items = ids.length
    ? await scoped.db
        .select({
          id: quotationItems.id,
          quotationId: quotationItems.quotationId,
          lineOrder: quotationItems.lineOrder,
          lineType: quotationItems.lineType,
          code: quotationItems.code,
          description: quotationItems.description,
          unit: quotationItems.unit,
          quantity: quotationItems.quantity,
          unitRate: quotationItems.unitRate,
          lineSubtotal: quotationItems.lineSubtotal,
          lineTaxAmount: quotationItems.lineTaxAmount,
          lineTotal: quotationItems.lineTotal,
          sourceType: quotationItems.sourceType,
          sourceId: quotationItems.sourceId,
        })
        .from(quotationItems)
        .where(inArray(quotationItems.quotationId, ids))
        .orderBy(sql`${quotationItems.lineOrder} asc`)
    : [];
  const itemsByQuotation = new Map<string, FeeItemRow[]>();
  for (const item of items) {
    const list = itemsByQuotation.get(item.quotationId) ?? [];
    list.push(item);
    itemsByQuotation.set(item.quotationId, list);
  }

  const milestones = ids.length
    ? await scoped.db
        .select({
          id: quotationPaymentMilestones.id,
          quotationId: quotationPaymentMilestones.quotationId,
          sortOrder: quotationPaymentMilestones.sortOrder,
          name: quotationPaymentMilestones.name,
          description: quotationPaymentMilestones.description,
          dueTrigger: quotationPaymentMilestones.dueTrigger,
          percentage: quotationPaymentMilestones.percentage,
          amount: quotationPaymentMilestones.amount,
        })
        .from(quotationPaymentMilestones)
        .where(inArray(quotationPaymentMilestones.quotationId, ids))
        .orderBy(sql`${quotationPaymentMilestones.sortOrder} asc`)
    : [];
  const milestonesByQuotation = new Map<string, PaymentMilestoneRow[]>();
  for (const m of milestones) {
    const list = milestonesByQuotation.get(m.quotationId) ?? [];
    list.push(m);
    milestonesByQuotation.set(m.quotationId, list);
  }

  return rows.map((row) => ({
    row,
    feeItems: itemsByQuotation.get(row.id) ?? [],
    milestones: milestonesByQuotation.get(row.id) ?? [],
  }));
}

/** Registers the engagement-scoped quotation routes on `app`. */
export function registerQuotationRoutes(app: Hono<ServerEnv>, pool: Pool): void {
  // GET /projects/{id}/engagements/{engId}/quotations — the register.
  app.get('/projects/:id/engagements/:engId/quotations', async (c) => {
    const user = c.get('user');
    const projectId = c.req.param('id');
    const engagementId = c.req.param('engId');
    const capabilities = projectCapabilities(user.role);

    const result = await withStudioTx(pool, user, async (scoped) => {
      const engagement = await resolveEngagement(scoped, projectId, engagementId);
      if (!engagement) {
        return { status: 404 as const };
      }
      const loaded = await loadQuotation(scoped, projectId, engagementId);
      return {
        status: 200 as const,
        data: {
          quotations: {
            canReadFinance: capabilities.canReadFinance.enabled,
            capabilities: { read: capabilities.canReadContracts },
            quotations: loaded.map(({ row, feeItems, milestones }) =>
              projectQuotation(
                row,
                capabilities.canReadFinance?.enabled ?? false,
                feeItems,
                milestones,
              ),
            ),
          },
        },
      };
    });

    if (result.status === 404) {
      return problem(c, {
        status: 404,
        code: 'ENGAGEMENT_NOT_FOUND',
        title: 'Engagement not found',
        detail: 'The engagement does not exist on this project.',
        requestId: c.get('requestId'),
      });
    }
    return jsonResponse({ data: result.data, meta: meta(c.get('requestId')) });
  });

  // GET /projects/{id}/engagements/{engId}/quotations/{quotationId} — detail.
  app.get('/projects/:id/engagements/:engId/quotations/:quotationId', async (c) => {
    const user = c.get('user');
    const projectId = c.req.param('id');
    const engagementId = c.req.param('engId');
    const quotationId = c.req.param('quotationId');
    const capabilities = projectCapabilities(user.role);

    const result = await withStudioTx(pool, user, async (scoped) => {
      const engagement = await resolveEngagement(scoped, projectId, engagementId);
      if (!engagement) {
        return { status: 404 as const };
      }
      const loaded = await loadQuotation(scoped, projectId, engagementId, quotationId);
      const item = loaded[0];
      if (!item) {
        return { status: 404 as const };
      }
      return {
        status: 200 as const,
        data: {
          quotation: projectQuotation(
            item.row,
            capabilities.canReadFinance.enabled,
            item.feeItems,
            item.milestones,
          ),
        },
        etag: item.row.entityVersion,
      };
    });

    if (result.status === 404) {
      return problem(c, {
        status: 404,
        code: 'QUOTATION_NOT_FOUND',
        title: 'Quotation not found',
        detail: 'The quotation does not exist on this engagement.',
        requestId: c.get('requestId'),
      });
    }
    const response = jsonResponse({ data: result.data, meta: meta(c.get('requestId')) });
    if (result.etag) {
      response.headers.set('ETag', etagFor(result.etag));
    }
    return response;
  });

  // POST /projects/{id}/engagements/{engId}/quotations — create a draft
  // quotation on the engagement.
  app.post('/projects/:id/engagements/:engId/quotations', async (c) => {
    const user = c.get('user');
    const projectId = c.req.param('id');
    const engagementId = c.req.param('engId');

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

    const rawBody = await c.req.text();
    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return problem(c, {
        status: 400,
        code: 'INVALID_JSON',
        title: 'Invalid JSON body',
        detail: 'The request body is not valid JSON.',
        requestId: c.get('requestId'),
      });
    }
    const fingerprint = fingerprintFor(
      'POST',
      c.req.path,
      c.req.header('Content-Type') ?? null,
      rawBody,
    );

    const result = await guardedWrite(pool, user, key, fingerprint, async (scoped) => {
      const engagement = await resolveEngagement(scoped, projectId, engagementId);
      if (!engagement) {
        return { status: 404, body: { code: 'ENGAGEMENT_NOT_FOUND' } };
      }
      const req = body as Record<string, unknown>;
      const clientRows = await scoped.db
        .select({ id: schema.clients.id })
        .from(schema.clients)
        .where(eq(schema.clients.id, req.clientId as string))
        .limit(1);
      const client = clientRows[0];
      if (!client) {
        return {
          status: 422,
          body: { code: 'INVALID_CLIENT', detail: 'The client does not exist.' },
        };
      }

      const now = new Date();
      const inserted = await scoped.db
        .insert(quotations)
        .values({
          studioId: scoped.studioId,
          quotationNumber: req.quotationNumber as string,
          title: (req.title as string) ?? 'Draft quotation',
          clientId: client.id,
          projectId,
          engagementId,
          version: '1',
          status: 'DRAFT',
          quotationType: (req.quotationType as string) ?? null,
          feeModel: (req.feeModel as string) ?? null,
          currency: (req.currency as string) ?? 'IDR',
          quotationDate: req.quotationDate ? new Date(req.quotationDate as string) : now,
          validUntil: req.validUntil ? new Date(req.validUntil as string) : null,
        })
        .returning({
          id: quotations.id,
          entityVersion: quotations.entityVersion,
        });
      const quotation = inserted[0];
      if (!quotation) {
        return {
          status: 500,
          body: { code: 'WRITE_FAILED', detail: 'The quotation row was not returned.' },
        };
      }

      const feeItems = (req.feeItems as Record<string, unknown>[] | undefined) ?? [];
      for (const [index, fee] of feeItems.entries()) {
        const currency = (req.currency as string) ?? 'IDR';
        const rate = moneyInputToColumn(fee.ratePerSqm, currency);
        const quantity = String(fee.area ?? 0);
        const lineTotal = rate
          ? moneyToDecimal(
              money(
                (parseMoneyInput(rate, currency).amount *
                  BigInt(Math.round(Number(quantity) * 100))) /
                  100n,
                currency,
              ),
            )
          : null;
        await scoped.db.insert(quotationItems).values({
          studioId: scoped.studioId,
          quotationId: quotation.id,
          lineOrder: String(index + 1),
          lineType: 'FEE',
          code: (fee.code as string) ?? null,
          description: (fee.label as string) ?? 'Fee',
          unit: 'sqm',
          quantity,
          unitRate: rate,
          lineSubtotal: lineTotal,
          lineTaxAmount: null,
          lineTotal,
          sourceType: null,
          sourceId: null,
        });
      }

      const loaded = await loadQuotation(scoped, projectId, engagementId, quotation.id);
      const item = loaded[0];
      return {
        status: 201,
        etag: quotation.entityVersion,
        body: {
          data: {
            quotation: item
              ? projectQuotation(
                  item.row,
                  projectCapabilities(user.role).canReadFinance?.enabled ?? false,
                  item.feeItems,
                  item.milestones,
                )
              : null,
            reviewLink: null,
          },
          meta: meta(c.get('requestId')),
        },
      };
    });

    if (result.outcome === 'conflict') {
      if (result.code === 'IDEMPOTENCY_KEY_REUSED') {
        return idempotencyReused(c);
      }
      return problem(c, {
        status: result.status,
        code: result.code,
        title: 'Write rejected',
        detail: 'The quotation write was rejected by the server.',
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
  });

  // POST /projects/{id}/engagements/{engId}/quotations/{quotationId}/fee
  // — replace the guarded fee items and recompute totals (If-Match).
  app.post('/projects/:id/engagements/:engId/quotations/:quotationId/fee', async (c) => {
    const user = c.get('user');
    const projectId = c.req.param('id');
    const engagementId = c.req.param('engId');
    const quotationId = c.req.param('quotationId');

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
    const ifMatch = parseIfMatch(c.req.header('If-Match'));
    if (!ifMatch || ifMatch.length < 1) {
      return problem(c, {
        status: 400,
        code: 'MISSING_IF_MATCH',
        title: 'Entity version required',
        detail: 'The fee write requires If-Match with the quotation entity version.',
        requestId: c.get('requestId'),
      });
    }
    const [quotationVersion] = ifMatch;

    const rawBody = await c.req.text();
    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return problem(c, {
        status: 400,
        code: 'INVALID_JSON',
        title: 'Invalid JSON body',
        detail: 'The request body is not valid JSON.',
        requestId: c.get('requestId'),
      });
    }
    const fingerprint = fingerprintFor(
      'POST',
      c.req.path,
      c.req.header('Content-Type') ?? null,
      rawBody,
    );

    const result = await guardedWrite(pool, user, key, fingerprint, async (scoped) => {
      const engagement = await resolveEngagement(scoped, projectId, engagementId);
      if (!engagement) {
        return { status: 404, body: { code: 'ENGAGEMENT_NOT_FOUND' } };
      }
      const current = await scoped.db
        .select({
          id: quotations.id,
          entityVersion: quotations.entityVersion,
          currency: quotations.currency,
        })
        .from(quotations)
        .where(and(eq(quotations.id, quotationId), eq(quotations.engagementId, engagementId)))
        .for('update')
        .limit(1);
      const quotation = current[0];
      if (!quotation) {
        return { status: 404, body: { code: 'QUOTATION_NOT_FOUND' } };
      }
      if (quotation.entityVersion !== quotationVersion) {
        return {
          status: 409,
          body: { code: 'ENTITY_VERSION_CONFLICT', currentEntityVersion: quotation.entityVersion },
        };
      }

      const req = body as Record<string, unknown>;
      const currency = quotation.currency ?? 'IDR';
      const feeItems = (req.feeItems as Record<string, unknown>[] | undefined) ?? [];

      await scoped.db.delete(quotationItems).where(eq(quotationItems.quotationId, quotation.id));

      for (const [index, fee] of feeItems.entries()) {
        const rate = moneyInputToColumn(fee.ratePerSqm, currency);
        const quantity = String(fee.area ?? 0);
        const lineTotal = rate
          ? moneyToDecimal(
              money(
                (parseMoneyInput(rate, currency).amount *
                  BigInt(Math.round(Number(quantity) * 100))) /
                  100n,
                currency,
              ),
            )
          : null;
        await scoped.db.insert(quotationItems).values({
          studioId: scoped.studioId,
          quotationId: quotation.id,
          lineOrder: String(index + 1),
          lineType: 'FEE',
          code: (fee.code as string) ?? null,
          description: (fee.label as string) ?? 'Fee',
          unit: 'sqm',
          quantity,
          unitRate: rate,
          lineSubtotal: lineTotal,
          lineTaxAmount: null,
          lineTotal,
          sourceType: null,
          sourceId: null,
        });
      }

      // Recompute the quotation totals from the fee items (no tax in scope).
      const totals = await scoped.db
        .select({ subtotal: quotationItems.lineSubtotal })
        .from(quotationItems)
        .where(eq(quotationItems.quotationId, quotation.id));
      const subtotalMinor = totals.reduce(
        (acc, t) => acc + (t.subtotal ? parseMoneyInput(t.subtotal, currency).amount : 0n),
        0n,
      );
      const discountMinor = req.discountAmount
        ? parseMoneyInput(req.discountAmount as string | number, currency).amount
        : 0n;
      const totalMinor = subtotalMinor - discountMinor;
      const subtotalText = moneyToDecimal(money(subtotalMinor, currency));
      const discountText = moneyToDecimal(money(discountMinor, currency));
      const totalText = moneyToDecimal(money(totalMinor, currency));

      await scoped.db
        .update(quotations)
        .set({
          subtotalAmount: subtotalText,
          discountAmount: discountText,
          discountPercent: req.discountPercent
            ? moneyToDecimal(parseMoneyInput(req.discountPercent as string | number, currency))
            : null,
          totalAmount: totalText,
          entityVersion: sql`gen_random_uuid()`,
        })
        .where(eq(quotations.id, quotation.id));

      const loaded = await loadQuotation(scoped, projectId, engagementId, quotation.id);
      const item = loaded[0];
      return {
        status: 201,
        etag: item?.row.entityVersion ?? null,
        body: {
          data: {
            quotation: item
              ? projectQuotation(
                  item.row,
                  projectCapabilities(user.role).canReadFinance?.enabled ?? false,
                  item.feeItems,
                  item.milestones,
                )
              : null,
            reviewLink: null,
          },
          meta: meta(c.get('requestId')),
        },
      };
    });

    if (result.outcome === 'conflict') {
      if (result.code === 'IDEMPOTENCY_KEY_REUSED') {
        return idempotencyReused(c);
      }
      if (result.code === 'ENTITY_VERSION_CONFLICT') {
        return entityConflict(c, null);
      }
      return problem(c, {
        status: result.status,
        code: result.code,
        title: 'Write rejected',
        detail: 'The quotation fee write was rejected by the server.',
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
  });

  // POST /projects/{id}/engagements/{engId}/quotations/{quotationId}/acceptance
  // — record guarded client acceptance (If-Match).
  app.post('/projects/:id/engagements/:engId/quotations/:quotationId/acceptance', async (c) => {
    const user = c.get('user');
    const projectId = c.req.param('id');
    const engagementId = c.req.param('engId');
    const quotationId = c.req.param('quotationId');

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
    const ifMatch = parseIfMatch(c.req.header('If-Match'));
    if (!ifMatch || ifMatch.length < 1) {
      return problem(c, {
        status: 400,
        code: 'MISSING_IF_MATCH',
        title: 'Entity version required',
        detail: 'The acceptance write requires If-Match with the quotation entity version.',
        requestId: c.get('requestId'),
      });
    }
    const [quotationVersion] = ifMatch;

    const rawBody = await c.req.text();
    const fingerprint = fingerprintFor(
      'POST',
      c.req.path,
      c.req.header('Content-Type') ?? null,
      rawBody,
    );

    const result = await guardedWrite(pool, user, key, fingerprint, async (scoped) => {
      const engagement = await resolveEngagement(scoped, projectId, engagementId);
      if (!engagement) {
        return { status: 404, body: { code: 'ENGAGEMENT_NOT_FOUND' } };
      }
      const current = await scoped.db
        .select({
          id: quotations.id,
          entityVersion: quotations.entityVersion,
        })
        .from(quotations)
        .where(and(eq(quotations.id, quotationId), eq(quotations.engagementId, engagementId)))
        .for('update')
        .limit(1);
      const quotation = current[0];
      if (!quotation) {
        return { status: 404, body: { code: 'QUOTATION_NOT_FOUND' } };
      }
      if (quotation.entityVersion !== quotationVersion) {
        return {
          status: 409,
          body: {
            code: 'ENTITY_VERSION_CONFLICT',
            currentEntityVersion: quotation.entityVersion,
          },
        };
      }
      await scoped.db
        .update(quotations)
        .set({
          status: 'ACCEPTED',
          lastAcceptedAt: new Date(),
          entityVersion: sql`gen_random_uuid()`,
        })
        .where(eq(quotations.id, quotation.id));

      const loaded = await loadQuotation(scoped, projectId, engagementId, quotation.id);
      const item = loaded[0];
      return {
        status: 201,
        etag: item?.row.entityVersion ?? null,
        body: {
          data: {
            quotation: item
              ? projectQuotation(
                  item.row,
                  projectCapabilities(user.role).canReadFinance?.enabled ?? false,
                  item.feeItems,
                  item.milestones,
                )
              : null,
            reviewLink: null,
          },
          meta: meta(c.get('requestId')),
        },
      };
    });

    if (result.outcome === 'conflict') {
      if (result.code === 'IDEMPOTENCY_KEY_REUSED') {
        return idempotencyReused(c);
      }
      if (result.code === 'ENTITY_VERSION_CONFLICT') {
        return entityConflict(c, null);
      }
      return problem(c, {
        status: result.status,
        code: result.code,
        title: 'Write rejected',
        detail: 'The quotation acceptance write was rejected by the server.',
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
  });
}
