/**
 * Budget-versus-actual report (SOL-19 revision 6, section 2).
 *
 * `GET /projects/{id}/budget-vs-actual` is a read-only derived report. The
 * math lives in `@stdio/core` (`budget.ts`) and is pinned by its unit tests:
 *
 * - I-1 per PO line: `receivedRounded + committedRounded = allocRounded`.
 *   The report asserts the invariant in the building transaction and throws
 *   (fails closed) on violation.
 * - I-2 project: `committedCost + actualCost = allocatedExternalCost +
 *   labourActualCost`.
 * - I-3 signed variance: `signedVariance = totalBudget -
 *   (committedCost + actualCost)`; positive is under budget.
 * - I-4 forecast: `forecastRemaining = max(0, signedVariance)`.
 * - I-5: money never a float — every figure is BigInt minor units over the
 *   `numeric(20,2)` columns, emitted as a canonical 2dp string.
 * - C1: labour products round half-up per entry; derived fields are not
 *   rounded a second time.
 * - C2: rounding is presentation-only; over-receipt (`R > Q`) projects the
 *   full received value as actual and zero committed, never negative.
 *
 * Access (D-007 Q-A): the report is the PM's cost/variance tool. OWNER,
 * FINANCE and PM read it; DESIGNER and PROCUREMENT are 403. Labour lines use
 * role-blended values — per-person rates are never projected.
 */

import {
  allocatePoLine,
  assertInvariantOne,
  labourCost,
  money,
  moneyFromDecimal,
  moneyToDecimal,
  parseScaled,
} from '@stdio/core';
import { schema } from '@stdio/db';
import { and, eq, inArray } from 'drizzle-orm';
import type { Hono } from 'hono';
import type { Pool } from 'pg';

import type { ServerEnv } from '../app';
import type { StudioRole } from '../context/db';
import { withStudioTx } from '../context/db';
import { meta, problem, requestBuildOf } from '../http';
import { jsonResponse } from '../money';
import { moneyLabel } from '../projections';

const {
  projects,
  projectEngagements,
  purchaseOrders,
  purchaseOrderItems,
  timesheetEntries,
  users,
} = schema;

/** D-097 pinned committed-cost PO state set (exact; do not re-derive). */
const COMMITTED_PO_STATES = new Set([
  'SENT',
  'CONFIRMED',
  'PARTIALLY_RECEIVED',
  'BACKORDERED',
  'RECEIVED',
  'CLOSED',
]);

/** The roles that read the report (D-007 Q-A). */
function reportRoles(role: StudioRole): boolean {
  return role === 'OWNER' || role === 'FINANCE' || role === 'PM';
}

function canReadFinance(role: StudioRole): boolean {
  return role === 'OWNER' || role === 'FINANCE';
}

function canonical2dp(minor: bigint): string {
  return moneyToDecimal(money(minor, 'IDR'));
}

export function registerBudgetRoutes(app: Hono<ServerEnv>, pool: Pool): void {
  app.get('/projects/:id/budget-vs-actual', async (c) => {
    const user = c.get('user');
    const projectId = c.req.param('id');
    const build = requestBuildOf(c);

    if (!reportRoles(user.role)) {
      return problem(c, {
        status: 403,
        code: 'CAPABILITY_DENIED',
        title: 'Capability disabled',
        detail:
          'The budget-versus-actual report is a finance figure. Only the owner, finance and project managers can read it.',
        requestId: c.get('requestId'),
      });
    }

    const result = await withStudioTx(pool, user, async (scoped) => {
      const projectRows = await scoped.db
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.id, projectId))
        .limit(1);
      if (!projectRows[0]) {
        return { status: 404 as const };
      }

      // I-2 / section 4: the total budget is the sum of the engagement
      // transaction prices (D-033: contract value plus approved effective
      // variation value). No engagement -> zero.
      const engagementRows = await scoped.db
        .select({
          contractValue: projectEngagements.contractValue,
          transactionPrice: projectEngagements.transactionPrice,
        })
        .from(projectEngagements)
        .where(eq(projectEngagements.projectId, projectId));
      const totalBudgetMinor = engagementRows.reduce(
        (acc, e) =>
          acc + moneyFromDecimal(e.transactionPrice ?? e.contractValue ?? '0', 'IDR').amount,
        0n,
      );

      // PO lines in committed states (section 2.5).
      const poRows = await scoped.db
        .select({
          id: purchaseOrders.id,
          purchaseOrderNumber: purchaseOrders.purchaseOrderNumber,
          status: purchaseOrders.status,
          itemId: purchaseOrderItems.id,
          description: purchaseOrderItems.description,
          quantity: purchaseOrderItems.quantity,
          receivedQuantity: purchaseOrderItems.receivedQuantity,
          unitCost: purchaseOrderItems.unitCost,
        })
        .from(purchaseOrders)
        .innerJoin(purchaseOrderItems, eq(purchaseOrderItems.purchaseOrderId, purchaseOrders.id))
        .where(
          and(
            eq(purchaseOrders.projectId, projectId),
            inArray(purchaseOrders.status, [...COMMITTED_PO_STATES]),
          ),
        );

      const poLines: Array<Record<string, unknown>> = [];
      let committedMinor = 0n;
      let actualExternalMinor = 0n;
      for (const po of poRows) {
        const qty = parseScaled(po.quantity ?? '0', 4);
        const received = parseScaled(po.receivedQuantity ?? '0', 4);
        const unitCost = parseScaled(po.unitCost ?? '0', 2);
        const line = allocatePoLine(qty, received, unitCost);
        // I-1 asserted in the building transaction; a violation aborts.
        assertInvariantOne(line);
        committedMinor += line.committedRounded;
        actualExternalMinor += line.receivedRounded;
        const bucket = line.receivedRounded > 0n ? 'actual' : 'committed';
        poLines.push({
          actualCost: canonical2dp(line.receivedRounded),
          bucket,
          committedCost: canonical2dp(line.committedRounded),
          description: po.purchaseOrderNumber,
          id: po.itemId,
          kind: 'purchase_order',
          name: po.description,
        });
      }

      // Labour: APPROVED entries, role-blended (section 2.6, D-007).
      const labourRows = await scoped.db
        .select({
          id: timesheetEntries.id,
          hours: timesheetEntries.hours,
          effectiveHourlyRate: timesheetEntries.effectiveHourlyRate,
          entryDate: timesheetEntries.entryDate,
          notes: timesheetEntries.notes,
          userName: users.name,
        })
        .from(timesheetEntries)
        .leftJoin(users, and(eq(users.id, timesheetEntries.userId)))
        .where(
          and(eq(timesheetEntries.projectId, projectId), eq(timesheetEntries.status, 'APPROVED')),
        );

      const labourLines: Array<Record<string, unknown>> = [];
      let labourMinor = 0n;
      for (const entry of labourRows) {
        const hours = parseScaled(entry.hours ?? '0', 2);
        const rate =
          entry.effectiveHourlyRate === null ? 0n : parseScaled(entry.effectiveHourlyRate, 4);
        const cost = labourCost(hours, rate);
        labourMinor += cost;
        labourLines.push({
          actualCost: canonical2dp(cost),
          bucket: 'labour',
          committedCost: canonical2dp(0n),
          description:
            entry.notes ?? (entry.entryDate ? entry.entryDate.toISOString().slice(0, 10) : ''),
          id: entry.id,
          kind: 'timesheet',
          name: entry.userName ?? 'Timesheet entry',
        });
      }

      const actualMinor = actualExternalMinor + labourMinor;
      const committedCostMinor = committedMinor;
      const signedVarianceMinor = totalBudgetMinor - (committedCostMinor + actualMinor);
      const forecastRemainingMinor = signedVarianceMinor > 0n ? signedVarianceMinor : 0n;

      const over = signedVarianceMinor < 0n;
      const signal = over
        ? { level: 'over', message: 'The project is over budget.' }
        : committedCostMinor > 0n
          ? { level: 'warning', message: 'The project has outstanding commitments.' }
          : { level: 'ok', message: 'The project is within budget.' };

      return {
        status: 200 as const,
        report: {
          actualCost: canonical2dp(actualMinor),
          actualCostLabel: moneyLabel(canonical2dp(actualMinor), 'IDR'),
          actualExternalCost: canonical2dp(actualExternalMinor),
          canReadFinance: canReadFinance(user.role),
          capabilities: {
            read: { enabled: true, reason: '' },
          },
          committedCost: canonical2dp(committedCostMinor),
          committedCostLabel: moneyLabel(canonical2dp(committedCostMinor), 'IDR'),
          forecastRemaining: canonical2dp(forecastRemainingMinor),
          forecastRemainingLabel: moneyLabel(canonical2dp(forecastRemainingMinor), 'IDR'),
          labourActualCost: canonical2dp(labourMinor),
          lines: [...poLines, ...labourLines],
          signal,
          signedVariance: canonical2dp(signedVarianceMinor),
          signedVarianceLabel: moneyLabel(canonical2dp(signedVarianceMinor), 'IDR'),
          totalBudget: canonical2dp(totalBudgetMinor),
          totalBudgetLabel: moneyLabel(canonical2dp(totalBudgetMinor), 'IDR'),
        },
      };
    });

    if (result.status === 404) {
      return problem(c, {
        status: 404,
        code: 'PROJECT_NOT_FOUND',
        title: 'Project not found',
        detail: 'The project does not exist in this studio.',
        requestId: c.get('requestId'),
      });
    }
    return jsonResponse({
      data: { report: result.report },
      meta: meta(c.get('requestId'), { requestBuild: build }),
    });
  });
}
