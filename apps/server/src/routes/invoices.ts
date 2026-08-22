/**
 * Engagement-scoped invoice routes (SOL-28 revision 7).
 *
 * Invoice reads and collection-control metadata are engagement-scoped and
 * open. Invoice draft and issue writes carry the SOL-25 tax snapshot contract
 * and stay capability-disabled until SOL-25's approved contract lands
 * (`canWriteInvoiceDraft`, `canIssueInvoice`). Payment recording stays
 * permanently disabled (SOL-20, A-010): the amount/date/method payload cannot
 * represent cash, PPh, and retensi separately, so `canRecordInvoicePayment`
 * is false and the write returns `403` with the reason.
 *
 * Money wire: `ProjectFinanceInvoice` declares NUMBER-form money, so the
 * server emits `RawDecimal` via `serializeJson` and derives the `*Label`
 * twins from the same `numeric(20,2)` value.
 */

import { money, moneyFromDecimal, moneyToDecimal } from '@stdio/core';
import { schema } from '@stdio/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Hono } from 'hono';
import type { Pool } from 'pg';
import type { ServerEnv } from '../app';
import { projectCapabilities } from '../capabilities';
import { type Db, withStudioTx } from '../context/db';
import { capabilityDenied, resolveEngagement } from '../guards';
import { etagFor, meta, problem } from '../http';
import { jsonResponse, moneyNumber, RawDecimal } from '../money';
import { dateLabel, moneyLabel, statusLabel } from '../projections';

const { invoices, invoicePayments, invoiceReceivableComponents, users } = schema;

type InvoiceRow = {
  id: string;
  invoiceNumber: string;
  displayNumber: string | null;
  clientId: string;
  projectId: string | null;
  engagementId: string | null;
  billingBasis: string | null;
  status: string;
  currency: string;
  issueDate: Date | null;
  dueDate: Date | null;
  issuedAt: Date | null;
  totalAmount: string | null;
  taxAmount: string | null;
  taxMode: string;
  collectionStatus: string;
  collectionNote: string | null;
  collectionOwnerId: string | null;
  collectionReminderDate: string | null;
  entityVersion: string;
  updatedAt: Date;
};

type PaymentRow = {
  id: string;
  amount: string;
  paidAt: Date;
  method: string;
  reference: string | null;
};

type ReceivableRow = {
  id: string;
  kind: string;
  amount: string;
  settledAmount: string;
};

function moneyLabelOf(value: string | null, currency: string): string | null {
  return moneyLabel(value, currency);
}

/** Projects one invoice row into the contract `ProjectFinanceInvoice` shape. */
function projectInvoice(
  row: InvoiceRow,
  canReadFinance: boolean,
  payments: PaymentRow[],
  components: ReceivableRow[],
  collectionOwner: { id: string; name: string } | null,
): Record<string, unknown> {
  const currency = row.currency ?? 'IDR';
  const num = (value: string | null) => (canReadFinance ? moneyNumber(value, currency) : null);
  const label = (value: string | null) => (canReadFinance ? moneyLabelOf(value, currency) : null);

  const paidMinor = payments.reduce(
    (acc, p) => acc + (p.amount ? moneyFromDecimal(p.amount, currency).amount : 0n),
    0n,
  );
  const totalMinor = row.totalAmount ? moneyFromDecimal(row.totalAmount, currency).amount : 0n;
  const outstandingMinor = totalMinor - paidMinor;
  const outstandingLabel = moneyLabel(
    moneyToDecimal(money(outstandingMinor < 0n ? 0n : outstandingMinor, currency)),
    currency,
  );
  // The wire amounts are NUMBER-form money: RawDecimal, never a bigint or a
  // float. The lens follows the existing canReadFinance masking.
  const canShowMoney = canReadFinance && row.totalAmount !== null;
  const moneyRaw = (minor: bigint): RawDecimal | null =>
    canShowMoney ? new RawDecimal(moneyToDecimal(money(minor, currency)), currency) : null;

  return {
    collectionNote: row.collectionNote ?? null,
    collectionOwner,
    collectionReminderDate: row.collectionReminderDate ?? null,
    collectionReminderDateLabel: row.collectionReminderDate ?? null,
    collectionStatus: row.collectionStatus,
    collectionStatusLabel: statusLabel(row.collectionStatus),
    dueDate: row.dueDate ? row.dueDate.toISOString() : new Date(0).toISOString(),
    dueDateLabel: dateLabel(row.dueDate),
    displayNumber: row.displayNumber ?? null,
    numberingLifecycle: null,
    entityVersion: row.entityVersion,
    id: row.id,
    invoiceNumber: row.invoiceNumber,
    issueDate: row.issueDate ? row.issueDate.toISOString() : new Date(0).toISOString(),
    issueDateLabel: dateLabel(row.issueDate),
    issuedAt: row.issuedAt ? row.issuedAt.toISOString() : null,
    milestoneId: null,
    progressCertificateId: null,
    outstandingAmount: moneyRaw(outstandingMinor < 0n ? 0n : outstandingMinor),
    outstandingAmountLabel: outstandingLabel,
    paidAmount: moneyRaw(paidMinor),
    paidAmountLabel: moneyLabel(moneyToDecimal(money(paidMinor, currency)), currency),
    receivableComponents: components.map((c) => ({
      amount: num(c.amount),
      amountLabel: label(c.amount),
      kind: c.kind,
      outstandingAmount: num(c.amount),
      outstandingAmountLabel: label(c.amount),
      settledAmount: num(c.settledAmount),
      settledAmountLabel: label(c.settledAmount),
    })),
    withholding: null,
    payments: payments.map((p) => ({
      id: p.id,
      amount: num(p.amount),
      amountLabel: label(p.amount),
      date: p.paidAt.toISOString(),
      dateLabel: dateLabel(p.paidAt),
      methodLabel: p.method,
    })),
    status: row.status,
    statusLabel: statusLabel(row.status),
    totalAmount: num(row.totalAmount),
    totalAmountLabel: label(row.totalAmount),
  };
}

async function loadInvoice(
  scoped: Db,
  projectId: string,
  engagementId: string,
  invoiceId?: string,
) {
  const where = invoiceId
    ? and(
        eq(invoices.id, invoiceId),
        eq(invoices.projectId, projectId),
        eq(invoices.engagementId, engagementId),
      )
    : and(eq(invoices.projectId, projectId), eq(invoices.engagementId, engagementId));
  const rows = await scoped.db
    .select({
      id: invoices.id,
      invoiceNumber: invoices.invoiceNumber,
      displayNumber: invoices.displayNumber,
      clientId: invoices.clientId,
      projectId: invoices.projectId,
      engagementId: invoices.engagementId,
      billingBasis: invoices.billingBasis,
      status: invoices.status,
      currency: invoices.currency,
      issueDate: invoices.issueDate,
      dueDate: invoices.dueDate,
      issuedAt: invoices.issuedAt,
      totalAmount: invoices.totalAmount,
      taxAmount: invoices.taxAmount,
      taxMode: invoices.taxMode,
      collectionStatus: invoices.collectionStatus,
      collectionNote: invoices.collectionNote,
      collectionOwnerId: invoices.collectionOwnerId,
      collectionReminderDate: invoices.collectionReminderDate,
      entityVersion: invoices.entityVersion,
      updatedAt: invoices.updatedAt,
    })
    .from(invoices)
    .where(where)
    .orderBy(sql`${invoices.issueDate} desc`);

  const ids = rows.map((r) => r.id);
  const payments = ids.length
    ? await scoped.db
        .select({
          id: invoicePayments.id,
          invoiceId: invoicePayments.invoiceId,
          amount: invoicePayments.amount,
          paidAt: invoicePayments.paidAt,
          method: invoicePayments.method,
          reference: invoicePayments.reference,
        })
        .from(invoicePayments)
        .where(inArray(invoicePayments.invoiceId, ids))
        .orderBy(sql`${invoicePayments.paidAt} desc`)
    : [];
  const paymentsByInvoice = new Map<string, PaymentRow[]>();
  for (const p of payments) {
    const list = paymentsByInvoice.get(p.invoiceId) ?? [];
    list.push(p);
    paymentsByInvoice.set(p.invoiceId, list);
  }

  const components = ids.length
    ? await scoped.db
        .select({
          id: invoiceReceivableComponents.id,
          invoiceId: invoiceReceivableComponents.invoiceId,
          kind: invoiceReceivableComponents.kind,
          amount: invoiceReceivableComponents.amount,
          settledAmount: invoiceReceivableComponents.settledAmount,
        })
        .from(invoiceReceivableComponents)
        .where(inArray(invoiceReceivableComponents.invoiceId, ids))
    : [];
  const componentsByInvoice = new Map<string, ReceivableRow[]>();
  for (const c of components) {
    const list = componentsByInvoice.get(c.invoiceId) ?? [];
    list.push(c);
    componentsByInvoice.set(c.invoiceId, list);
  }

  const ownerIds = [
    ...new Set(rows.map((r) => r.collectionOwnerId).filter((id): id is string => !!id)),
  ];
  const ownerRows = ownerIds.length
    ? await scoped.db
        .select({ id: users.id, name: users.name })
        .from(users)
        .where(inArray(users.id, ownerIds))
    : [];
  const ownerById = new Map(ownerRows.map((o) => [o.id, o]));

  return rows.map((row) => ({
    row,
    payments: paymentsByInvoice.get(row.id) ?? [],
    components: componentsByInvoice.get(row.id) ?? [],
    collectionOwner: row.collectionOwnerId ? (ownerById.get(row.collectionOwnerId) ?? null) : null,
  }));
}

/** Registers the engagement-scoped invoice routes on `app`. */
export function registerInvoiceRoutes(app: Hono<ServerEnv>, pool: Pool): void {
  // GET /projects/{id}/engagements/{engId}/invoices — the engagement register.
  app.get('/projects/:id/engagements/:engId/invoices', async (c) => {
    const user = c.get('user');
    const projectId = c.req.param('id');
    const engagementId = c.req.param('engId');
    const capabilities = projectCapabilities(user.role);

    const result = await withStudioTx(pool, user, async (scoped) => {
      const engagement = await resolveEngagement(scoped, projectId, engagementId);
      if (!engagement) {
        return { status: 404 as const };
      }
      const loaded = await loadInvoice(scoped, projectId, engagementId);
      return {
        status: 200 as const,
        data: {
          invoices: loaded.map(({ row, payments, components, collectionOwner }) =>
            projectInvoice(
              row,
              capabilities.canReadFinance.enabled,
              payments,
              components,
              collectionOwner,
            ),
          ),
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

  // GET /projects/{id}/engagements/{engId}/invoices/{invoiceId} — detail.
  app.get('/projects/:id/engagements/:engId/invoices/:invoiceId', async (c) => {
    const user = c.get('user');
    const projectId = c.req.param('id');
    const engagementId = c.req.param('engId');
    const invoiceId = c.req.param('invoiceId');
    const capabilities = projectCapabilities(user.role);

    const result = await withStudioTx(pool, user, async (scoped) => {
      const engagement = await resolveEngagement(scoped, projectId, engagementId);
      if (!engagement) {
        return { status: 404 as const };
      }
      const loaded = await loadInvoice(scoped, projectId, engagementId, invoiceId);
      const item = loaded[0];
      if (!item) {
        return { status: 404 as const };
      }
      return {
        status: 200 as const,
        data: {
          invoice: projectInvoice(
            item.row,
            capabilities.canReadFinance.enabled,
            item.payments,
            item.components,
            item.collectionOwner,
          ),
        },
        etag: item.row.entityVersion,
      };
    });

    if (result.status === 404) {
      return problem(c, {
        status: 404,
        code: 'INVOICE_NOT_FOUND',
        title: 'Invoice not found',
        detail: 'The invoice does not exist on this engagement.',
        requestId: c.get('requestId'),
      });
    }
    const response = jsonResponse({ data: result.data, meta: meta(c.get('requestId')) });
    if (result.etag) {
      response.headers.set('ETag', etagFor(result.etag));
    }
    return response;
  });

  // POST /projects/{id}/engagements/{engId}/invoices/{invoiceId}/collection
  // — collection follow-up metadata. This is control data, not a money write
  // (SOL-6); it stays open while draft/issue/payment stay denied.
  app.post('/projects/:id/engagements/:engId/invoices/:invoiceId/collection', async (c) => {
    const user = c.get('user');
    const projectId = c.req.param('id');
    const engagementId = c.req.param('engId');
    const invoiceId = c.req.param('invoiceId');

    const capability = projectCapabilities(user.role).canUpdateInvoiceCollection;
    if (!capability.enabled) {
      return capabilityDenied(c, capability);
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
    const req = body as Record<string, unknown>;

    const result = await withStudioTx(pool, user, async (scoped) => {
      const engagement = await resolveEngagement(scoped, projectId, engagementId);
      if (!engagement) {
        return { status: 404 as const };
      }
      const current = await scoped.db
        .select({
          id: invoices.id,
          entityVersion: invoices.entityVersion,
        })
        .from(invoices)
        .where(and(eq(invoices.id, invoiceId), eq(invoices.engagementId, engagementId)))
        .for('update')
        .limit(1);
      const invoice = current[0];
      if (!invoice) {
        return { status: 404 as const };
      }
      await scoped.db
        .update(invoices)
        .set({
          collectionStatus: (req.collectionStatus as string) ?? 'NONE',
          collectionNote: (req.collectionNote as string) ?? null,
          collectionOwnerId: (req.collectionOwnerId as string) ?? null,
          collectionReminderDate: (req.collectionReminderDate as string) ?? null,
          entityVersion: sql`gen_random_uuid()`,
        })
        .where(eq(invoices.id, invoice.id));

      const loaded = await loadInvoice(scoped, projectId, engagementId, invoice.id);
      const item = loaded[0];
      return {
        status: 200 as const,
        data: {
          invoice: item
            ? projectInvoice(
                item.row,
                projectCapabilities(user.role).canReadFinance.enabled,
                item.payments,
                item.components,
                item.collectionOwner,
              )
            : null,
        },
        etag: item?.row.entityVersion ?? null,
      };
    });

    if (result.status === 404) {
      return problem(c, {
        status: 404,
        code: 'INVOICE_NOT_FOUND',
        title: 'Invoice not found',
        detail: 'The invoice does not exist on this engagement.',
        requestId: c.get('requestId'),
      });
    }
    const response = jsonResponse({ data: result.data, meta: meta(c.get('requestId')) });
    if (result.etag) {
      response.headers.set('ETag', etagFor(result.etag));
    }
    return response;
  });

  // POST /projects/{id}/engagements/{engId}/invoices/:invoiceId/draft
  // — capability-gated: enabled for OWNER since the SOL-25 slice merged.
  app.post('/projects/:id/engagements/:engId/invoices/:invoiceId/draft', async (c) => {
    const capability = projectCapabilities(c.get('user').role).canWriteInvoiceDraft;
    return capabilityDenied(c, capability);
  });

  // POST /projects/{id}/engagements/{engId}/invoices/{invoiceId}/issue
  // — capability-gated: enabled for OWNER since the SOL-25 slice merged.
  app.post('/projects/:id/engagements/:engId/invoices/:invoiceId/issue', async (c) => {
    const capability = projectCapabilities(c.get('user').role).canIssueInvoice;
    return capabilityDenied(c, capability);
  });

  // POST /projects/{id}/engagements/{engId}/invoices/{invoiceId}/payment
  // — permanently disabled (SOL-20 defers PPh; A-010 leaves retensi timing to
  // an accountant). The amount/date/method payload cannot represent cash, PPh,
  // and retensi separately.
  app.post('/projects/:id/engagements/:engId/invoices/:invoiceId/payment', async (c) => {
    const capability = projectCapabilities(c.get('user').role).canRecordInvoicePayment;
    return capabilityDenied(c, capability);
  });
}
