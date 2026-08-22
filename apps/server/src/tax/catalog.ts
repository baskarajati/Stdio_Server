/**
 * The studio tax-rule catalog entity tag. SOL-25 revision 24, section 9.9.
 *
 * The catalog is the union of the central verified register (visible to every
 * studio) and the studio's own custom rules. Its entity version is the
 * `ETag` on `GET /tax-rules/resolve`, the precondition value for the custom
 * rule writes (`If-Match`) and the optional `x-stdio-tax-catalog-tag` on the
 * issue operations.
 *
 * The tag is a SHA-256 over the sorted `(id, version, entityVersion)` rows,
 * so any rule change — central or custom — changes the tag. RLS already
 * scopes the read to CENTRAL rows plus the studio's own rows.
 */

import { createHash } from 'node:crypto';

import { schema } from '@stdio/db';
import { eq, or } from 'drizzle-orm';

import type { Db } from '../context/db';

const { taxRules } = schema;

/** Computes the current catalog entity version for one studio. */
export async function catalogEntityTag(scoped: Db): Promise<string> {
  const rows = await scoped.db
    .select({
      id: taxRules.id,
      version: taxRules.version,
      entityVersion: taxRules.entityVersion,
    })
    .from(taxRules)
    .where(or(eq(taxRules.ownerType, 'CENTRAL'), eq(taxRules.studioId, scoped.studioId)));

  const ordered = [...rows].sort((a, b) => {
    if (a.id !== b.id) {
      return a.id < b.id ? -1 : 1;
    }
    return a.version - b.version;
  });
  const hash = createHash('sha256');
  for (const row of ordered) {
    hash.update(`${row.id}:${row.version}:${row.entityVersion}\n`);
  }
  return hash.digest('hex');
}
