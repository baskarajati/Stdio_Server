/**
 * Project finance roll-up read (SOL-28 revision 7).
 *
 * `GET /projects/{id}/finance` is the sole project-scoped money read. It is a
 * DERIVED roll-up across the project's engagements: the contract value is the
 * sum of the engagements' transaction prices (D-019, D-033), the invoiced
 * value is the sum of the engagement invoices, and the outstanding value is
 * invoiced minus settled payments. It never returns a blended individual
 * record and never accepts a write.
 *
 * Money wire: `ProjectFinanceSummary` declares NUMBER-form money, so every
 * figure is emitted via `RawDecimal` + `serializeJson`. The `*Label` twins
 * are derived from the same `numeric(20,2)` value. `canReadFinance` gates the
 * whole route: a non-finance actor receives `403` (the finance workspace is
 * reachable only with finance read, D-007).
 */

import { money, moneyFromDecimal, moneyToDecimal } from '@stdio/core';
import { schema } from '@stdio/db';
import { and, eq, inArray } from 'drizzle-orm';
import type { Hono } from 'hono';
import type { Pool } from 'pg';

import type { ServerEnv } from '../app';
import { projectCapabilities } from '../capabilities';
import { type Db, withStudioTx } from '../context/db';
import { meta, problem } from '../http';
import { jsonResponse, moneyNumber } from '../money';
import { moneyLabel } from '../projections';

const { projects, projectEngagements, invoices, invoicePayments, variationOrders, purchaseOrders } =
  schema;

type Rollup = {
  contractValue: string;
  invoicedValue: string;
  paidAmount: string;
  variationValue: string;
  payables: string;
  variationCount: number;
  currency: string;
};

async function computeRollup(scoped: Db, projectId: string): Promise<Rollup | null> {
  const projectRows = await scoped.db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  const project = projectRows[0];
  if (!project) {
    return null;
  }
  // The projects table carries no currency column; the studio currency (IDR) is the roll-up default.
  const currency = 'IDR';

  const engagementRows = await scoped.db
    .select({
      contractValue: projectEngagements.contractValue,
      transactionPrice: projectEngagements.transactionPrice,
    })
    .from(projectEngagements)
    .where(eq(projectEngagements.projectId, projectId));

  // D-033: the roll-up uses the transaction price (base + approved fee
  // effects), never a stored project number. Exact integer minor-unit
  // arithmetic: `moneyFromDecimal` reads the `numeric(20,2)` column with
  // BigInt only — a float would round 999999999999999999.99 to 1e18.
  const contractMinor = engagementRows.reduce((acc, e) => {
    const value = e.transactionPrice ?? e.contractValue ?? '0';
    return acc + moneyFromDecimal(value, currency).amount;
  }, 0n);

  const variationRows = await scoped.db
    .select({ feeEffect: variationOrders.feeEffect })
    .from(variationOrders)
    .where(and(eq(variationOrders.projectId, projectId), eq(variationOrders.status, 'ISSUED')));
  const variationMinor = variationRows.reduce(
    (acc, v) => acc + moneyFromDecimal(v.feeEffect ?? '0', currency).amount,
    0n,
  );

  const invoiceRows = await scoped.db
    .select({ id: invoices.id, totalAmount: invoices.totalAmount })
    .from(invoices)
    .where(eq(invoices.projectId, projectId));
  const invoicedMinor = invoiceRows.reduce(
    (acc, i) => acc + moneyFromDecimal(i.totalAmount ?? '0', currency).amount,
    0n,
  );

  const invoiceIds = invoiceRows.map((i) => i.id);
  const paymentRows = invoiceIds.length
    ? await scoped.db
        .select({ amount: invoicePayments.amount })
        .from(invoicePayments)
        .where(inArray(invoicePayments.invoiceId, invoiceIds))
    : [];
  const paidMinor = paymentRows.reduce(
    (acc, p) => acc + moneyFromDecimal(p.amount ?? '0', currency).amount,
    0n,
  );

  const poRows = await scoped.db
    .select({ totalAmount: purchaseOrders.totalAmount })
    .from(purchaseOrders)
    .where(eq(purchaseOrders.projectId, projectId));
  const payablesMinor = poRows.reduce(
    (acc, p) => acc + moneyFromDecimal(p.totalAmount ?? '0', currency).amount,
    0n,
  );

  const minorToText = (minor: bigint): string => moneyToDecimal(money(minor, currency));

  return {
    contractValue: minorToText(contractMinor),
    invoicedValue: minorToText(invoicedMinor),
    paidAmount: minorToText(paidMinor),
    variationValue: minorToText(variationMinor),
    payables: minorToText(payablesMinor),
    variationCount: variationRows.length,
    currency,
  };
}

/** Registers the project finance roll-up route on `app`. */
export function registerFinanceRoutes(app: Hono<ServerEnv>, pool: Pool): void {
  app.get('/projects/:id/finance', async (c) => {
    const user = c.get('user');
    const projectId = c.req.param('id');
    const capabilities = projectCapabilities(user.role);

    if (!capabilities.canReadFinance.enabled) {
      return problem(c, {
        status: 403,
        code: 'FINANCE_READ_DENIED',
        title: 'Finance read denied',
        detail: capabilities.canReadFinance.reason,
        requestId: c.get('requestId'),
      });
    }

    const result = await withStudioTx(pool, user, async (scoped) => {
      const rollup = await computeRollup(scoped, projectId);
      if (!rollup) {
        return { status: 404 as const };
      }
      const { currency } = rollup;
      const outstandingMinor =
        moneyFromDecimal(rollup.invoicedValue, currency).amount -
        moneyFromDecimal(rollup.paidAmount, currency).amount;
      const outstandingText = moneyToDecimal(money(outstandingMinor, currency));

      const summary = {
        actualCost: moneyNumber('0', currency),
        actualCostLabel: moneyLabel('0', currency),
        cashIn: moneyNumber(rollup.paidAmount, currency),
        cashInLabel: moneyLabel(rollup.paidAmount, currency),
        cashOut: moneyNumber('0', currency),
        cashOutLabel: moneyLabel('0', currency),
        committedCost: moneyNumber(rollup.payables, currency),
        committedCostLabel: moneyLabel(rollup.payables, currency),
        contractValue: moneyNumber(rollup.contractValue, currency),
        contractValueLabel: moneyLabel(rollup.contractValue, currency),
        effectiveContractValue: moneyNumber(rollup.contractValue, currency),
        effectiveContractValueLabel: moneyLabel(rollup.contractValue, currency),
        effectiveVariationValue: moneyNumber(rollup.variationValue, currency),
        effectiveVariationValueLabel: moneyLabel(rollup.variationValue, currency),
        forecastAtCompletion: moneyNumber(rollup.contractValue, currency),
        forecastAtCompletionLabel: moneyLabel(rollup.contractValue, currency),
        forecastToComplete: moneyNumber('0', currency),
        forecastToCompleteLabel: moneyLabel('0', currency),
        grossMargin: moneyNumber('0', currency),
        grossMarginLabel: moneyLabel('0', currency),
        grossProfit: moneyNumber('0', currency),
        grossProfitLabel: moneyLabel('0', currency),
        invoicedValue: moneyNumber(rollup.invoicedValue, currency),
        invoicedValueLabel: moneyLabel(rollup.invoicedValue, currency),
        netCashflow: moneyNumber(rollup.paidAmount, currency),
        netCashflowLabel: moneyLabel(rollup.paidAmount, currency),
        originalContractValue: moneyNumber(rollup.contractValue, currency),
        originalContractValueLabel: moneyLabel(rollup.contractValue, currency),
        payables: moneyNumber(rollup.payables, currency),
        payablesLabel: moneyLabel(rollup.payables, currency),
        quotedValue: moneyNumber(rollup.contractValue, currency),
        quotedValueLabel: moneyLabel(rollup.contractValue, currency),
        receivables: moneyNumber(outstandingText, currency),
        receivablesLabel: moneyLabel(outstandingText, currency),
        recognizedRevenue: moneyNumber(rollup.invoicedValue, currency),
        recognizedRevenueLabel: moneyLabel(rollup.invoicedValue, currency),
        variationCount: rollup.variationCount,
      };

      return {
        status: 200 as const,
        data: {
          finance: {
            capabilities: {
              manage: capabilities.canWriteVariationOrder,
              read: capabilities.canReadFinance,
            },
            invoices: [],
            milestones: [],
            summary,
          },
        },
      };
    });

    if (result.status === 404) {
      return problem(c, {
        status: 404,
        code: 'PROJECT_NOT_FOUND',
        title: 'Project not found',
        detail: 'The project does not exist.',
        requestId: c.get('requestId'),
      });
    }
    return jsonResponse({ data: result.data, meta: meta(c.get('requestId')) });
  });
}
