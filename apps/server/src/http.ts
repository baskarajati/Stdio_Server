/**
 * The RFC-style Problem envelope and the Meta payload the contract requires.
 *
 * `Problem` (contract `components/schemas/Problem`) is the error shape for
 * every non-2xx response. `Meta` (contract `components/schemas/Meta`) carries
 * `apiVersion`, `compatibility`, and `requestId` on every response.
 */

import type { Context } from 'hono';

export type ProblemBody = {
  type: string;
  title: string;
  status: number;
  detail: string;
  code: string;
  requestId: string;
  details?: Record<string, unknown>;
};

const API_VERSION = '2026-06-23';
export const MINIMUM_SUPPORTED_BUILD = 1;

/** The per-operation native build floor. SOL-25 revision 24 section 9.9. */
export const TAX_ISSUE_MINIMUM_NATIVE_BUILD = 2;

export type MetaOptions = {
  /** The minimum native build for this operation (default 1). */
  minimumSupportedBuild?: number;
  /** The `x-businessapp-native-build` header of the request, if any. */
  requestBuild?: number | null;
  pagination?: Pagination;
};

/**
 * Builds the `Meta` object shared by every response. The compatibility block
 * reflects the request build against the operation's minimum: a build below
 * the floor reports `upgradeRequired` / `blocked` so the native client can
 * gate its UI even on responses that are not 426.
 */
export function meta(requestId: string, options: MetaOptions = {}) {
  const minimumSupportedBuild = options.minimumSupportedBuild ?? MINIMUM_SUPPORTED_BUILD;
  const requestBuild = options.requestBuild ?? null;
  const supported = requestBuild === null || requestBuild >= minimumSupportedBuild;
  return {
    apiVersion: API_VERSION,
    compatibility: {
      apiVersion: API_VERSION,
      supported,
      status: supported ? ('allowed' as const) : ('upgradeRequired' as const),
      blocked: !supported,
      message: supported
        ? null
        : `Native build ${requestBuild} is below the minimum supported build ${minimumSupportedBuild}.`,
      minimumSupportedBuild,
      requestBuild,
    },
    requestId,
    ...(options.pagination ? { pagination: options.pagination } : {}),
  };
}

/**
 * The `MutationMeta` envelope (SOL-19 revision 6): `Meta` plus the required
 * `idempotentReplay` flag. The guard flips `false` to `true` in the stored
 * response TEXT on a same-key replay, so money tokens stay byte-exact.
 */
export function mutationMeta(
  requestId: string,
  options: MetaOptions = {},
): Record<string, unknown> {
  return { ...meta(requestId, options), idempotentReplay: false };
}

/** Reads the optional `x-businessapp-native-build` header. */
export function requestBuildOf(c: Context): number | null {
  const raw = c.req.header('x-businessapp-native-build');
  if (raw === undefined || raw === '') {
    return null;
  }
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : null;
}

export type Pagination = {
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
};

/**
 * Builds the `ETag` response header from an entity version. The contract
 * serializes `entityVersion` (a UUID) as a weak entity tag.
 */
export function etagFor(entityVersion: string): string {
  return `W/"${entityVersion}"`;
}

/** Writes a Problem response with a stable `type` URN, `code` and HTTP status. */
export function problem(
  c: Context,
  opts: {
    status: number;
    code: string;
    title: string;
    detail: string;
    requestId: string;
    details?: Record<string, unknown>;
  },
): Response {
  const body: ProblemBody = {
    type: 'urn:stdio:error',
    title: opts.title,
    status: opts.status,
    detail: opts.detail,
    code: opts.code,
    requestId: opts.requestId,
    ...(opts.details ? { details: opts.details } : {}),
  };
  return c.json(body, opts.status as 400);
}

/**
 * The 426 the native release boundary emits (SOL-25 revision 24 section 9.9).
 * It fires BEFORE body validation and before the idempotency replay, so a
 * rejected attempt never consumes the Idempotency-Key. The `details` block
 * carries the compatibility state the client needs to show an upgrade path.
 */
export function buildUpgradeRequired(
  c: Context,
  minimumSupportedBuild: number,
  requestBuild: number | null,
): Response {
  return problem(c, {
    status: 426,
    code: 'NATIVE_BUILD_UPGRADE_REQUIRED',
    title: 'Native build upgrade required',
    detail:
      `Native build ${requestBuild ?? 'unknown'} is below the minimum supported build ` +
      `${minimumSupportedBuild} for this operation. Update the native app before retrying.`,
    requestId: c.get('requestId'),
    details: {
      upgradeRequired: true,
      minimumSupportedBuild,
      requestBuild,
    },
  });
}
