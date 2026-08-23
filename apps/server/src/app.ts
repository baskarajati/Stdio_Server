/**
 * The Stdio server entrypoint.
 *
 * Serves the native API contract (`contracts/openapi/native-v1.yaml`) over
 * Hono. Every request resolves a bearer token to a studio + staff user, runs
 * the work in a tenant-scoped RLS transaction, and returns the contract Meta
 * envelope. The engagement-scoped money routes land behind the SOL-28 review
 * gate; this file owns the spine (health, `/me`) and the route registration.
 */

import { randomUUID } from 'node:crypto';
import { schema } from '@stdio/db';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import type { Pool } from 'pg';

const { studios } = schema;

import { projectCapabilities } from './capabilities';
import { type RequestUser, withStudioTx } from './context/db';
import { resolveToken, type TokenResolution } from './context/token';
import { meta, problem, problemFromSqlState, sqlStateOf } from './http';
import { registerBudgetRoutes } from './routes/budget';
import { registerContractRoutes } from './routes/contracts';
import { registerDeprecatedRoutes } from './routes/deprecated';
import { registerFinanceRoutes } from './routes/finance';
import { registerInvoiceRoutes } from './routes/invoices';
import { registerProjectRoutes } from './routes/projects';
import { registerQuotationRoutes } from './routes/quotations';
import { registerRegisterRoutes } from './routes/registers';
import { registerTimesheetRoutes } from './routes/timesheets';
import { registerVariationOrderRoutes } from './routes/variation-orders';
import { registerTaxRoutes } from './tax/routes';

export type ServerEnv = {
  Variables: {
    requestId: string;
    user: RequestUser;
  };
};

/**
 * Builds the Hono app. `pool` is a `pg.Pool` over the `stdio` connection string;
 * the app runs every request on the tenant path inside `withStudioTx`.
 */
export function createApp(pool: Pool) {
  const app = new Hono<ServerEnv>();

  // Request id: stable across the response and the logs.
  app.use('*', async (c, next) => {
    const requestId = c.req.header('X-Request-Id') ?? randomUUID();
    c.set('requestId', requestId);
    await next();
  });

  const PUBLIC_PATHS = new Set(['/health']);

  // Resolve the bearer token to a request user.
  app.use('*', async (c, next) => {
    if (PUBLIC_PATHS.has(new URL(c.req.url).pathname)) {
      await next();
      return;
    }
    const auth = c.req.header('Authorization');
    const bearer = auth?.startsWith('Bearer ') ? auth.slice('Bearer '.length) : undefined;
    const resolution: TokenResolution = await resolveToken(pool, bearer);
    if (!resolution.ok) {
      return problem(c, {
        status: resolution.status,
        code: resolution.status === 401 ? 'UNAUTHENTICATED' : 'FORBIDDEN',
        title: resolution.status === 401 ? 'Unauthenticated' : 'Forbidden',
        detail: resolution.reason,
        requestId: c.get('requestId'),
      });
    }
    c.set('user', resolution.user);
    await next();
  });

  app.get('/health', (c) => c.json({ ok: true }));

  app.get('/me', async (c) => {
    const user = c.get('user');
    const company = await withStudioTx(pool, user, async ({ db }) => {
      const rows = await db
        .select({
          id: studios.id,
          name: studios.name,
          currency: studios.currency,
          timezone: studios.timezone,
        })
        .from(studios)
        .where(eq(studios.id, user.studioId))
        .limit(1);
      return rows[0] ?? null;
    });
    if (!company) {
      return problem(c, {
        status: 404,
        code: 'COMPANY_NOT_FOUND',
        title: 'Company not found',
        detail: 'The studio for this token was not found.',
        requestId: c.get('requestId'),
      });
    }
    return c.json({
      data: {
        capabilities: projectCapabilities(user.role),
        company: {
          id: company.id,
          name: company.name,
          currency: company.currency,
          timezone: company.timezone,
        },
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
        },
      },
      meta: meta(c.get('requestId')),
    });
  });

  // SOL-28 revision 7: the engagement-scoped Contracts surface, the guarded
  // money routes (quotation, variation-order, invoice reads + collection),
  // the project finance roll-up, and the 410 deprecation shims for the
  // replaced project-scoped money routes. All run on the tenant path inside
  // `withStudioTx`; the guarded writes additionally carry the idempotency and
  // entity-version guards (see `guards.ts`).
  registerBudgetRoutes(app, pool);
  registerContractRoutes(app, pool);
  registerProjectRoutes(app, pool);
  registerQuotationRoutes(app, pool);
  registerVariationOrderRoutes(app, pool);
  registerInvoiceRoutes(app, pool);
  registerFinanceRoutes(app, pool);

  // SOL-25 revision 24: the tax surface (discovery, preview, guarded custom
  // rule and supplier-recording writes, and the three issue operations with
  // atomic tax snapshots and the revision-24 build gate). Registered before
  // the SOL-28 deprecation shims: the contract declares the project-scoped
  // send/issue operations with the tax surface (no 410 on those paths), so
  // the tax handlers win those two paths; every other shim stays live.
  registerRegisterRoutes(app, pool);
  registerTimesheetRoutes(app, pool);
  registerTaxRoutes(app, pool);
  registerDeprecatedRoutes(app, pool);

  // SOL-131 problem 3: an unexpected SQL state inside a route (guarded write
  // or read) must surface as a typed Problem response, never a bare error
  // page. Known client-correctable states become 4xx; everything else is a
  // typed 500 INTERNAL_ERROR carrying the request id. The guarded-write
  // transaction rolls back before this fires, so a same-key retry re-executes
  // cleanly.
  app.onError((err, c) => {
    // eslint-disable-next-line no-console
    console.error('onError query:', (err as { query?: string }).query);
    const sqlState = sqlStateOf(err);
    if (sqlState !== null) {
      return problemFromSqlState(c, sqlState);
    }
    return problem(c, {
      status: 500,
      code: 'INTERNAL_ERROR',
      title: 'Internal server error',
      detail: 'The server could not complete the request.',
      requestId: c.get('requestId'),
    });
  });

  return app;
}
