/**
 * The SOL-25 revision-24 tax routes. Section 9.9 validation order on every
 * guarded path: auth -> 404 -> build gate -> replay -> schema -> If-Match ->
 * catalog tag -> rule resolution -> atomic write.
 *
 * Replay-before-precondition (section 9.8): the idempotency replay inside
 * `guardedWrite` fires before every precondition (If-Match, catalog tag), so
 * a retry with the original body returns the original response even when the
 * precondition has since changed. Rejections THROW `TaxWriteRejection`: the
 * throw rolls back the tenant transaction — including the idempotency row —
 * so a rejected attempt never consumes the Idempotency-Key (CEO condition 3,
 * N66).
 */

import { randomUUID } from 'node:crypto';

import { allocateByRatios, MoneyInputError, money } from '@stdio/core';
import { schema } from '@stdio/db';
import { and, eq } from 'drizzle-orm';
import type { Context, Hono } from 'hono';
import type { Pool } from 'pg';
import type { z } from 'zod';
import type { ServerEnv } from '../app';
import { projectCapabilities } from '../capabilities';
import { type Db, withStudioTx } from '../context/db';
import { fingerprintFor, guardedWrite, parseIfMatch, requireIdempotencyKey } from '../guards';
import { etagFor, meta, problem, requestBuildOf } from '../http';
import { jsonResponse } from '../money';
import {
  parseApplication,
  parseMoneyMinor,
  resolveApplication,
  validateDocumentLines,
} from './application';
import {
  issueBuildGate,
  newWriteBuildGate,
  requireNativeBuildHeader,
  requireRequestIdHeader,
  TAX_ISSUE_MINIMUM_NATIVE_BUILD,
} from './build-gate';
import { calculateForRule } from './calculate';
import { catalogEntityTag } from './catalog';
import { checkCatalogTag } from './catalog-guard';
import {
  reject,
  TaxWriteRejection,
  taxCatalogConflict,
  taxCatalogTagRequired,
  taxCatalogTagUnexpected,
  taxProblem,
  taxRecordingEvidenceInvalid,
  taxRuleCodeReserved,
  taxRuleModeConflict,
  taxRuleUnavailable,
} from './codes';
import {
  type InvoiceComponentRow,
  type InvoicePaymentRow,
  type InvoiceRow,
  invoiceWire,
  type QuotationItemRow,
  type QuotationMilestoneRow,
  type QuotationRow,
  type QuotationSiblingRow,
  quotationWire,
} from './documents';
import { minorFromDecimal, moneyText, supplierRecordingWire } from './projections';
import {
  findRuleVersion,
  latestStudioRule,
  projectTaxRule,
  resolveVerifiedForDate,
  studioCustomRules,
  type TaxRuleRow,
} from './rules';
import {
  customSnapshot,
  recordingSnapshot,
  type SnapshotAudit,
  type SnapshotRecord,
  verifiedSnapshot,
} from './snapshot';
import {
  customTaxRuleDraftSchema,
  issueOperationBodySchema,
  parseBody,
  parseContractDate,
  previewBodySchema,
  supplierTaxRecordingRequestSchema,
} from './validate';

const { taxRules, taxSnapshots, supplierTaxRecordings } = schema;

type TaxContext = Context<ServerEnv>;

/** The Jakarta date for document issue dates. */
function jakartaDateString(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

function newEntityVersion(): string {
  return randomUUID();
}

/** The `NativeWriteMeta` envelope with `idempotentReplay`. */
function writeMeta(
  c: TaxContext,
  replay: boolean,
  minimumSupportedBuild: number = 1,
): Record<string, unknown> {
  return {
    ...meta(c.get('requestId'), {
      minimumSupportedBuild,
      requestBuild: requestBuildOf(c),
    }),
    idempotentReplay: replay,
  };
}

/** Maps a thrown rejection or money error to the contract Problem. */
function taxErrorResponse(c: TaxContext, error: unknown): Response | null {
  if (error instanceof TaxWriteRejection) {
    return taxProblem(c, {
      status: error.status,
      code: error.code,
      title: error.title,
      detail: error.detail,
      ...(error.details ? { details: error.details } : {}),
    });
  }
  if (error instanceof MoneyInputError) {
    return taxProblem(c, {
      status: 422,
      code: error.code,
      title:
        error.code === 'MONEY_FORMAT_INVALID'
          ? 'Money format invalid'
          : error.code === 'MONEY_NOT_EXACT'
            ? 'Money not exact'
            : 'Money out of range',
      detail: error.message,
    });
  }
  return null;
}

/** The 409 the If-Match guard emits inside a guarded handler. */
function entityVersionConflict(currentEntityVersion: string): never {
  return reject({
    status: 409,
    code: 'ENTITY_VERSION_CONFLICT',
    title: 'Entity version conflict',
    detail: 'The If-Match entity version does not match the current entity. Refetch and retry.',
    details: { draftPreserved: true, currentEntityVersion },
  });
}

/** The effective-range check for custom rule versions. */
function checkEffectiveRange(effectiveFrom: string, effectiveTo: string | null): void {
  if (effectiveTo !== null && effectiveTo < effectiveFrom) {
    reject({
      status: 422,
      code: 'INVALID_EFFECTIVE_RANGE',
      title: 'Invalid effective range',
      detail: 'effectiveTo must not be earlier than effectiveFrom.',
    });
  }
}

/** Registers the tax routes on `app`. */
export function registerTaxRoutes(app: Hono<ServerEnv>, pool: Pool): void {
  // GET /tax-rules/resolve — the studio rule catalog for one issue date.
  app.get('/tax-rules/resolve', async (c) => {
    const user = c.get('user');
    const issueDate = c.req.query('documentIssueDate');
    const currency = c.req.query('documentCurrency');
    if (!issueDate) {
      return problem(c, {
        status: 400,
        code: 'MISSING_DOCUMENT_ISSUE_DATE',
        title: 'Missing document issue date',
        detail: 'The documentIssueDate query parameter is required.',
        requestId: c.get('requestId'),
      });
    }
    if (currency !== 'IDR') {
      return problem(c, {
        status: 422,
        code: 'INVALID_DOCUMENT_CURRENCY',
        title: 'Invalid document currency',
        detail: 'documentCurrency must be IDR.',
        requestId: c.get('requestId'),
      });
    }
    let date: string;
    try {
      date = parseContractDate(issueDate, 'documentIssueDate');
    } catch (error) {
      return (
        taxErrorResponse(c, error) ??
        problem(c, {
          status: 422,
          code: 'INVALID_DATE',
          title: 'Invalid date',
          detail: String((error as Error).message),
          requestId: c.get('requestId'),
        })
      );
    }

    try {
      const result = await withStudioTx(pool, user, async (scoped) => {
        const [resolved, customs, tag] = await Promise.all([
          resolveVerifiedForDate(scoped, date),
          studioCustomRules(scoped),
          catalogEntityTag(scoped),
        ]);
        return {
          tag,
          body: {
            data: {
              documentIssueDate: date,
              documentCurrency: 'IDR',
              resolvedVerifiedRule: resolved ? projectTaxRule(resolved) : null,
              customRules: customs.map(projectTaxRule),
            },
            meta: meta(c.get('requestId'), { requestBuild: requestBuildOf(c) }),
          },
        };
      });
      const response = jsonResponse(result.body);
      response.headers.set('ETag', etagFor(result.tag));
      return response;
    } catch (error) {
      const mapped = taxErrorResponse(c, error);
      if (mapped) {
        return mapped;
      }
      return problem(c, {
        status: 500,
        code: 'TAX_RULE_REGISTER_INVALID',
        title: 'Tax rule register invalid',
        detail: 'The verified register has overlapping versions for this date. Contact support.',
        requestId: c.get('requestId'),
      });
    }
  });

  // POST /tax-calculations — stateless preview, no persistence.
  app.post('/tax-calculations', async (c) => {
    const requiredHeader = requireNativeBuildHeader(c);
    if (requiredHeader) {
      return requiredHeader;
    }
    const requestIdCheck = requireRequestIdHeader(c);
    if (requestIdCheck) {
      return requestIdCheck;
    }
    const user = c.get('user');
    const rawBody = await c.req.text();
    const catalogTag = c.req.header('x-stdio-tax-catalog-tag');
    if (!catalogTag) {
      return problem(c, {
        status: 400,
        code: 'TAX_CATALOG_TAG_REQUIRED',
        title: 'Tax catalog tag required',
        detail: 'This operation requires the x-stdio-tax-catalog-tag header.',
        requestId: c.get('requestId'),
      });
    }

    try {
      const body = parseBody(previewBodySchema, rawBody);
      parseContractDate(body.documentIssueDate, 'documentIssueDate');
      const consideration = parseMoneyMinor(body.considerationBeforeDiscount);
      const discount = parseMoneyMinor(body.discount);
      const app = parseApplication(body.taxApplication);

      return await withStudioTx(pool, user, async (scoped) => {
        const tag = await catalogEntityTag(scoped);
        if (tag !== catalogTag) {
          // N64: a stale or foreign tag fails with the identical non-leaking
          // 409 body; the current tag is never disclosed.
          reject(taxCatalogConflict());
        }
        const resolved = await resolveApplication(scoped, app, body.documentIssueDate, 'IDR');
        if (resolved.branch === 'recording') {
          reject(taxRuleModeConflict());
        }
        const outcome = calculateForRule(
          resolved.rule,
          moneyText(consideration),
          moneyText(discount),
        );
        return jsonResponse({
          data: { result: outcome.result },
          meta: meta(c.get('requestId'), { requestBuild: requestBuildOf(c) }),
        });
      });
    } catch (error) {
      const mapped = taxErrorResponse(c, error);
      if (mapped) {
        return mapped;
      }
      throw error;
    }
  });

  // POST /tax-rules/custom — immutable studio rule version 1.
  app.post('/tax-rules/custom', async (c) => {
    return guardedTaxWrite(c, pool, '/tax-rules/custom', async (scoped, rawBody) => {
      const tag = await catalogEntityTag(scoped);
      const ifMatch = parseIfMatch(c.req.header('If-Match'));
      if (ifMatch === null || ifMatch[0] !== tag) {
        // Section 9.2 / N60: the If-Match guard on version-1 creation is the
        // catalog tag; a stale or foreign tag is the identical non-leaking
        // 409 TAX_RULE_CATALOG_CONFLICT, never an entity-version conflict.
        reject(taxCatalogConflict());
      }
      const draft = parseBody(customTaxRuleDraftSchema, rawBody);
      if (draft.code === 'PPN_STANDARD_2025') {
        reject(taxRuleCodeReserved());
      }
      const effectiveFrom = parseContractDate(draft.effectiveFrom, 'effectiveFrom');
      const effectiveTo =
        draft.effectiveTo === null ? null : parseContractDate(draft.effectiveTo, 'effectiveTo');
      checkEffectiveRange(effectiveFrom, effectiveTo);
      const fixedMinor =
        draft.calculationMode === 'FIXED_AMOUNT' ? parseMoneyMinor(draft.fixedAmount) : null;
      const ruleId = randomUUID();
      await insertCustomRule(scoped, {
        id: ruleId,
        version: 1,
        draft,
        effectiveFrom,
        effectiveTo,
        fixedMinor,
      });
      const newRow = await findRuleVersion(scoped, ruleId, 1);
      const newTag = await catalogEntityTag(scoped);
      return {
        status: 201,
        etag: newTag,
        body: {
          data: { rule: projectTaxRule(newRow as TaxRuleRow) },
          meta: writeMeta(c, false),
        },
      };
    });
  });

  // POST /tax-rules/custom/:ruleId/versions — append one immutable version.
  app.post('/tax-rules/custom/:ruleId/versions', async (c) => {
    const ruleId = c.req.param('ruleId');
    return guardedTaxWrite(
      c,
      pool,
      `/tax-rules/custom/${ruleId}/versions`,
      async (scoped, rawBody) => {
        const latest = await latestStudioRule(scoped, ruleId);
        if (!latest) {
          reject({
            status: 404,
            code: 'TAX_RULE_NOT_FOUND',
            title: 'Tax rule not found',
            detail: 'The tax rule does not exist or is not visible to this studio.',
          });
        }
        const ifMatch = parseIfMatch(c.req.header('If-Match'));
        if (ifMatch === null || ifMatch[0] !== latest.entityVersion) {
          entityVersionConflict(latest.entityVersion);
        }
        const draft = parseBody(customTaxRuleDraftSchema, rawBody);
        if (draft.code === 'PPN_STANDARD_2025') {
          reject(taxRuleCodeReserved());
        }
        if (draft.code !== latest.code) {
          reject({
            status: 422,
            code: 'TAX_RULE_CODE_MISMATCH',
            title: 'Tax rule code mismatch',
            detail: 'A new version cannot change the rule code.',
          });
        }
        const effectiveFrom = parseContractDate(draft.effectiveFrom, 'effectiveFrom');
        const effectiveTo =
          draft.effectiveTo === null ? null : parseContractDate(draft.effectiveTo, 'effectiveTo');
        checkEffectiveRange(effectiveFrom, effectiveTo);
        const fixedMinor =
          draft.calculationMode === 'FIXED_AMOUNT' ? parseMoneyMinor(draft.fixedAmount) : null;
        await insertCustomRule(scoped, {
          id: ruleId,
          version: latest.version + 1,
          draft,
          effectiveFrom,
          effectiveTo,
          fixedMinor,
        });
        const newRow = await findRuleVersion(scoped, ruleId, latest.version + 1);
        return {
          status: 201,
          etag: (newRow as TaxRuleRow).entityVersion,
          body: {
            data: { rule: projectTaxRule(newRow as TaxRuleRow) },
            meta: writeMeta(c, false),
          },
        };
      },
    );
  });

  // POST /purchase-orders/:id/supplier-tax-recordings — record supplier facts.
  app.post('/purchase-orders/:id/supplier-tax-recordings', async (c) => {
    const purchaseOrderId = c.req.param('id');
    return guardedTaxWrite(
      c,
      pool,
      `/purchase-orders/${purchaseOrderId}/supplier-tax-recordings`,
      async (scoped, rawBody) => {
        const poRows = await scoped.db
          .select({
            id: schema.purchaseOrders.id,
            vendorId: schema.purchaseOrders.vendorId,
            entityVersion: schema.purchaseOrders.entityVersion,
          })
          .from(schema.purchaseOrders)
          .where(eq(schema.purchaseOrders.id, purchaseOrderId))
          .limit(1);
        const purchaseOrder = poRows[0];
        if (!purchaseOrder) {
          reject({
            status: 404,
            code: 'PURCHASE_ORDER_NOT_FOUND',
            title: 'Purchase order not found',
            detail: 'The purchase order does not exist for this studio.',
          });
        }
        const ifMatch = parseIfMatch(c.req.header('If-Match'));
        if (ifMatch === null || ifMatch[0] !== purchaseOrder.entityVersion) {
          entityVersionConflict(purchaseOrder.entityVersion);
        }
        let request: z.infer<typeof supplierTaxRecordingRequestSchema>;
        try {
          request = parseBody(supplierTaxRecordingRequestSchema, rawBody);
        } catch (error) {
          // N10/N11: an IDR recording with evidence and a non-IDR recording
          // without evidence are `422 TAX_RECORDING_EVIDENCE_INVALID`, never
          // a generic 400. The reject() below escapes this catch.
          let evidenceViolation = false;
          try {
            const json = JSON.parse(rawBody) as Record<string, unknown>;
            const isIdr = json?.documentCurrency === 'IDR';
            const hasEvidence =
              json?.exchangeRateEvidence !== null && json?.exchangeRateEvidence !== undefined;
            evidenceViolation = isIdr ? hasEvidence : !hasEvidence;
          } catch {
            // Not JSON; the original INVALID_BODY stands.
          }
          if (
            error instanceof TaxWriteRejection &&
            error.code === 'INVALID_BODY' &&
            evidenceViolation
          ) {
            reject(taxRecordingEvidenceInvalid());
          }
          throw error;
        }
        const dppMinor = parseMoneyMinor(request.dppAmount);
        const taxMinor = parseMoneyMinor(request.taxAmount);
        const duplicateRows = await scoped.db
          .select({ id: supplierTaxRecordings.id })
          .from(supplierTaxRecordings)
          .where(
            and(
              eq(supplierTaxRecordings.purchaseOrderId, purchaseOrder.id),
              eq(supplierTaxRecordings.supplierId, purchaseOrder.vendorId),
              eq(
                supplierTaxRecordings.supplierDocumentReference,
                request.supplierDocumentReference,
              ),
            ),
          )
          .limit(1);
        if (duplicateRows[0]) {
          reject({
            status: 409,
            code: 'SUPPLIER_TAX_RECORDING_CONFLICT',
            title: 'Supplier tax recording conflict',
            detail:
              'A supplier tax recording with this supplier document reference already exists for the supplier.',
          });
        }
        const recordingId = randomUUID();
        await scoped.db.insert(supplierTaxRecordings).values({
          id: recordingId,
          studioId: scoped.studioId,
          purchaseOrderId: purchaseOrder.id,
          supplierId: purchaseOrder.vendorId,
          status: 'CUSTOM_UNVERIFIED',
          supplierDocumentReference: request.supplierDocumentReference,
          label: request.label,
          documentCurrency: request.documentCurrency,
          dppAmount: moneyText(dppMinor),
          taxAmount: moneyText(taxMinor),
          exchangeRateEvidence: request.exchangeRateEvidence,
          source: request.source,
          acceptedConfirmationText: request.acknowledgment.acceptedText,
          recordedById: scoped.user.id,
          recordedAt: new Date(),
        });
        const rows = await scoped.db
          .select()
          .from(supplierTaxRecordings)
          .where(eq(supplierTaxRecordings.id, recordingId))
          .limit(1);
        const row = rows[0];
        return {
          status: 201,
          etag: (row as { entityVersion: string }).entityVersion,
          body: {
            data: { supplierTaxRecording: supplierRecordingWire(row as never) },
            meta: writeMeta(c, false),
          },
        };
      },
    );
  });

  // POST /projects/:id/quotations/:quotationId/send — send with optional tax.
  app.post('/projects/:id/quotations/:quotationId/send', async (c) => {
    const projectId = c.req.param('id');
    const quotationId = c.req.param('quotationId');
    return issueOperation(c, pool, {
      projectId,
      documentId: quotationId,
      documentType: 'QUOTATION',
      kindLabel: 'quotation',
      notFoundCode: 'QUOTATION_NOT_FOUND',
      capabilityKey: 'canWriteQuotation',
      resolveDocument: (scoped) => resolveQuotation(scoped, projectId, quotationId),
      documentLineIds: async (scoped, documentRow) => {
        const items = await loadQuotationItems(scoped, (documentRow as QuotationRow).id);
        return items.map((item) => item.id);
      },
      amounts: async (scoped, documentRow, lineSelections) => {
        const quotation = documentRow as QuotationRow;
        const items = await loadQuotationItems(scoped, quotation.id);
        const selectedAmounts = lineSelections
          .filter((line) => line.selected)
          .map((line) => {
            const item = items.find((candidate) => candidate.id === line.lineId);
            return minorFromDecimal(item?.lineSubtotal ?? item?.lineTotal ?? '0');
          });
        const consideration = selectedAmounts.reduce((sum, amount) => sum + amount, 0n);
        const discount =
          quotation.discountAmount === null
            ? 0n
            : allocateByRatios(
                money(minorFromDecimal(quotation.discountAmount), 'IDR'),
                selectedAmounts,
              ).reduce((sum, share) => sum + share.amount, 0n);
        return { considerationMinor: consideration, discountMinor: discount };
      },
      applyWrite: async (scoped, documentRow, application, taxMinor, totalMinor) => {
        const quotation = documentRow as QuotationRow;
        const set: Record<string, unknown> = {
          status: 'SENT',
          entityVersion: newEntityVersion(),
        };
        if (application) {
          set.taxAmount = moneyText(taxMinor);
          set.totalAmount = moneyText(totalMinor);
        }
        await scoped.db
          .update(schema.quotations)
          .set(set)
          .where(eq(schema.quotations.id, quotation.id));
        const rows = await scoped.db
          .select()
          .from(schema.quotations)
          .where(eq(schema.quotations.id, quotation.id))
          .limit(1);
        return rows[0] as never;
      },
      projectResponse: async (scoped, row, application, _audit, snapshotPayload) => {
        const quotation = row as QuotationRow;
        const [items, milestones, siblings] = await Promise.all([
          loadQuotationItems(scoped, quotation.id),
          loadQuotationMilestones(scoped, quotation.id),
          loadQuotationSiblings(scoped, quotation.id),
        ]);
        return {
          quotation: quotationWire(quotation, items, milestones, siblings, true),
          reviewLink: null,
          taxSnapshot: application ? snapshotPayload : null,
        };
      },
    });
  });

  // POST /projects/:id/finance/invoices/:invoiceId/issue — issue with optional tax.
  app.post('/projects/:id/finance/invoices/:invoiceId/issue', async (c) => {
    const projectId = c.req.param('id');
    const invoiceId = c.req.param('invoiceId');
    return issueOperation(c, pool, {
      projectId,
      documentId: invoiceId,
      documentType: 'COMMERCIAL_INVOICE',
      kindLabel: 'invoice',
      notFoundCode: 'INVOICE_NOT_FOUND',
      capabilityKey: 'canIssueInvoice',
      resolveDocument: (scoped) => resolveInvoice(scoped, projectId, invoiceId),
      documentLineIds: async () => [],
      amounts: async (_scoped, documentRow) => {
        const invoice = documentRow as InvoiceRow;
        if (invoice.totalAmount === null) {
          reject({
            status: 422,
            code: 'INVOICE_TOTAL_REQUIRED',
            title: 'Invoice total required',
            detail: 'A draft invoice must carry a total amount before it can be issued with tax.',
          });
        }
        return {
          considerationMinor: minorFromDecimal(invoice.totalAmount as string),
          discountMinor: 0n,
        };
      },
      applyWrite: async (scoped, documentRow, application, taxMinor, totalMinor) => {
        const invoice = documentRow as InvoiceRow;
        const now = new Date();
        const set: Record<string, unknown> = {
          status: 'ISSUED',
          issueDate: now,
          issuedAt: now,
          issuedByUserId: scoped.user.id,
          entityVersion: newEntityVersion(),
        };
        if (application) {
          set.taxAmount = moneyText(taxMinor);
          set.dppAmount =
            application.branch === 'recording' ? null : moneyText(totalMinor - taxMinor);
          set.totalAmount = moneyText(totalMinor);
        }
        await scoped.db.update(schema.invoices).set(set).where(eq(schema.invoices.id, invoice.id));
        const rows = await scoped.db
          .select()
          .from(schema.invoices)
          .where(eq(schema.invoices.id, invoice.id))
          .limit(1);
        return rows[0] as never;
      },
      projectResponse: async (scoped, row, application, _audit, snapshotPayload) => {
        const invoice = row as InvoiceRow;
        const [payments, components, owner] = await Promise.all([
          loadInvoicePayments(scoped, invoice.id),
          loadInvoiceComponents(scoped, invoice.id),
          loadCollectionOwner(scoped, invoice.collectionOwnerId),
        ]);
        return {
          invoice: invoiceWire(invoice, payments, components, owner),
          taxSnapshot: application ? snapshotPayload : null,
        };
      },
    });
  });

  // POST /projects/:id/finance/milestones/:milestoneId/invoice — create from milestone.
  app.post('/projects/:id/finance/milestones/:milestoneId/invoice', async (c) => {
    const user = c.get('user');
    const projectId = c.req.param('id');

    // 404 phase: the project must exist. The milestone register (the
    // `project_milestones` table) lands with the milestones endpoints issue;
    // until then no milestone can resolve, so this operation returns 404 for
    // every milestone id. The guarded machinery below is complete and
    // activates the moment the register exists.
    const projectExists = await withStudioTx(pool, user, async (scoped) => {
      const rows = await scoped.db
        .select({ id: schema.projects.id })
        .from(schema.projects)
        .where(eq(schema.projects.id, projectId))
        .limit(1);
      return rows[0] !== undefined;
    });
    if (!projectExists) {
      return problem(c, {
        status: 404,
        code: 'PROJECT_NOT_FOUND',
        title: 'Project not found',
        detail: 'The project does not exist for this studio.',
        requestId: c.get('requestId'),
      });
    }
    return problem(c, {
      status: 404,
      code: 'MILESTONE_NOT_FOUND',
      title: 'Milestone not found',
      detail:
        'The milestone register is not yet implemented; no milestone can resolve for this operation. ' +
        'The milestone invoice operation will create the invoice when the milestones endpoints land.',
      requestId: c.get('requestId'),
    });
  });
}

/** The shared guarded-write envelope for the tax write paths. */
async function guardedTaxWrite(
  c: TaxContext,
  pool: Pool,
  routePath: string,
  handler: (
    scoped: Db,
    rawBody: string,
  ) => Promise<{ status: number; etag: string; body: Record<string, unknown> }>,
): Promise<Response> {
  const requiredHeader = requireNativeBuildHeader(c);
  if (requiredHeader) {
    return requiredHeader;
  }
  const requestIdCheck = requireRequestIdHeader(c);
  if (requestIdCheck) {
    return requestIdCheck;
  }
  const key = requireIdempotencyKey(c);
  if (typeof key !== 'string') {
    return key;
  }
  if (!c.req.header('If-Match')) {
    return problem(c, {
      status: 400,
      code: 'IF_MATCH_REQUIRED',
      title: 'If-Match required',
      detail: 'This write requires an If-Match header.',
      requestId: c.get('requestId'),
    });
  }
  // Section 9.9: the new write paths carry the same minimum build as the
  // issue operations (TAX_ISSUE_MINIMUM_NATIVE_BUILD = 2).
  const buildGate = newWriteBuildGate(c);
  if (buildGate) {
    return buildGate;
  }
  const user = c.get('user');
  const rawBody = await c.req.text();
  const fingerprint = fingerprintFor(
    'POST',
    routePath,
    c.req.header('content-type') ?? null,
    rawBody,
  );

  try {
    const result = await guardedWrite(
      pool,
      user,
      key,
      fingerprint,
      async (scoped) => {
        const outcome = await handler(scoped, rawBody);
        return { status: outcome.status, etag: outcome.etag, body: outcome.body };
      },
      {
        method: 'POST',
        path: routePath,
        flipReplayIdempotent: true,
        replayStatus: 200,
      },
    );
    return guardedWriteResponse(c, result);
  } catch (error) {
    const mapped = taxErrorResponse(c, error);
    if (mapped) {
      return mapped;
    }
    throw error;
  }
}

/** Builds the response for a guarded-write outcome. */
function guardedWriteResponse(
  c: TaxContext,
  result:
    | {
        outcome: 'completed';
        status: number;
        etag: string | null;
        bodyText: string;
        replay: boolean;
      }
    | { outcome: 'conflict'; status: number; code: string },
): Response {
  if (result.outcome === 'conflict') {
    return problem(c, {
      status: result.status,
      code: result.code,
      title: result.code === 'IDEMPOTENCY_KEY_REUSED' ? 'Idempotency key reused' : 'Conflict',
      detail:
        result.code === 'IDEMPOTENCY_KEY_REUSED'
          ? 'This Idempotency-Key was used for a different request body.'
          : 'The request conflicts with the current state.',
      requestId: c.get('requestId'),
    });
  }
  const response = new Response(result.bodyText, {
    status: result.status,
    headers: { 'content-type': 'application/json' },
  });
  if (result.etag) {
    response.headers.set('ETag', etagFor(result.etag));
  }
  return response;
}

/** The shared issue-operation envelope for the three document ops. */
async function issueOperation(
  c: TaxContext,
  pool: Pool,
  opts: {
    projectId: string;
    documentId: string;
    documentType: 'QUOTATION' | 'COMMERCIAL_INVOICE';
    kindLabel: string;
    notFoundCode: string;
    capabilityKey: 'canWriteQuotation' | 'canIssueInvoice';
    resolveDocument: (scoped: Db) => Promise<unknown>;
    documentLineIds: (scoped: Db, documentRow: unknown) => Promise<readonly string[]>;
    amounts: (
      scoped: Db,
      documentRow: unknown,
      lineSelections: readonly { lineId: string; selected: boolean }[],
    ) => Promise<{ considerationMinor: bigint; discountMinor: bigint }>;
    applyWrite: (
      scoped: Db,
      documentRow: unknown,
      application: {
        branch: string;
        taxMinor: bigint;
        totalMinor: bigint;
      } | null,
      taxMinor: bigint,
      totalMinor: bigint,
    ) => Promise<unknown>;
    projectResponse: (
      scoped: Db,
      row: unknown,
      application: {
        branch: string;
        taxMinor: bigint;
        totalMinor: bigint;
      } | null,
      audit: SnapshotAudit | null,
      snapshotPayload: Record<string, unknown> | null,
    ) => Promise<Record<string, unknown>>;
  },
): Promise<Response> {
  const user = c.get('user');
  const rawBody = await c.req.text();

  // 404 phase, before the build gate (section 9.9 order).
  const resolution = await withStudioTx(pool, user, async (scoped) => {
    const projectRows = await scoped.db
      .select({ id: schema.projects.id })
      .from(schema.projects)
      .where(eq(schema.projects.id, opts.projectId))
      .limit(1);
    if (!projectRows[0]) {
      return null;
    }
    const document = await opts.resolveDocument(scoped);
    return document === null ? null : { document };
  });
  if (resolution === null) {
    return problem(c, {
      status: 404,
      code: opts.notFoundCode,
      title: `${opts.kindLabel[0]?.toUpperCase() ?? 'D'}${opts.kindLabel.slice(1)} not found`,
      detail: `The ${opts.kindLabel} does not exist on this project, or the project does not exist.`,
      requestId: c.get('requestId'),
    });
  }

  // Build gate before replay and body validation (section 9.9).
  const gate = issueBuildGate(c);
  if (gate) {
    return gate;
  }

  const key = requireIdempotencyKey(c);
  if (typeof key !== 'string') {
    return key;
  }
  const routePath = new URL(c.req.url).pathname;
  const fingerprint = fingerprintFor(
    'POST',
    routePath,
    c.req.header('content-type') ?? null,
    rawBody,
  );

  try {
    const result = await guardedWrite(
      pool,
      user,
      key,
      fingerprint,
      async (scoped) => {
        // Replay has already fired inside `guardedWrite`; now the schema.
        let body: { taxApplication?: unknown };
        try {
          body = parseBody(issueOperationBodySchema, rawBody);
        } catch (error) {
          // N15/N16: the legacy taxEvidence / taxRate fields are rejected
          // with exactly 422 TAX_RULE_UNAVAILABLE, never a generic 400. The
          // reject() below must escape this catch, so the JSON scan runs in
          // its own guard and only records the finding.
          let carriesLegacyField = false;
          try {
            const json = JSON.parse(rawBody) as Record<string, unknown>;
            carriesLegacyField =
              json !== null &&
              typeof json === 'object' &&
              ('taxEvidence' in json || 'taxRate' in json);
          } catch {
            // Not JSON; the original INVALID_BODY stands.
          }
          if (
            error instanceof TaxWriteRejection &&
            error.code === 'INVALID_BODY' &&
            carriesLegacyField
          ) {
            reject(taxRuleUnavailable());
          }
          throw error;
        }
        const capabilities = projectCapabilities(scoped.user.role);
        const capability = capabilities[opts.capabilityKey];
        if (!capability?.enabled) {
          reject({
            status: 403,
            code: 'CAPABILITY_DENIED',
            title: 'Capability disabled',
            detail: capability?.reason ?? 'This role cannot perform this operation.',
          });
        }
        const documentRow = resolution.document;
        const entityVersion = (documentRow as { entityVersion: string }).entityVersion;
        const ifMatch = parseIfMatch(c.req.header('If-Match'));
        if (ifMatch === null || ifMatch[0] !== entityVersion) {
          entityVersionConflict(entityVersion);
        }

        const sentTag = c.req.header('x-stdio-tax-catalog-tag');
        const hasTax = body.taxApplication !== null && body.taxApplication !== undefined;
        if (hasTax && !sentTag) {
          reject(taxCatalogTagRequired());
        }
        if (!hasTax && sentTag) {
          reject(taxCatalogTagUnexpected());
        }

        let application: { branch: string; taxMinor: bigint; totalMinor: bigint } | null = null;
        let audit: SnapshotAudit | null = null;
        let snapshotPayload: Record<string, unknown> | null = null;

        if (hasTax) {
          const parsed = parseApplication(body.taxApplication);
          const issueDate = jakartaDateString(new Date());
          const tagCheck = await checkCatalogTag(scoped, sentTag as string);
          if (!tagCheck.ok) {
            reject(tagCheck.spec);
          }
          const resolved = await resolveApplication(scoped, parsed, issueDate, 'IDR');
          const documentLineIds = await opts.documentLineIds(scoped, documentRow);
          // N31 exhaustiveness applies to documents with a line register
          // (quotations). The invoice line register does not exist in this
          // schema yet, so the selections pass through verbatim.
          const { includedLineIds, excludedLineIds } =
            documentLineIds.length > 0
              ? validateDocumentLines(parsed.lineSelections, documentLineIds)
              : {
                  includedLineIds: parsed.lineSelections
                    .filter((line) => line.selected)
                    .map((line) => line.lineId),
                  excludedLineIds: parsed.lineSelections
                    .filter((line) => !line.selected)
                    .map((line) => line.lineId),
                };
          const { considerationMinor, discountMinor } = await opts.amounts(
            scoped,
            documentRow,
            parsed.lineSelections,
          );

          const confirmedAt = new Date();
          const snapshotId = randomUUID();
          const snapshotEntityVersion = newEntityVersion();
          const baseMinor = considerationMinor - discountMinor;

          if (resolved.branch === 'recording') {
            if (!('manualOverride' in parsed)) {
              reject({
                status: 422,
                code: 'TAX_REQUEST_INVALID',
                title: 'Invalid tax request',
                detail: 'The recording branch must carry a manual override.',
              });
            }
            const overrideMinor = parseMoneyMinor(parsed.manualOverride.amount);
            const totalMinor = baseMinor + overrideMinor;
            application = { branch: 'recording', taxMinor: overrideMinor, totalMinor };
            audit = buildAudit({
              snapshotId,
              documentRow,
              documentType: opts.documentType,
              documentStatus: opts.documentType === 'QUOTATION' ? 'SENT' : 'ISSUED',
              includedLineIds,
              excludedLineIds,
              confirmedById: scoped.user.id,
              confirmedAt,
              acceptedConfirmationText: resolved.acceptedText,
              sellerId: scoped.studioId,
            });
            const record = recordingSnapshot(audit, {
              label: parsed.manualOverride.label,
              amountMinor: overrideMinor,
              taxAmountCurrency: 'IDR',
              documentCurrency: parsed.manualOverride.documentCurrency,
              reason: parsed.manualOverride.reason,
              source: parsed.manualOverride.source,
              lineIds: [...parsed.manualOverride.lineIds],
              exchangeRateEvidence: parsed.manualOverride.exchangeRateEvidence,
            });
            await insertSnapshot(scoped, audit, record);
            snapshotPayload = record.payload;
          } else {
            const outcome = calculateForRule(
              resolved.rule,
              moneyText(considerationMinor),
              moneyText(discountMinor),
            );
            const taxMinor = outcome.totalMinor - baseMinor;
            application = { branch: resolved.branch, taxMinor, totalMinor: outcome.totalMinor };
            audit = buildAudit({
              snapshotId,
              documentRow,
              documentType: opts.documentType,
              documentStatus: opts.documentType === 'QUOTATION' ? 'SENT' : 'ISSUED',
              includedLineIds,
              excludedLineIds,
              confirmedById: scoped.user.id,
              confirmedAt,
              acceptedConfirmationText: resolved.acceptedText,
              sellerId: scoped.studioId,
            });
            const record =
              resolved.branch === 'verified'
                ? verifiedSnapshot(audit, resolved.rule, outcome, snapshotEntityVersion)
                : customSnapshot(audit, resolved.rule, outcome, snapshotEntityVersion);
            await insertSnapshot(scoped, audit, record);
            snapshotPayload = record.payload;
          }
        }

        const updatedRow = await opts.applyWrite(
          scoped,
          documentRow,
          application,
          application?.taxMinor ?? 0n,
          application?.totalMinor ?? 0n,
        );
        const responseBody = await opts.projectResponse(
          scoped,
          updatedRow,
          application,
          audit,
          snapshotPayload,
        );
        return {
          status: 201,
          etag: (updatedRow as { entityVersion: string }).entityVersion,
          body: {
            data: responseBody,
            meta: writeMeta(c, false, TAX_ISSUE_MINIMUM_NATIVE_BUILD),
          },
        };
      },
      {
        method: 'POST',
        path: routePath,
        flipReplayIdempotent: true,
        replayStatus: 200,
      },
    );
    return guardedWriteResponse(c, result);
  } catch (error) {
    const mapped = taxErrorResponse(c, error);
    if (mapped) {
      return mapped;
    }
    throw error;
  }
}

/** Builds the audit base for one issue snapshot. */
function buildAudit(input: {
  snapshotId: string;
  documentRow: unknown;
  documentType: 'QUOTATION' | 'COMMERCIAL_INVOICE';
  documentStatus: string;
  includedLineIds: readonly string[];
  excludedLineIds: readonly string[];
  confirmedById: string;
  confirmedAt: Date;
  acceptedConfirmationText: string;
  sellerId: string;
}): SnapshotAudit {
  return {
    snapshotId: input.snapshotId,
    documentId: (input.documentRow as { id: string }).id,
    documentType: input.documentType,
    documentVersion: documentVersionOf(input.documentRow),
    documentIssueDate: jakartaDateString(input.confirmedAt),
    documentStatus: input.documentStatus,
    taxType: 'PPN',
    jurisdiction: 'ID',
    includedLineIds: [...input.includedLineIds],
    excludedLineIds: [...input.excludedLineIds],
    confirmedById: input.confirmedById,
    confirmedAt: input.confirmedAt.toISOString(),
    acceptedConfirmationText: input.acceptedConfirmationText,
    sellerId: input.sellerId,
    buyerId: (input.documentRow as { clientId: string }).clientId,
  };
}

function documentVersionOf(documentRow: unknown): string {
  if (documentRow instanceof Object && 'version' in documentRow) {
    return String((documentRow as { version: string }).version);
  }
  return '1';
}

/** Inserts one snapshot row (same transaction as the document write). */
async function insertSnapshot(
  scoped: Db,
  audit: SnapshotAudit,
  record: SnapshotRecord,
): Promise<void> {
  await scoped.db.insert(taxSnapshots).values({
    id: audit.snapshotId,
    studioId: scoped.studioId,
    snapshotId: audit.snapshotId,
    documentId: audit.documentId,
    documentType: audit.documentType,
    documentVersion: audit.documentVersion,
    documentIssueDate: audit.documentIssueDate,
    documentStatus: audit.documentStatus,
    taxType: audit.taxType,
    jurisdiction: audit.jurisdiction,
    includedLineIds: audit.includedLineIds,
    excludedLineIds: audit.excludedLineIds,
    confirmedById: audit.confirmedById,
    confirmedAt: new Date(audit.confirmedAt),
    acceptedConfirmationText: audit.acceptedConfirmationText,
    mode: record.mode,
    payload: record.payload,
  });
}

/** Inserts one immutable custom rule version. */
async function insertCustomRule(
  scoped: Db,
  input: {
    id: string;
    version: number;
    draft: {
      label: string;
      code: string;
      sources: readonly unknown[];
      disclaimerText: string;
      calculationMode: 'RATIONAL_RATE' | 'FIXED_AMOUNT';
      statutoryRateNumerator?: string;
      statutoryRateDenominator?: string;
      dppFactorNumerator?: string;
      dppFactorDenominator?: string;
    };
    effectiveFrom: string;
    effectiveTo: string | null;
    fixedMinor: bigint | null;
  },
): Promise<void> {
  const rational = input.draft.calculationMode === 'RATIONAL_RATE';
  await scoped.db.insert(taxRules).values({
    id: input.id,
    version: input.version,
    studioId: scoped.studioId,
    ownerType: 'STUDIO',
    status: 'CUSTOM_UNVERIFIED',
    label: input.draft.label,
    code: input.draft.code,
    jurisdiction: 'ID',
    taxType: 'PPN',
    currency: 'IDR',
    calculationMode: input.draft.calculationMode,
    effectiveFrom: input.effectiveFrom,
    effectiveTo: input.effectiveTo,
    verifiedAt: null,
    statutoryRateNumerator: rational ? (input.draft.statutoryRateNumerator ?? null) : null,
    statutoryRateDenominator: rational ? (input.draft.statutoryRateDenominator ?? null) : null,
    dppFactorNumerator: rational ? (input.draft.dppFactorNumerator ?? null) : null,
    dppFactorDenominator: rational ? (input.draft.dppFactorDenominator ?? null) : null,
    fixedAmount: input.fixedMinor === null ? null : moneyText(input.fixedMinor),
    roundingMode: 'HALF_UP',
    roundingUnitMinor: 100,
    roundDppBeforeTax: rational ? true : null,
    roundingStage: rational ? 'DPP_THEN_PPN' : null,
    calculationScope: 'DOCUMENT_TAX_BUCKET',
    evidenceJson: null,
    exclusionsJson: null,
    sourcesJson: input.draft.sources,
    applicabilityConfirmationText: null,
    disclaimerText: input.draft.disclaimerText,
  });
}

async function resolveQuotation(
  scoped: Db,
  projectId: string,
  quotationId: string,
): Promise<QuotationRow | null> {
  const rows = await scoped.db
    .select({
      id: schema.quotations.id,
      quotationNumber: schema.quotations.quotationNumber,
      title: schema.quotations.title,
      clientId: schema.quotations.clientId,
      projectId: schema.quotations.projectId,
      engagementId: schema.quotations.engagementId,
      version: schema.quotations.version,
      status: schema.quotations.status,
      feeModel: schema.quotations.feeModel,
      currency: schema.quotations.currency,
      subtotalAmount: schema.quotations.subtotalAmount,
      discountPercent: schema.quotations.discountPercent,
      discountAmount: schema.quotations.discountAmount,
      defaultRatePerSqm: schema.quotations.defaultRatePerSqm,
      totalAmount: schema.quotations.totalAmount,
      lastAcceptedAt: schema.quotations.lastAcceptedAt,
      lastDeclinedAt: schema.quotations.lastDeclinedAt,
      entityVersion: schema.quotations.entityVersion,
      updatedAt: schema.quotations.updatedAt,
    })
    .from(schema.quotations)
    .where(and(eq(schema.quotations.id, quotationId), eq(schema.quotations.projectId, projectId)))
    .limit(1);
  return rows[0] ?? null;
}

async function loadQuotationItems(scoped: Db, quotationId: string): Promise<QuotationItemRow[]> {
  return scoped.db
    .select({
      id: schema.quotationItems.id,
      lineType: schema.quotationItems.lineType,
      description: schema.quotationItems.description,
      quantity: schema.quotationItems.quantity,
      unitRate: schema.quotationItems.unitRate,
      lineSubtotal: schema.quotationItems.lineSubtotal,
      lineTotal: schema.quotationItems.lineTotal,
    })
    .from(schema.quotationItems)
    .where(eq(schema.quotationItems.quotationId, quotationId))
    .orderBy(schema.quotationItems.lineOrder);
}

async function loadQuotationMilestones(
  scoped: Db,
  quotationId: string,
): Promise<QuotationMilestoneRow[]> {
  return scoped.db
    .select({
      id: schema.quotationPaymentMilestones.id,
      sortOrder: schema.quotationPaymentMilestones.sortOrder,
      name: schema.quotationPaymentMilestones.name,
      description: schema.quotationPaymentMilestones.description,
      dueTrigger: schema.quotationPaymentMilestones.dueTrigger,
      percentage: schema.quotationPaymentMilestones.percentage,
      amount: schema.quotationPaymentMilestones.amount,
    })
    .from(schema.quotationPaymentMilestones)
    .where(eq(schema.quotationPaymentMilestones.quotationId, quotationId));
}

async function loadQuotationSiblings(
  scoped: Db,
  quotationId: string,
): Promise<QuotationSiblingRow[]> {
  const row = await scoped.db
    .select({ quotationNumber: schema.quotations.quotationNumber })
    .from(schema.quotations)
    .where(eq(schema.quotations.id, quotationId))
    .limit(1);
  if (!row[0]) {
    return [];
  }
  return scoped.db
    .select({
      id: schema.quotations.id,
      quotationNumber: schema.quotations.quotationNumber,
      status: schema.quotations.status,
      version: schema.quotations.version,
    })
    .from(schema.quotations)
    .where(eq(schema.quotations.quotationNumber, row[0].quotationNumber));
}

async function resolveInvoice(
  scoped: Db,
  projectId: string,
  invoiceId: string,
): Promise<InvoiceRow | null> {
  const rows = await scoped.db
    .select({
      id: schema.invoices.id,
      invoiceNumber: schema.invoices.invoiceNumber,
      displayNumber: schema.invoices.displayNumber,
      clientId: schema.invoices.clientId,
      projectId: schema.invoices.projectId,
      engagementId: schema.invoices.engagementId,
      milestoneId: schema.invoices.milestoneId,
      progressCertificateId: schema.invoices.progressCertificateId,
      status: schema.invoices.status,
      currency: schema.invoices.currency,
      issueDate: schema.invoices.issueDate,
      dueDate: schema.invoices.dueDate,
      issuedAt: schema.invoices.issuedAt,
      totalAmount: schema.invoices.totalAmount,
      taxAmount: schema.invoices.taxAmount,
      collectionStatus: schema.invoices.collectionStatus,
      collectionNote: schema.invoices.collectionNote,
      collectionOwnerId: schema.invoices.collectionOwnerId,
      collectionReminderDate: schema.invoices.collectionReminderDate,
      entityVersion: schema.invoices.entityVersion,
      updatedAt: schema.invoices.updatedAt,
    })
    .from(schema.invoices)
    .where(and(eq(schema.invoices.id, invoiceId), eq(schema.invoices.projectId, projectId)))
    .limit(1);
  return rows[0] ?? null;
}

async function loadInvoicePayments(scoped: Db, invoiceId: string): Promise<InvoicePaymentRow[]> {
  return scoped.db
    .select({
      id: schema.invoicePayments.id,
      amount: schema.invoicePayments.amount,
      paidAt: schema.invoicePayments.paidAt,
      method: schema.invoicePayments.method,
    })
    .from(schema.invoicePayments)
    .where(eq(schema.invoicePayments.invoiceId, invoiceId));
}

async function loadInvoiceComponents(
  scoped: Db,
  invoiceId: string,
): Promise<InvoiceComponentRow[]> {
  return scoped.db
    .select({
      id: schema.invoiceReceivableComponents.id,
      kind: schema.invoiceReceivableComponents.kind,
      amount: schema.invoiceReceivableComponents.amount,
      settledAmount: schema.invoiceReceivableComponents.settledAmount,
    })
    .from(schema.invoiceReceivableComponents)
    .where(eq(schema.invoiceReceivableComponents.invoiceId, invoiceId));
}

async function loadCollectionOwner(
  scoped: Db,
  ownerId: string | null,
): Promise<{ id: string; name: string } | null> {
  if (!ownerId) {
    return null;
  }
  const rows = await scoped.db
    .select({ id: schema.users.id, name: schema.users.name })
    .from(schema.users)
    .where(eq(schema.users.id, ownerId))
    .limit(1);
  return rows[0] ?? null;
}
