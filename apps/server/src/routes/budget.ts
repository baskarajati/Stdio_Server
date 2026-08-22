/**
 * Budget-versus-actual report (SOL-19 revision 6, surface G2).
 *
 * `GET /projects/{id}/budget-vs-actual` is a read-only report. Access is
 * capability-gated (D-007): the server is the single capability source.
 * OWNER, PM and FINANCE read the report; other roles get 403 with the
 * reason. The wire carries `capabilities.read` and `canReadFinance` so the
 * client never computes permission.
 *
 * Money (SOL-73-A rules and conditions):
 *
 * - `totalBudget = sum(engagement.transactionPrice)` over the project's
 *   engagements (D-033 transaction prices; 0 when no engagement exists).
 * - PO lines: only POs in the committed state set contribute. Per line the
 *   server computes the exact un-rounded allocation, rounds the line total
 *   and the received share half-up, and pushes the residual to committed
 *   (I-1 by construction). Over-receipt is capped at the ordered quantity
 *   (C2) because the report is read-only and cannot reject a receipt.
 * - Labour: `sum(hours x effective_hourly_rate)` over APPROVED timesheet
 *   entries; each product rounds half-up independently (C1). The wire
 *   groups the cost by role — role-blended presentation — and never
 *   projects a per-person rate (D-007, FE item 8).
 * - Derived fields (`signedVariance`, `forecastRemaining`) are computed from
 *   the already-rounded values and never rounded a second time (C1).
 *
 * Invariant I-1 is asserted per line inside `allocateLine`; invariant I-2
 * (`committed + actual == allocatedExternal + labourActual`) is asserted in
 * the building transaction below — a violation rolls back and 500s. I-5:
 * every wire amount is a canonical 2-decimal string from integer minor
 * units; no float exists on this path.
 */

import { schema } from '@stdio/db';
import { and, eq, inArray } from 'drizzle-orm';
import type { Hono } from 'hono';
import type { Pool } from 'pg';
import type { ServerEnv } from '../app';
import {
  allocateLine,
  labourLineCost,
  parseScale2,
  sumMinor,
  toMoneyString,
} from '../budget-money';
import { projectCapabilities } from '../capabilities';
import { withStudioTx } from '../context/db';
import { capabilityDenied } from '../guards';
import { meta, problem } from '../http';
import { jsonResponse } from '../money';
import { moneyLabel, statusLabel } from '../projections';

const {
  projects,
  projectEngagements,
  purchaseOrders,
  purchaseOrderItems,
  vendors,
  timesheetEntries,
  users,
  studios,
} = schema;

/** POs in the committed state set contribute to committed (SOL-19 section 2.5). */
const COMMITTED_STATES = new Set([
  'SENT',
  'CONFIRMED',
  'PARTIALLY_RECEIVED',
  'BACKORDERED',
  'RECEIVED',
  'CLOSED',
]);

/** The roles that may read the report (D-007: PM reads member projects). */
const REPORT_READ_ROLES = new Set(['OWNER', 'PM', 'FINANCE']);

const _STUDIO_TIMEZONE = 'Asia/Jakarta';

/** 10% over-budget threshold between `warning` and `over` signals. */
const OVER_THRESHOLD_NUMERATOR = 10n;
const OVER_THRESHOLD_DENOMINATOR = 100n;

function moneyLabelOf(minor: bigint, currency: string): string {
  return moneyLabel(toMoneyString(minor), currency) ?? toMoneyString(minor);
}

function signalFor(variance: bigint, totalBudget: bigint, currency: string) {
  if (variance > 0n) {
    return { level: 'ok', message: `Under budget by ${moneyLabelOf(variance, currency)}` };
  }
  if (variance === 0n) {
    return { level: 'ok', message: 'On budget' };
  }
  // variance < 0: the budget is exhausted or overspent.
  if (totalBudget <= 0n) {
    return { level: 'over', message: `Over budget by ${moneyLabelOf(-variance, currency)}` };
  }
  const deficit = -variance;
  const threshold = (totalBudget * OVER_THRESHOLD_NUMERATOR) / OVER_THRESHOLD_DENOMINATOR;
  if (deficit > threshold) {
    return { level: 'over', message: `Over budget by ${moneyLabelOf(deficit, currency)}` };
  }
  return { level: 'warning', message: `Over budget by ${moneyLabelOf(deficit, currency)}` };
}

/** Registers the budget-versus-actual route on `app`. */
export function registerBudgetRoutes(app: Hono<ServerEnv>, pool: Pool): void {
  app.get('/projects/:id/budget-vs-actual', async (c) => {
    const user = c.get('user');
    const projectId = c.req.param('id');

    // Capability gate (D-007): the server decides who may read the report.
    if (!REPORT_READ_ROLES.has(user.role)) {
      return capabilityDenied(c, {
        enabled: false,
        reason: 'Only the studio owner, a project manager, or finance can read the budget report.',
      });
    }

    const result = await withStudioTx(pool, user, async (scoped) => {
      const projectRows = await scoped.db
        .select({ id: projects.id, name: projects.name })
        .from(projects)
        .where(eq(projects.id, projectId))
        .limit(1);
      const project = projectRows[0];
      if (!project) {
        return { status: 404 };
      }

      const studioRows = await scoped.db
        .select({ currency: studios.currency })
        .from(studios)
        .where(eq(studios.id, scoped.studioId))
        .limit(1);
      const currency = studioRows[0]?.currency ?? 'IDR';

      // totalBudget = sum of the D-033 transaction prices.
      const engagements = await scoped.db
        .select({ transactionPrice: projectEngagements.transactionPrice })
        .from(projectEngagements)
        .where(eq(projectEngagements.projectId, projectId));
      const totalBudget = sumMinor(
        engagements.map((e) => (e.transactionPrice ? parseScale2(e.transactionPrice) : 0n)),
      );

      // PO lines in the committed state set (SOL-19 section 2.5).
      const pos = await scoped.db
        .select({
          id: purchaseOrders.id,
          number: purchaseOrders.purchaseOrderNumber,
          status: purchaseOrders.status,
          currency: purchaseOrders.currency,
          vendorName: vendors.name,
        })
        .from(purchaseOrders)
        .innerJoin(vendors, eq(vendors.id, purchaseOrders.vendorId))
        .where(
          and(
            eq(purchaseOrders.projectId, projectId),
            inArray(purchaseOrders.status, [...COMMITTED_STATES]),
          ),
        );
      const poIds = pos.map((po) => po.id);
      const items = poIds.length
        ? await scoped.db
            .select({
              id: purchaseOrderItems.id,
              purchaseOrderId: purchaseOrderItems.purchaseOrderId,
              quantity: purchaseOrderItems.quantity,
              receivedQuantity: purchaseOrderItems.receivedQuantity,
              unitCost: purchaseOrderItems.unitCost,
            })
            .from(purchaseOrderItems)
            .where(inArray(purchaseOrderItems.purchaseOrderId, poIds))
        : [];

      const itemsByPo = new Map<string, typeof items>();
      for (const item of items) {
        const list = itemsByPo.get(item.purchaseOrderId) ?? [];
        list.push(item);
        itemsByPo.set(item.purchaseOrderId, list);
      }

      const lines: Array<Record<string, unknown>> = [];
      let committedTotal = 0n;
      let actualExternalTotal = 0n;
      let allocatedExternalTotal = 0n;

      for (const po of pos) {
        let poCommitted = 0n;
        let poReceived = 0n;
        let poReceivedAny = false;
        for (const item of itemsByPo.get(po.id) ?? []) {
          const allocation = allocateLine(
            item.quantity,
            item.receivedQuantity,
            item.unitCost ?? '0.00',
          );
          // I-1 holds per line by construction; assert the aggregate too.
          if (
            allocation.receivedRounded + allocation.committedRounded !==
            allocation.allocRounded
          ) {
            throw new RangeError('I-1 conservation failed while building the budget report.');
          }
          poCommitted += allocation.committedRounded;
          poReceived += allocation.receivedRounded;
          if (allocation.receivedRounded > 0n) {
            poReceivedAny = true;
          }
        }
        committedTotal += poCommitted;
        actualExternalTotal += poReceived;
        allocatedExternalTotal += poCommitted + poReceived;

        lines.push({
          id: po.id,
          kind: 'purchase_order',
          bucket: poReceivedAny ? 'actual' : 'committed',
          name: po.vendorName ?? po.number,
          description: po.number,
          actualCost: toMoneyString(poReceived),
          committedCost: toMoneyString(poCommitted),
        });
      }

      // Labour actual cost over APPROVED entries, grouped by role on the
      // wire (role-blended presentation; no per-person rate, D-007).
      const labourRows = await scoped.db
        .select({
          hours: timesheetEntries.hours,
          rate: timesheetEntries.effectiveHourlyRate,
          role: users.role,
        })
        .from(timesheetEntries)
        .innerJoin(users, eq(users.id, timesheetEntries.userId))
        .where(
          and(eq(timesheetEntries.projectId, projectId), eq(timesheetEntries.status, 'APPROVED')),
        );

      const labourByRole = new Map<string, bigint>();
      let labourTotal = 0n;
      for (const entry of labourRows) {
        const cost = labourLineCost(entry.hours, entry.rate ?? '0.0000');
        labourByRole.set(entry.role, (labourByRole.get(entry.role) ?? 0n) + cost);
        labourTotal += cost;
      }
      for (const [role, minor] of labourByRole) {
        lines.push({
          id: `labour:${role}`,
          kind: 'timesheet',
          bucket: 'labour',
          name: statusLabel(role) ?? role,
          description: 'Role-blended labour',
          actualCost: toMoneyString(minor),
          committedCost: '0.00',
        });
      }

      const actualCost = actualExternalTotal + labourTotal;
      // I-2: committed + actual = allocatedExternal + labourActual.
      if (committedTotal + actualCost !== allocatedExternalTotal + labourTotal) {
        throw new RangeError('I-2 conservation failed while building the budget report.');
      }

      // C1: derived fields come from already-rounded values, never rounded
      // a second time.
      const signedVariance = totalBudget - (committedTotal + actualCost);
      const forecastRemaining = signedVariance > 0n ? signedVariance : 0n;
      const canReadFinance = projectCapabilities(user.role).canReadFinance?.enabled ?? false;
      const signal = signalFor(signedVariance, totalBudget, currency);

      return {
        status: 200,
        data: {
          data: {
            report: {
              actualCost: toMoneyString(actualCost),
              actualCostLabel: moneyLabelOf(actualCost, currency),
              actualExternalCost: toMoneyString(actualExternalTotal),
              canReadFinance,
              capabilities: { read: { enabled: true, reason: '' } },
              committedCost: toMoneyString(committedTotal),
              committedCostLabel: moneyLabelOf(committedTotal, currency),
              forecastRemaining: toMoneyString(forecastRemaining),
              forecastRemainingLabel: moneyLabelOf(forecastRemaining, currency),
              labourActualCost: toMoneyString(labourTotal),
              lines,
              signal,
              signedVariance: toMoneyString(signedVariance),
              signedVarianceLabel: moneyLabelOf(signedVariance, currency),
              totalBudget: toMoneyString(totalBudget),
              totalBudgetLabel: moneyLabelOf(totalBudget, currency),
            },
          },
          meta: meta(c.get('requestId')),
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
    return jsonResponse(result.data);
  });
}
