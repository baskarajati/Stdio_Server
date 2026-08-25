/**
 * Engagement-scoped invoice routes (SOL-28 revision 7).
 *
 * Invoice reads and collection-control metadata are engagement-scoped and
 * open. Invoice draft and issue writes carry the SOL-25 tax snapshot contract
 * and stay capability-denied until SOL-25's approved contract lands
 * (`canWriteInvoiceDraft`, `canIssueInvoice`). The split-payment write
 * (SOL-132 CEO confirmation `79974dba`, amended by ruling SOL-149) is
 * OWNER-gated: it records the gross settled, the entered PPh and retensi
 * amounts, the entered percent metadata and the exact cash that arrived on
 * one row of `invoice_payments`. The write is amount-first (SOL-149 R2):
 * `pphAmount` and `retensiAmount` are entered facts; `pphPercent` and
 * `retensiPercent` are unverified metadata and never arithmetic inputs.
 * Payments require an issued invoice and cumulative cash at or below the
 * invoice total (SOL-149 R5b).
 *
 * Money wire: `ProjectFinanceInvoice` declares NUMBER-form money, so the
 * server emits `RawDecimal` via `serializeJson` and derives the `*Label`
 * twins from the same `numeric(20,2)` value.
 */

import {
  MoneyInputError,
  money,
  moneyFromDecimal,
  moneyOutput,
  moneyToDecimal,
  parseStrictMoneyInput,
} from '@stdio/core';
import { schema } from '@stdio/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Hono } from 'hono';
import type { Pool } from 'pg';
import type { ServerEnv } from '../app';
import { projectCapabilities } from '../capabilities';
import { type Db, withStudioTx } from '../context/db';
import {
  capabilityDenied,
  fingerprintFor,
  guardedWrite,
  idempotencyReused,
  requireIdempotencyKey,
  resolveEngagement,
} from '../guards';
import { etagFor, meta, problem } from '../http';
import { jsonResponse, moneyNumber, RawDecimal } from '../money';
import { dateLabel, moneyLabel, receivableComponentLabel, statusLabel } from '../projections';

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
      label: receivableComponentLabel(c.kind),
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
  // — SOL-132 split-payment write (CEO confirmation `79974dba`, amended by
  // ruling SOL-149). Amount-first: the payload carries the cash that arrived
  // plus optional entered split facts — grossAmount, pphAmount, retensiAmount
  // — and optional unverified percent metadata (pphPercent, retensiPercent),
  // which never drives arithmetic. Payments require an ISSUED (or PAID)
  // invoice, and cumulative cash may not exceed the invoice total (R5b).
  app.post('/projects/:id/engagements/:engId/invoices/:invoiceId/payment', async (c) => {
    const user = c.get('user');
    const projectId = c.req.param('id');
    const engagementId = c.req.param('engId');
    const invoiceId = c.req.param('invoiceId');

    const capability = projectCapabilities(user.role).canRecordInvoicePayment;
    if (!capability.enabled) {
      return capabilityDenied(c, capability);
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
    const req = (body ?? {}) as Record<string, unknown>;
    const fingerprint = fingerprintFor(
      'POST',
      c.req.path,
      c.req.header('Content-Type') ?? null,
      rawBody,
    );

    const result = await guardedWrite(
      pool,
      user,
      key,
      fingerprint,
      async (scoped) => {
        const engagement = await resolveEngagement(scoped, projectId, engagementId);
        if (!engagement) {
          return {
            status: 404,
            body: {
              code: 'ENGAGEMENT_NOT_FOUND',
              detail: 'The engagement does not exist on this project.',
            },
          };
        }
        const invoices_ = await scoped.db
          .select({
            id: invoices.id,
            status: invoices.status,
            currency: invoices.currency,
            totalAmount: invoices.totalAmount,
          })
          .from(invoices)
          .where(and(eq(invoices.id, invoiceId), eq(invoices.engagementId, engagementId)))
          .for('update')
          .limit(1);
        const invoice = invoices_[0];
        if (!invoice) {
          return {
            status: 404,
            body: {
              code: 'INVOICE_NOT_FOUND',
              detail: 'The invoice does not exist on this engagement.',
            },
          };
        }
        // SOL-149 R5b / D-007: receivables count from ISSUED onward. A payment
        // requires an issued invoice; DRAFT, VOIDED and unknown states are
        // rejected with the named code.
        if (invoice.status !== 'ISSUED' && invoice.status !== 'PAID') {
          return {
            status: 422,
            body: {
              code: 'PAYMENT_INVOICE_NOT_ISSUED',
              detail: `Payments require an issued invoice; this invoice is ${invoice.status}.`,
            },
          };
        }
        // --- Money stage: strict parse of the entered amounts. ---
        if (typeof req.amount !== 'string' && typeof req.amount !== 'number') {
          return {
            status: 422,
            body: moneyInvalid('amount must be a string or a number.'),
          };
        }
        let amountMinor: bigint;
        try {
          amountMinor = parseStrictMoneyInput(req.amount as string | number);
        } catch (error) {
          return { status: 422, body: moneyFromError(error) };
        }
        if (amountMinor <= 0n) {
          return {
            status: 422,
            body: {
              code: 'MONEY_OUT_OF_RANGE',
              detail: 'amount must be greater than zero.',
            },
          };
        }
        if (typeof req.date !== 'string' || Number.isNaN(Date.parse(req.date))) {
          return {
            status: 422,
            body: {
              code: 'PAYMENT_DATE_INVALID',
              detail: 'date must be an ISO 8601 date or timestamp.',
            },
          };
        }

        const hasSplit =
          req.grossAmount !== undefined ||
          req.pphAmount !== undefined ||
          req.retensiAmount !== undefined ||
          req.pphPercent !== undefined ||
          req.retensiPercent !== undefined;
        let grossMinor = amountMinor;
        let pphAmountMinor = 0n;
        let pphPercentText: string | null = null;
        let retensiAmountMinor = 0n;
        let retensiPercentText: string | null = null;

        if (hasSplit) {
          // SOL-149 R2: the split inputs are the entered amounts. The gross
          // is the invoiced amount the client settled; PPh and retensi are
          // the withheld parts stated by the payee (bukti potong / berita
          // acara) and the contract. Nothing here is percent-derived.
          if (req.grossAmount === undefined) {
            return {
              status: 422,
              body: {
                code: 'PAYMENT_GROSS_REQUIRED',
                detail:
                  'A split payment requires grossAmount; the entered PPh and retensi amounts settle against the gross.',
              },
            };
          }
          try {
            grossMinor = parseStrictMoneyInput(req.grossAmount as string | number);
          } catch (error) {
            return { status: 422, body: moneyFromError(error) };
          }
          for (const [field, target] of [
            ['pphAmount', 'pph'],
            ['retensiAmount', 'retensi'],
          ] as const) {
            const raw = req[field];
            if (raw === undefined) continue;
            if (typeof raw !== 'string' && typeof raw !== 'number') {
              return {
                status: 422,
                body: moneyInvalid(`${field} must be a string or a number.`),
              };
            }
            let minor: bigint;
            try {
              minor = parseStrictMoneyInput(raw as string | number);
            } catch (error) {
              return { status: 422, body: moneyFromError(error) };
            }
            if (minor < 0n) {
              return {
                status: 422,
                body: {
                  code: 'MONEY_OUT_OF_RANGE',
                  detail: `${field} must not be negative.`,
                },
              };
            }
            if (target === 'pph') {
              pphAmountMinor = minor;
            } else {
              retensiAmountMinor = minor;
            }
          }
          // Percent fields are unverified metadata (SOL-149 R2, A-010): the
          // grammar is validated for storage, but no amount is derived from
          // them and they are never checked against the entered amounts.
          for (const [field, target] of [
            ['pphPercent', 'pph'],
            ['retensiPercent', 'retensi'],
          ] as const) {
            const raw = req[field];
            if (raw === undefined) continue;
            let percentText: string;
            if (typeof raw === 'string') {
              percentText = raw;
            } else if (typeof raw === 'number' && Number.isFinite(raw)) {
              percentText = raw.toFixed(4);
            } else {
              return {
                status: 422,
                body: {
                  code: 'PAYMENT_PERCENT_INVALID',
                  detail: `${field} must be a decimal string or a finite number.`,
                },
              };
            }
            if (!/^\d+(\.\d{1,4})?$/.test(percentText)) {
              return {
                status: 422,
                body: {
                  code: 'PAYMENT_PERCENT_INVALID',
                  detail: `${field} must be a decimal with up to four fractional digits.`,
                },
              };
            }
            const scaled = scalePercentToBasisPoints(percentText);
            if (scaled < 0n || scaled > 1000000n) {
              return {
                status: 422,
                body: {
                  code: 'PAYMENT_PERCENT_OUT_OF_RANGE',
                  detail: `${field} must be between 0 and 100.`,
                },
              };
            }
            if (target === 'pph') {
              pphPercentText = percentText;
            } else {
              retensiPercentText = percentText;
            }
          }
          const derivedCashMinor = grossMinor - pphAmountMinor - retensiAmountMinor;
          if (derivedCashMinor < 0n) {
            return {
              status: 422,
              body: {
                code: 'PAYMENT_SPLIT_OVER_GROSS',
                detail: 'PPh plus retensi must not exceed the gross amount.',
                grossAmount: moneyOutput(grossMinor),
                derivedCash: moneyOutput(derivedCashMinor),
              },
            };
          }
          if (derivedCashMinor !== amountMinor) {
            return {
              status: 422,
              body: {
                code: 'PAYMENT_SPLIT_MISMATCH',
                detail: 'amount must equal gross minus PPh minus retensi.',
                amount: moneyOutput(amountMinor),
                expectedCash: moneyOutput(derivedCashMinor),
              },
            };
          }
        }

        // SOL-149 R5b: cumulative cash after this payment must not exceed the
        // invoice total. The `FOR UPDATE` invoice-row lock serializes
        // concurrent payments, so the summed cash is read after the lock.
        if (invoice.totalAmount === null) {
          return {
            status: 422,
            body: {
              code: 'INVOICE_TOTAL_REQUIRED',
              detail: 'A payment requires an invoice total; this invoice has none.',
            },
          };
        }
        const currency = invoice.currency ?? 'IDR';
        const totalMinor = moneyFromDecimal(invoice.totalAmount, currency).amount;
        const paidRows = await scoped.db
          .select({ amount: invoicePayments.amount })
          .from(invoicePayments)
          .where(eq(invoicePayments.invoiceId, invoice.id));
        const cumulativeMinor = paidRows.reduce(
          (acc, p) => acc + (p.amount ? moneyFromDecimal(p.amount, currency).amount : 0n),
          0n,
        );
        if (cumulativeMinor + amountMinor > totalMinor) {
          return {
            status: 422,
            body: {
              code: 'PAYMENT_OVER_TOTAL',
              detail: 'This payment would exceed the invoice total.',
              totalAmount: moneyOutput(totalMinor),
              paidAmount: moneyOutput(cumulativeMinor),
              outstandingAmount: moneyOutput(totalMinor - cumulativeMinor),
              attemptedAmount: moneyOutput(amountMinor),
            },
          };
        }

        const inserted = await scoped.db
          .insert(invoicePayments)
          .values({
            studioId: scoped.studioId,
            invoiceId: invoice.id,
            amount: moneyOutput(amountMinor),
            paidAt: new Date(req.date as string),
            method: typeof req.paymentMethod === 'string' ? req.paymentMethod : 'OTHER',
            reference: typeof req.reference === 'string' ? req.reference : null,
            ...(hasSplit
              ? {
                  grossAmount: moneyOutput(grossMinor),
                  pphAmount: moneyOutput(pphAmountMinor),
                  pphPercent: pphPercentText,
                  retensiAmount: moneyOutput(retensiAmountMinor),
                  retensiPercent: retensiPercentText,
                }
              : { grossAmount: moneyOutput(grossMinor) }),
          })
          .returning({ id: invoicePayments.id });
        if (!inserted[0]) {
          throw new Error('The payment insert returned no row.');
        }

        const loaded = await loadInvoice(scoped, projectId, engagementId, invoice.id);
        const item = loaded[0];
        return {
          status: 201,
          etag: item?.row.entityVersion ?? null,
          body: {
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
            meta: { ...meta(c.get('requestId')), idempotentReplay: false },
          },
        };
      },
      {
        requestId: c.get('requestId'),
        method: 'POST',
        path: c.req.path,
        flipReplayIdempotent: true,
        replayStatus: 200,
      },
    );

    if (result.outcome === 'conflict') {
      if (result.code === 'IDEMPOTENCY_KEY_REUSED') {
        return idempotencyReused(c);
      }
      return problem(c, {
        status: result.status,
        code: result.code,
        title: 'Write rejected',
        detail: 'The payment write was rejected by the server.',
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

/** Maps one `MoneyInputError` to its contract 422 handler problem. */
function moneyFromError(error: unknown): { code: string; detail: string } {
  const code = error instanceof MoneyInputError ? error.code : 'MONEY_FORMAT_INVALID';
  const detail = error instanceof Error ? error.message : 'Money input invalid.';
  return { code, detail };
}

function moneyInvalid(detail: string): { code: string; detail: string } {
  return { code: 'MONEY_FORMAT_INVALID', detail };
}

/**
 * Scales a percent decimal with up to four fractional digits to
 * parts-per-million (percent x 10^4), exactly:
 * "2" -> 20000, "2.5" -> 25000, "0.0001" -> 1, "100" -> 1000000.
 * SOL-149 R2: percents are unverified metadata. This scale is used only to
 * validate the stored 0..100 grammar, never to derive an amount.
 */
function scalePercentToBasisPoints(percentText: string): bigint {
  const [whole = '0', frac = ''] = percentText.split('.');
  const digits = `${whole || '0'}${frac || ''}`;
  return (BigInt(digits) * 10000n) / 10n ** BigInt(frac.length);
}
