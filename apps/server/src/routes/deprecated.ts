/**
 * Deprecation shims for the replaced project-scoped money routes (SOL-28
 * revision 7, redline §6).
 *
 * Every replaced project-scoped money route returns `410 GONE` with problem
 * code `DEPRECATED_ROUTE` and a `Link` header to the engagement-scoped
 * replacement. No project-scoped money route accepts a read or a write.
 */

import type { Hono } from 'hono';
import type { Pool } from 'pg';

import type { ServerEnv } from '../app';
import { problem } from '../http';

/** Registers the 410 deprecation shims for the replaced project money routes. */
export function registerDeprecatedRoutes(app: Hono<ServerEnv>, _pool: Pool): void {
  // Quotation family → /projects/{id}/engagements/{engId}/quotations
  app.get('/projects/:id/quotations', (c) => {
    const response = problem(c, {
      status: 410,
      code: 'DEPRECATED_ROUTE',
      title: 'Route deprecated',
      detail: 'Use the engagement-scoped quotation route.',
      requestId: c.get('requestId'),
    });
    response.headers.set(
      'Link',
      `<${`/projects/${c.req.param('id')}/engagements/{engagementId}/quotations`}>; rel="successor"`,
    );
    return response;
  });
  app.post('/projects/:id/quotations', (c) =>
    problem(c, {
      status: 410,
      code: 'DEPRECATED_ROUTE',
      title: 'Route deprecated',
      detail: 'Use the engagement-scoped quotation create route.',
      requestId: c.get('requestId'),
    }),
  );
  app.post('/projects/:id/quotations/:quotationId/fee', (c) =>
    problem(c, {
      status: 410,
      code: 'DEPRECATED_ROUTE',
      title: 'Route deprecated',
      detail: 'Use the engagement-scoped quotation fee route.',
      requestId: c.get('requestId'),
    }),
  );
  app.post('/projects/:id/quotations/:quotationId/payment-schedule', (c) =>
    problem(c, {
      status: 410,
      code: 'DEPRECATED_ROUTE',
      title: 'Route deprecated',
      detail: 'Use the engagement-scoped quotation payment-schedule route.',
      requestId: c.get('requestId'),
    }),
  );
  app.post('/projects/:id/quotations/:quotationId/send', (c) =>
    problem(c, {
      status: 410,
      code: 'DEPRECATED_ROUTE',
      title: 'Route deprecated',
      detail: 'Use the engagement-scoped quotation send route.',
      requestId: c.get('requestId'),
    }),
  );
  app.post('/projects/:id/quotations/:quotationId/acceptance', (c) =>
    problem(c, {
      status: 410,
      code: 'DEPRECATED_ROUTE',
      title: 'Route deprecated',
      detail: 'Use the engagement-scoped quotation acceptance route.',
      requestId: c.get('requestId'),
    }),
  );

  // Variation-order family → /projects/{id}/engagements/{engId}/variation-orders
  app.get('/projects/:id/variation-orders', (c) =>
    problem(c, {
      status: 410,
      code: 'DEPRECATED_ROUTE',
      title: 'Route deprecated',
      detail: 'Use the engagement-scoped variation-order route.',
      requestId: c.get('requestId'),
    }),
  );
  app.get('/projects/:id/variation-orders/:variationOrderId', (c) =>
    problem(c, {
      status: 410,
      code: 'DEPRECATED_ROUTE',
      title: 'Route deprecated',
      detail: 'Use the engagement-scoped variation-order detail route.',
      requestId: c.get('requestId'),
    }),
  );
  app.post('/projects/:id/project-changes/:changeId/variation-order', (c) =>
    problem(c, {
      status: 410,
      code: 'DEPRECATED_ROUTE',
      title: 'Route deprecated',
      detail: 'Use the engagement-scoped approve-and-issue route.',
      requestId: c.get('requestId'),
    }),
  );

  // Contracts family → /projects/{id}/engagements/{engId}/contracts
  app.get('/projects/:id/contracts', (c) =>
    problem(c, {
      status: 410,
      code: 'DEPRECATED_ROUTE',
      title: 'Route deprecated',
      detail: 'Use the engagement-scoped contracts route.',
      requestId: c.get('requestId'),
    }),
  );
  app.get('/projects/:id/contracts/:contractId', (c) =>
    problem(c, {
      status: 410,
      code: 'DEPRECATED_ROUTE',
      title: 'Route deprecated',
      detail: 'Use the engagement-scoped contract detail route.',
      requestId: c.get('requestId'),
    }),
  );

  // Invoice writes → engagement-scoped; draft/issue/payment stay denied.
  app.post('/projects/:id/finance/invoices/:invoiceId/collection', (c) =>
    problem(c, {
      status: 410,
      code: 'DEPRECATED_ROUTE',
      title: 'Route deprecated',
      detail: 'Use the engagement-scoped invoice collection route.',
      requestId: c.get('requestId'),
    }),
  );
  app.post('/projects/:id/finance/invoices/:invoiceId/issue', (c) =>
    problem(c, {
      status: 410,
      code: 'DEPRECATED_ROUTE',
      title: 'Route deprecated',
      detail: 'Use the engagement-scoped invoice issue route.',
      requestId: c.get('requestId'),
    }),
  );
  app.post('/projects/:id/finance/invoices/:invoiceId/payment', (c) =>
    problem(c, {
      status: 410,
      code: 'DEPRECATED_ROUTE',
      title: 'Route deprecated',
      detail: 'Use the engagement-scoped invoice payment route.',
      requestId: c.get('requestId'),
    }),
  );
}
