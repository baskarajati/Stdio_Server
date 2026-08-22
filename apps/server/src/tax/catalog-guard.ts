/**
 * The one tax-catalog precondition (SOL-25 revision 24, section 9.8).
 *
 * The catalog tag is the opaque studio-scoped value `GET /tax-rules/resolve`
 * returns in its ETag header. A new document must use the current studio tax
 * catalog: a stale tag and a tag issued to another studio both fail with the
 * identical `409 TAX_RULE_CATALOG_CONFLICT` body, disclosing nothing about
 * the catalog or any other studio.
 *
 * The check runs AFTER the idempotency replay inside a guarded write, so a
 * resolved replay never evaluates a stale precondition (N66).
 */

import type { Db } from '../context/db';
import { catalogEntityTag } from './catalog';
import { type TaxProblemSpec, taxCatalogConflict } from './codes';

export type CatalogCheckResult = { ok: true } | { ok: false; spec: TaxProblemSpec };

/**
 * Normalizes a submitted tag. The discovery response emits the tag as an
 * ETag header (`W/"<hex>"`); a client may echo that header value verbatim,
 * so both the wrapped and the bare hex forms compare against the current
 * catalog.
 */
function normalizeTag(submittedTag: string): string {
  return submittedTag.replace(/^W\//, '').replace(/^"|"$/g, '');
}

/** Compares the submitted tag to the current catalog; both failure causes
 *  produce the identical spec. */
export async function checkCatalogTag(
  scoped: Db,
  submittedTag: string,
): Promise<CatalogCheckResult> {
  const current = await catalogEntityTag(scoped);
  if (current !== normalizeTag(submittedTag)) {
    return { ok: false, spec: taxCatalogConflict() };
  }
  return { ok: true };
}
