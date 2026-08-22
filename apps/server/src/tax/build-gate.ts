/**
 * The native release boundary. SOL-25 revision 24 section 9.9.
 *
 * Per-operation minimum native build: the three issue operations (quotation
 * send, invoice issue, milestone invoice) AND the three new tax write paths
 * carry `TAX_ISSUE_MINIMUM_NATIVE_BUILD = 2` because they speak the
 * revision-24 tax surface (section 9.9: "Their minimum build is also 2");
 * every other operation keeps the global `MINIMUM_SUPPORTED_BUILD = 1`.
 *
 * The gate runs AFTER auth + 404 resolution and BEFORE the idempotency
 * replay and body validation. A build below the floor is `426
 * NATIVE_BUILD_UPGRADE_REQUIRED` and never consumes the Idempotency-Key
 * (CEO ruling condition 3, N66).
 */

import type { Context } from 'hono';

import { buildUpgradeRequired, problem } from '../http';

/** The floor for the three revision-24 issue operations. */
export const TAX_ISSUE_MINIMUM_NATIVE_BUILD = 2;

/**
 * The build-gate for an operation whose native-build header is OPTIONAL but
 * whose minimum is higher than 1 (the issue operations). A missing or
 * unparseable header is effective build 0 and fails closed. Returns a 426
 * Response or null to pass.
 */
export function issueBuildGate(c: Context): Response | null {
  const raw = c.req.header('x-businessapp-native-build');
  const build = raw === undefined || raw === '' ? 0 : Number(raw);
  if (Number.isSafeInteger(build) && build >= TAX_ISSUE_MINIMUM_NATIVE_BUILD) {
    return null;
  }
  const requestBuild = Number.isSafeInteger(build) ? build : null;
  return buildUpgradeRequired(c, TAX_ISSUE_MINIMUM_NATIVE_BUILD, requestBuild);
}

/**
 * The header gate for an operation with `NativeBuildRequired` (the new tax
 * write paths and preview). The header is REQUIRED; a missing value is the
 * exact `400 NATIVE_BUILD_HEADER_REQUIRED` (section 9.7 table). The global
 * floor for these paths is 1, so a present build always passes here.
 */
export function requireNativeBuildHeader(c: Context): Response | null {
  const raw = c.req.header('x-businessapp-native-build');
  if (raw === undefined || raw === '') {
    return problem(c, {
      status: 400,
      code: 'NATIVE_BUILD_HEADER_REQUIRED',
      title: 'Native build header required',
      detail: 'This operation requires the x-businessapp-native-build header.',
      requestId: c.get('requestId'),
    });
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    return problem(c, {
      status: 400,
      code: 'INVALID_NATIVE_BUILD',
      title: 'Invalid native build',
      detail: `The x-businessapp-native-build header must be a positive integer, got "${raw}".`,
      requestId: c.get('requestId'),
    });
  }
  return null;
}

/**
 * The build gate for the new write paths: the header is present (validated
 * above) but its value must also meet the operation minimum of 2. Section
 * 9.9: "Their minimum build is also 2, and no shipped build calls them."
 */
export function newWriteBuildGate(c: Context): Response | null {
  const raw = c.req.header('x-businessapp-native-build') ?? '';
  const build = Number(raw);
  if (Number.isSafeInteger(build) && build >= TAX_ISSUE_MINIMUM_NATIVE_BUILD) {
    return null;
  }
  return buildUpgradeRequired(c, TAX_ISSUE_MINIMUM_NATIVE_BUILD, build);
}

/** The `RequestIdRequired` header gate: `400 REQUEST_ID_HEADER_REQUIRED`. */
export function requireRequestIdHeader(c: Context): Response | null {
  if (!c.req.header('x-request-id')) {
    return problem(c, {
      status: 400,
      code: 'REQUEST_ID_HEADER_REQUIRED',
      title: 'Request id header required',
      detail: 'This operation requires the x-request-id header.',
      requestId: c.get('requestId'),
    });
  }
  return null;
}
