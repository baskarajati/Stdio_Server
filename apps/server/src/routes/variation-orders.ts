/**
 * Engagement-scoped variation-order routes (SOL-28 revision 7).
 *
 * The variation order is a first-class, immutable object (SOL-28 requirement
 * 2). Reads are engagement-scoped; the approve-and-issue write consumes one
 * ELIGIBLE project change and mints the issued variation order atomically.
 *
 * D-033: only an APPROVED variation order changes the engagement transaction
 * price. The write recomputes `transaction_price` = base `contract_value` +
 * the sum of approved `fee_effect` (fee effect only; BOQ and contract-value
 * effects feed reporting, not the price). An unapproved change never touches
 * the roll-up.
 *
 * Guards (guards.ts): `Idempotency-Key` (replay-safe, `409` on reuse),
 * `If-Match` (change + engagement versions), capability projection
 * (`canWriteVariationOrder`, OWNER only). The write runs SERIALIZABLE so the
 * approve-and-issue and the roll-up recompute cannot interleave.
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
import { jsonResponse } from '../money';
import { moneyString } from '../projections';

const { variationOrders, variationOrderApprovals, projectChanges, projectEngagements } = schema;

type ApprovalRow = {
  id: string;
  sequence: string;
  approverId: string | null;
  approverName: string;
  approverRole: string;
  decision: string;
  decisionNotes: string | null;
  decidedAt: Date;
};

/** A `MoneyInput` (string or number) to the canonical 2dp STRING wire form. */
function moneyInputToWire(raw: unknown, currency: string): string | null {
  if (typeof raw !== 'string' && typeof raw !== 'number') {
    return null;
  }
  return moneyToDecimal(parseMoneyInput(raw, currency));
}

/** The D-033 transaction-price string for a minor-unit sum. */
function decimalFromMinor(minor: bigint, currency: string): string {
  return moneyToDecimal(money(minor, currency));
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Returns the first field in `fields` whose value is present but not a valid
 * UUID, or null when every field is a valid UUID, null, or absent. Used for
 * fields that map to Postgres `uuid` columns, so a bad value never surfaces
 * as a bare 22P02 500 (SOL-131).
 */
function firstInvalidUuid(body: Record<string, unknown>, fields: string[]): string | null {
  for (const field of fields) {
    const value = body[field];
    if (value === null || value === undefined) {
      continue;
    }
    if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
      return field;
    }
  }
  return null;
}

/**
 * Allocates the next per-studio variation-order display number (SOL-131,
 * review SOL-137 condition).
 *
 * The number is derived numerically inside the studio-scoped transaction: a
 * per-studio advisory lock serializes concurrent mints, so the read-then-
 * write cannot race even across different Idempotency-Keys. The derivation
 * scans `display_number` values that match `VO-<digits>` and takes the
 * numeric max — never a lexical text MAX, which an unpadded value would
 * break. The result is formatted `VO-%04d`. Gaps from aborted transactions
 * are not violations (the aborted insert leaves no row, so the number is
 * simply not consumed).
 */
async function nextVariationOrderDisplayNumber(scoped: Db, studioId: string): Promise<string> {
  await scoped.db.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${studioId}::text, 47013))`,
  );
  const rows = await scoped.db
    .select({ displayNumber: variationOrders.displayNumber })
    .from(variationOrders)
    .where(eq(variationOrders.studioId, studioId));
  let max = 0;
  for (const row of rows) {
    if (row.displayNumber === null) {
      continue;
    }
    const match = /^VO-(\d+)$/.exec(row.displayNumber);
    if (!match) {
      continue;
    }
    const n = Number(match[1]);
    if (Number.isSafeInteger(n) && n > max) {
      max = n;
    }
  }
  return `VO-${String(max + 1).padStart(4, '0')}`;
}

/** Projects one variation-order row into the contract `VariationOrder` shape. */
function projectVariationOrder(
  row: Record<string, unknown>,
  canReadFinance: boolean,
  currency: string,
  approvals: ApprovalRow[],
  projectChange: Record<string, unknown> | null,
): Record<string, unknown> {
  const str = (key: string) =>
    moneyString(canReadFinance, (row[key] as string | null) ?? null, currency);
  const date = (key: string) => {
    const value = row[key];
    return value instanceof Date ? value.toISOString() : null;
  };
  return {
    adoptionAttestationReference: row.adoptionAttestationReference ?? null,
    adoptionEvidenceInterpretation: row.adoptionEvidenceInterpretation ?? null,
    adoptedAt: date('adoptedAt'),
    adoptedById: row.adoptedById ?? null,
    afterBoqAmount: str('afterBoqAmount'),
    afterCompletionDate: date('afterCompletionDate'),
    afterContractValue: str('afterContractValue'),
    afterFeeAmount: str('afterFeeAmount'),
    approvals: approvals.map((a) => ({
      id: a.id,
      sequence: Number(a.sequence),
      approverId: a.approverId,
      approverName: a.approverName,
      approverRole: a.approverRole,
      decision: a.decision,
      decisionNotes: a.decisionNotes,
      decidedAt: a.decidedAt.toISOString(),
    })),
    beforeBoqAmount: str('beforeBoqAmount'),
    beforeCompletionDate: date('beforeCompletionDate'),
    beforeContractValue: str('beforeContractValue'),
    beforeFeeAmount: str('beforeFeeAmount'),
    boqEffect: str('boqEffect'),
    canReadFinance,
    contractRevisionId: row.contractRevisionId ?? null,
    currency,
    displayNumber: row.displayNumber ?? null,
    effectiveDate: date('effectiveDate'),
    engagementId: row.engagementId,
    entityVersion: row.entityVersion,
    feeEffect: str('feeEffect'),
    id: row.id,
    issuedAt: date('issuedAt'),
    projectChange,
    projectId: row.projectId,
    scheduleOfValues: null,
    status: row.status,
    systemNumber: row.systemNumber ?? null,
    taxAmount: str('taxAmount'),
    timeEffectDays: row.timeEffectDays === null ? null : Number(row.timeEffectDays),
    totalAmount: str('totalAmount'),
    updatedAt: date('updatedAt'),
  };
}

type VariationOrderRow = {
  id: string;
  projectId: string;
  engagementId: string;
  displayNumber: string | null;
  systemNumber: string | null;
  status: string;
  currency: string;
  issuedAt: Date;
  effectiveDate: Date;
  contractRevisionId: string | null;
  scheduleOfValuesId: string | null;
  projectChangeId: string | null;
  beforeFeeAmount: string | null;
  afterFeeAmount: string | null;
  feeEffect: string;
  beforeBoqAmount: string | null;
  afterBoqAmount: string | null;
  boqEffect: string;
  beforeContractValue: string | null;
  afterContractValue: string | null;
  taxAmount: string | null;
  totalAmount: string | null;
  timeEffectDays: string | null;
  beforeCompletionDate: Date | null;
  afterCompletionDate: Date | null;
  adoptedAt: Date | null;
  adoptedById: string | null;
  adoptionAttestationReference: string | null;
  adoptionEvidenceInterpretation: string | null;
  entityVersion: string;
  updatedAt: Date;
};

type LoadedVariationOrder = {
  row: VariationOrderRow;
  currency: string;
  approvals: ApprovalRow[];
  change: Record<string, unknown> | null;
};

async function loadVariationOrders(
  scoped: Db,
  projectId: string,
  engagementId: string,
  variationOrderId?: string,
): Promise<LoadedVariationOrder[]> {
  const where = variationOrderId
    ? and(
        eq(variationOrders.id, variationOrderId),
        eq(variationOrders.projectId, projectId),
        eq(variationOrders.engagementId, engagementId),
      )
    : and(eq(variationOrders.projectId, projectId), eq(variationOrders.engagementId, engagementId));
  const rows = await scoped.db
    .select({
      id: variationOrders.id,
      projectId: variationOrders.projectId,
      engagementId: variationOrders.engagementId,
      displayNumber: variationOrders.displayNumber,
      systemNumber: variationOrders.systemNumber,
      status: variationOrders.status,
      currency: variationOrders.currency,
      issuedAt: variationOrders.issuedAt,
      effectiveDate: variationOrders.effectiveDate,
      contractRevisionId: variationOrders.contractRevisionId,
      scheduleOfValuesId: variationOrders.scheduleOfValuesId,
      projectChangeId: variationOrders.projectChangeId,
      beforeFeeAmount: variationOrders.beforeFeeAmount,
      afterFeeAmount: variationOrders.afterFeeAmount,
      feeEffect: variationOrders.feeEffect,
      beforeBoqAmount: variationOrders.beforeBoqAmount,
      afterBoqAmount: variationOrders.afterBoqAmount,
      boqEffect: variationOrders.boqEffect,
      beforeContractValue: variationOrders.beforeContractValue,
      afterContractValue: variationOrders.afterContractValue,
      taxAmount: variationOrders.taxAmount,
      totalAmount: variationOrders.totalAmount,
      timeEffectDays: variationOrders.timeEffectDays,
      beforeCompletionDate: variationOrders.beforeCompletionDate,
      afterCompletionDate: variationOrders.afterCompletionDate,
      adoptedAt: variationOrders.adoptedAt,
      adoptedById: variationOrders.adoptedById,
      adoptionAttestationReference: variationOrders.adoptionAttestationReference,
      adoptionEvidenceInterpretation: variationOrders.adoptionEvidenceInterpretation,
      entityVersion: variationOrders.entityVersion,
      updatedAt: variationOrders.updatedAt,
    })
    .from(variationOrders)
    .where(where)
    .orderBy(sql`${variationOrders.issuedAt} desc`);

  const projectChangesRows = rows.length
    ? await scoped.db
        .select({
          id: projectChanges.id,
          changeNumber: projectChanges.changeNumber,
          changeType: projectChanges.changeType,
          status: projectChanges.status,
          title: projectChanges.title,
          description: projectChanges.description,
          engagementId: projectChanges.engagementId,
        })
        .from(projectChanges)
        .where(
          and(
            eq(projectChanges.projectId, projectId),
            eq(projectChanges.engagementId, engagementId),
          ),
        )
    : [];
  const changeById = new Map(projectChangesRows.map((c) => [c.id, c]));

  const ids = rows.map((r) => r.id);
  const approvals = ids.length
    ? await scoped.db
        .select({
          id: variationOrderApprovals.id,
          variationOrderId: variationOrderApprovals.variationOrderId,
          sequence: variationOrderApprovals.sequence,
          approverId: variationOrderApprovals.approverId,
          approverName: variationOrderApprovals.approverName,
          approverRole: variationOrderApprovals.approverRole,
          decision: variationOrderApprovals.decision,
          decisionNotes: variationOrderApprovals.decisionNotes,
          decidedAt: variationOrderApprovals.decidedAt,
        })
        .from(variationOrderApprovals)
        .where(inArray(variationOrderApprovals.variationOrderId, ids))
    : [];
  const approvalsByVo = new Map<string, ApprovalRow[]>();
  for (const a of approvals) {
    const list = approvalsByVo.get(a.variationOrderId) ?? [];
    list.push(a);
    approvalsByVo.set(a.variationOrderId, list);
  }

  return rows.map((row) => {
    const currency = row.currency ?? 'IDR';
    const change = row.projectChangeId ? (changeById.get(row.projectChangeId) ?? null) : null;
    return {
      row,
      currency,
      approvals: (approvalsByVo.get(row.id) ?? []).sort(
        (a, b) => Number(a.sequence) - Number(b.sequence),
      ),
      change: change
        ? {
            id: change.id,
            changeNumber: change.changeNumber,
            changeType: change.changeType,
            status: change.status,
            title: change.title,
            description: change.description,
            engagementId: change.engagementId,
          }
        : null,
    };
  });
}

/** Registers the engagement-scoped variation-order routes on `app`. */
export function registerVariationOrderRoutes(app: Hono<ServerEnv>, pool: Pool): void {
  // GET /projects/{id}/engagements/{engId}/variation-orders — the register.
  app.get('/projects/:id/engagements/:engId/variation-orders', async (c) => {
    const user = c.get('user');
    const projectId = c.req.param('id');
    const engagementId = c.req.param('engId');
    const capabilities = projectCapabilities(user.role);

    const result = await withStudioTx(pool, user, async (scoped) => {
      const engagement = await resolveEngagement(scoped, projectId, engagementId);
      if (!engagement) {
        return { status: 404 as const };
      }
      const items = await loadVariationOrders(scoped, projectId, engagementId);
      return {
        status: 200 as const,
        data: {
          variationOrders: items.map(({ row, currency, approvals, change }) =>
            projectVariationOrder(
              row as unknown as Record<string, unknown>,
              capabilities.canReadFinance?.enabled ?? false,
              currency,
              approvals,
              change,
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

  // GET /projects/{id}/engagements/{engId}/variation-orders/{voId} — detail.
  app.get('/projects/:id/engagements/:engId/variation-orders/:voId', async (c) => {
    const user = c.get('user');
    const projectId = c.req.param('id');
    const engagementId = c.req.param('engId');
    const voId = c.req.param('voId');
    const capabilities = projectCapabilities(user.role);

    const result = await withStudioTx(pool, user, async (scoped) => {
      const engagement = await resolveEngagement(scoped, projectId, engagementId);
      if (!engagement) {
        return { status: 404 as const };
      }
      const items = await loadVariationOrders(scoped, projectId, engagementId, voId);
      const item = items[0];
      if (!item) {
        return { status: 404 as const };
      }
      return {
        status: 200 as const,
        data: {
          variationOrder: projectVariationOrder(
            item.row as unknown as Record<string, unknown>,
            capabilities.canReadFinance?.enabled ?? false,
            item.currency,
            item.approvals,
            item.change,
          ),
        },
        etag: item.row.entityVersion,
      };
    });

    if (result.status === 404) {
      return problem(c, {
        status: 404,
        code: 'VARIATION_ORDER_NOT_FOUND',
        title: 'Variation order not found',
        detail: 'The variation order does not exist on this engagement.',
        requestId: c.get('requestId'),
      });
    }
    const response = jsonResponse({ data: result.data, meta: meta(c.get('requestId')) });
    if (result.etag) {
      response.headers.set('ETag', etagFor(result.etag));
    }
    return response;
  });

  // POST /projects/{id}/engagements/{engId}/project-changes/{changeId}/variation-order
  // — approve an ELIGIBLE change and mint its issued variation order (D-033).
  app.post(
    '/projects/:id/engagements/:engId/project-changes/:changeId/variation-order',
    async (c) => {
      const user = c.get('user');
      const projectId = c.req.param('id');
      const engagementId = c.req.param('engId');
      const changeId = c.req.param('changeId');

      const capability = projectCapabilities(user.role).canWriteVariationOrder;
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
      if (!ifMatch || ifMatch.length < 2) {
        return problem(c, {
          status: 400,
          code: 'MISSING_IF_MATCH',
          title: 'Entity versions required',
          detail:
            'The variation-order write requires If-Match with the change version and the engagement version.',
          requestId: c.get('requestId'),
        });
      }
      const [changeVersion, engagementVersion] = ifMatch;

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

      // SOL-131: contractRevisionId and scheduleOfValuesId are uuid columns.
      // A non-UUID value used to pass request validation and then die inside
      // the transaction with Postgres 22P02, surfacing as a bare HTTP 500.
      // Validate them up front so the caller gets a typed 422 instead.
      const requestRecord = (body ?? {}) as Record<string, unknown>;
      const uuidFieldError = firstInvalidUuid(requestRecord, [
        'contractRevisionId',
        'scheduleOfValuesId',
      ]);
      if (uuidFieldError) {
        return problem(c, {
          status: 422,
          code: 'INVALID_UUID_FIELD',
          title: 'Invalid UUID field',
          detail: `${uuidFieldError} must be a valid UUID (or null).`,
          requestId: c.get('requestId'),
        });
      }

      const result = await guardedWrite(
        pool,
        user,
        key,
        fingerprint,
        async (scoped) => {
          // The engagement belongs to the route project and this studio.
          const engagement = await resolveEngagement(scoped, projectId, engagementId);
          if (!engagement) {
            return { status: 404, body: { code: 'ENGAGEMENT_NOT_FOUND' } };
          }

          // Lock the change FOR UPDATE and verify ELIGIBLE + engagement match.
          const changes = await scoped.db
            .select({
              id: projectChanges.id,
              engagementId: projectChanges.engagementId,
              status: projectChanges.status,
              entityVersion: projectChanges.entityVersion,
            })
            .from(projectChanges)
            .where(
              and(
                eq(projectChanges.id, changeId),
                eq(projectChanges.projectId, projectId),
                eq(projectChanges.engagementId, engagementId),
              ),
            )
            .for('update');
          const change = changes[0];
          if (!change) {
            return { status: 404, body: { code: 'PROJECT_CHANGE_NOT_FOUND' } };
          }
          if (change.entityVersion !== changeVersion) {
            return {
              status: 409,
              body: {
                code: 'ENTITY_VERSION_CONFLICT',
                currentEntityVersion: change.entityVersion,
              },
            };
          }
          if (change.status !== 'ELIGIBLE') {
            return {
              status: 409,
              body: {
                code: 'PROJECT_CHANGE_NOT_ELIGIBLE',
                detail: `The change status is ${change.status}; only ELIGIBLE changes can be approved and issued.`,
              },
            };
          }

          // Lock the engagement FOR UPDATE and verify its version.
          const engagements = await scoped.db
            .select({
              id: projectEngagements.id,
              entityVersion: projectEngagements.entityVersion,
              currency: projectEngagements.currency,
              contractValue: projectEngagements.contractValue,
            })
            .from(projectEngagements)
            .where(
              and(
                eq(projectEngagements.id, engagementId),
                eq(projectEngagements.projectId, projectId),
              ),
            )
            .for('update');
          const engagementRow = engagements[0];
          if (!engagementRow) {
            return { status: 404, body: { code: 'ENGAGEMENT_NOT_FOUND' } };
          }
          if (engagementRow.entityVersion !== engagementVersion) {
            return {
              status: 409,
              body: {
                code: 'ENTITY_VERSION_CONFLICT',
                currentEntityVersion: engagementRow.entityVersion,
              },
            };
          }

          const currency = engagementRow.currency ?? 'IDR';
          const req = body as Record<string, unknown>;
          const now = new Date();
          const effectiveDate = req.effectiveDate ? new Date(req.effectiveDate as string) : now;

          // SOL-131: number the document at issue (A-008) inside the
          // studio-scoped transaction; systemNumber mirrors displayNumber.
          const displayNumber = await nextVariationOrderDisplayNumber(scoped, scoped.studioId);

          const inserted = await scoped.db
            .insert(variationOrders)
            .values({
              studioId: scoped.studioId,
              projectId,
              engagementId,
              displayNumber,
              systemNumber: displayNumber,
              status: 'ISSUED',
              currency,
              issuedAt: now,
              effectiveDate,
              contractRevisionId: (req.contractRevisionId as string) ?? null,
              scheduleOfValuesId: (req.scheduleOfValuesId as string) ?? null,
              projectChangeId: change.id,
              beforeFeeAmount: moneyInputToWire(req.beforeFeeAmount, currency),
              afterFeeAmount: moneyInputToWire(req.afterFeeAmount, currency),
              feeEffect: moneyInputToWire(req.feeEffect, currency) ?? '0.00',
              beforeBoqAmount: moneyInputToWire(req.beforeBoqAmount, currency),
              afterBoqAmount: moneyInputToWire(req.afterBoqAmount, currency),
              boqEffect: moneyInputToWire(req.boqEffect, currency) ?? '0.00',
              beforeContractValue: moneyInputToWire(req.beforeContractValue, currency),
              afterContractValue: moneyInputToWire(req.afterContractValue, currency),
              taxAmount: moneyInputToWire(req.taxAmount, currency),
              totalAmount: moneyInputToWire(req.totalAmount, currency),
              timeEffectDays:
                req.timeEffectDays === null || req.timeEffectDays === undefined
                  ? null
                  : String(req.timeEffectDays),
              beforeCompletionDate: req.beforeCompletionDate
                ? new Date(req.beforeCompletionDate as string)
                : null,
              afterCompletionDate: req.afterCompletionDate
                ? new Date(req.afterCompletionDate as string)
                : null,
              adoptedAt: null,
              adoptedById: null,
              adoptionAttestationReference: null,
              adoptionEvidenceInterpretation: null,
            })
            .returning({
              id: variationOrders.id,
              entityVersion: variationOrders.entityVersion,
            });
          const vo = inserted[0];
          if (!vo) {
            throw new Error('The variation-order insert returned no row.');
          }

          await scoped.db.insert(variationOrderApprovals).values({
            studioId: scoped.studioId,
            variationOrderId: vo.id,
            sequence: '1',
            approverId: user.id,
            approverName: user.name,
            approverRole: user.role,
            decision: 'APPROVED',
            decisionNotes: (req.decisionNotes as string) ?? null,
            decidedAt: now,
          });

          // Consume the change: CONSUMED + bumped version.
          await scoped.db
            .update(projectChanges)
            .set({ status: 'CONSUMED', entityVersion: sql`gen_random_uuid()` })
            .where(eq(projectChanges.id, change.id));

          // D-033: transaction_price = base contract_value + sum of approved
          // fee_effect across the engagement's issued variation orders.
          const base = engagementRow.contractValue ?? '0';
          const effects = await scoped.db
            .select({ feeEffect: variationOrders.feeEffect })
            .from(variationOrders)
            .where(
              and(
                eq(variationOrders.engagementId, engagementId),
                eq(variationOrders.status, 'ISSUED'),
              ),
            );
          const minorTotal = effects.reduce((acc, e) => {
            return acc + (e.feeEffect ? parseMoneyInput(e.feeEffect, currency).amount : 0n);
          }, parseMoneyInput(base, currency).amount);
          await scoped.db
            .update(projectEngagements)
            .set({
              transactionPrice: decimalFromMinor(minorTotal, currency),
              entityVersion: sql`gen_random_uuid()`,
            })
            .where(eq(projectEngagements.id, engagementId));

          // Project the written variation order for the response.
          const items = await loadVariationOrders(scoped, projectId, engagementId, vo.id);
          const item = items[0];
          return {
            status: 201,
            etag: vo.entityVersion,
            body: {
              data: {
                idempotentReplay: false,
                variationOrder: item
                  ? projectVariationOrder(
                      item.row as unknown as Record<string, unknown>,
                      projectCapabilities(user.role).canReadFinance?.enabled ?? false,
                      item.currency,
                      item.approvals,
                      item.change,
                    )
                  : null,
              },
              meta: meta(c.get('requestId')),
            },
          };
        },
        {
          isolation: 'SERIALIZABLE',
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
        if (result.code === 'ENTITY_VERSION_CONFLICT') {
          return entityConflict(c, null);
        }
        return problem(c, {
          status: result.status,
          code: result.code,
          title: 'Write rejected',
          detail: 'The variation-order write was rejected by the server.',
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
    },
  );
}
