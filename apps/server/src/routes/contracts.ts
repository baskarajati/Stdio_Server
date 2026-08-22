/**
 * Engagement-scoped contract lineage reads (SOL-28 revision 7).
 *
 * The contract surface is a read-only projection of `project_engagements`
 * plus the project. There is no separate contracts table in this release:
 * the engagement IS the contract anchor (D-019). `ContractRevisionSummary`
 * and `ContractSummary` are derived; `contractValue` is NUMBER-form money and
 * MUST be emitted losslessly via `RawDecimal`.
 */

import { schema } from '@stdio/db';
import { and, eq } from 'drizzle-orm';
import type { Hono } from 'hono';
import type { Pool } from 'pg';
import type { ServerEnv } from '../app';
import { projectCapabilities } from '../capabilities';
import { withStudioTx } from '../context/db';
import { resolveEngagement } from '../guards';
import { etagFor, meta, problem } from '../http';
import { jsonResponse, moneyNumber } from '../money';
import { moneyLabel } from '../projections';

const CONTRACT_STATE_MAP: Record<string, string> = {
  NONE: 'NOT_STARTED',
  DRAFT: 'DRAFT',
  SENT: 'SENT',
  SIGNED: 'SIGNED',
  BLOCKED: 'BLOCKED',
};

function contractStateOf(state: string | null): string {
  return CONTRACT_STATE_MAP[state ?? 'NONE'] ?? 'NOT_STARTED';
}

function revisionStatusOf(state: string | null): string {
  const mapped = contractStateOf(state);
  return mapped === 'SIGNED' || mapped === 'SENT' ? 'ISSUED' : 'DRAFT';
}

/**
 * Projects one engagement row into the `ContractSummary` wire shape.
 * `canReadFinance` masks the contract-value number (rev 7 §1.1 row 13).
 */
function projectContract(
  engagement: {
    id: string;
    kind: string;
    contractState: string | null;
    contractValue: string | null;
    currency: string;
    entityVersion: string;
    updatedAt: Date;
  },
  project: { projectCode: string; name: string },
  capabilities: ReturnType<typeof projectCapabilities>,
): Record<string, unknown> {
  const canReadFinance = capabilities.canReadFinance?.enabled ?? false;
  const href = `/projects/${project.projectCode}/engagements/${engagement.id}/contracts/${engagement.id}`;
  return {
    capabilities: {
      read: capabilities.canReadContracts,
      write: capabilities.canWriteVariationOrder,
    },
    contractState: contractStateOf(engagement.contractState),
    currentRevision: {
      id: engagement.id,
      status: revisionStatusOf(engagement.contractState),
      title: `${engagement.kind} contract`,
      currency: engagement.currency,
      contractValue: canReadFinance
        ? moneyNumber(engagement.contractValue ?? '0', engagement.currency)
        : null,
      contractValueLabel: canReadFinance
        ? moneyLabel(engagement.contractValue ?? '0', engagement.currency)
        : null,
      systemNumber: null,
      displayNumber: null,
      externalNumber: null,
      issuedAt: null,
      supersededAt: null,
      voidedAt: null,
      predecessorRevisionId: null,
      commencementTerms: null,
      completionTerms: null,
      formChannelRequirement: 'UNRESOLVED',
      updatedAt: engagement.updatedAt.toISOString(),
    },
    engagementId: engagement.id,
    engagementKind: engagement.kind,
    entityVersion: engagement.entityVersion,
    id: engagement.id,
    projectCode: project.projectCode,
    projectName: project.name,
    source: { href, type: 'contract' },
    updatedAt: engagement.updatedAt.toISOString(),
  };
}

/** Registers the engagement-scoped contract routes on `app`. */
export function registerContractRoutes(app: Hono<ServerEnv>, pool: Pool): void {
  // GET /projects/{id}/engagements/{engId}/contracts — the contract register
  // of one engagement (the current contract projection).
  app.get('/projects/:id/engagements/:engId/contracts', async (c) => {
    const user = c.get('user');
    const projectId = c.req.param('id');
    const engagementId = c.req.param('engId');

    const result = await withStudioTx(pool, user, async (scoped) => {
      const engagement = await resolveEngagement(scoped, projectId, engagementId);
      if (!engagement) {
        return { status: 404 as const };
      }
      const projectRows = await scoped.db
        .select({
          projectCode: schema.projects.projectCode,
          name: schema.projects.name,
        })
        .from(schema.projects)
        .where(eq(schema.projects.id, projectId))
        .limit(1);
      const project = projectRows[0];
      if (!project) {
        return { status: 404 as const };
      }
      const engagementRows = await scoped.db
        .select({
          id: schema.projectEngagements.id,
          kind: schema.projectEngagements.kind,
          contractState: schema.projectEngagements.contractState,
          contractValue: schema.projectEngagements.contractValue,
          currency: schema.projectEngagements.currency,
          entityVersion: schema.projectEngagements.entityVersion,
          updatedAt: schema.projectEngagements.updatedAt,
        })
        .from(schema.projectEngagements)
        .where(eq(schema.projectEngagements.id, engagementId))
        .limit(1);
      const engagementRow = engagementRows[0];
      if (!engagementRow) {
        return { status: 404 as const };
      }
      const capabilities = projectCapabilities(user.role);
      const contract = projectContract(engagementRow, project, capabilities);
      return {
        status: 200 as const,
        data: { contracts: [contract] },
        etag: engagementRow.entityVersion,
      };
    });

    if (result.status === 404) {
      return problem(c, {
        status: 404,
        code: 'ENGAGEMENT_NOT_FOUND',
        title: 'Engagement not found',
        detail: 'The engagement does not exist on this project, or the project does not exist.',
        requestId: c.get('requestId'),
      });
    }
    const response = jsonResponse({
      data: result.data,
      meta: meta(c.get('requestId')),
    });
    response.headers.set('ETag', etagFor(result.etag as string));
    return response;
  });

  // GET /projects/{id}/engagements/{engId}/contracts/{contractId} — one
  // contract detail (the engagement contract with the same id).
  app.get('/projects/:id/engagements/:engId/contracts/:contractId', async (c) => {
    const user = c.get('user');
    const projectId = c.req.param('id');
    const engagementId = c.req.param('engId');
    const contractId = c.req.param('contractId');

    if (contractId !== engagementId) {
      return problem(c, {
        status: 404,
        code: 'CONTRACT_NOT_FOUND',
        title: 'Contract not found',
        detail: 'The contract id must match the engagement id of the route.',
        requestId: c.get('requestId'),
      });
    }

    const result = await withStudioTx(pool, user, async (scoped) => {
      const engagement = await resolveEngagement(scoped, projectId, engagementId);
      if (!engagement) {
        return { status: 404 as const };
      }
      const rows = await scoped.db
        .select({
          id: schema.projectEngagements.id,
          kind: schema.projectEngagements.kind,
          contractState: schema.projectEngagements.contractState,
          contractValue: schema.projectEngagements.contractValue,
          currency: schema.projectEngagements.currency,
          entityVersion: schema.projectEngagements.entityVersion,
          updatedAt: schema.projectEngagements.updatedAt,
          projectCode: schema.projects.projectCode,
          projectName: schema.projects.name,
        })
        .from(schema.projectEngagements)
        .innerJoin(schema.projects, eq(schema.projects.id, schema.projectEngagements.projectId))
        .where(
          and(
            eq(schema.projectEngagements.id, engagementId),
            eq(schema.projectEngagements.projectId, projectId),
          ),
        )
        .limit(1);
      const row = rows[0];
      if (!row) {
        return { status: 404 as const };
      }
      const capabilities = projectCapabilities(user.role);
      const summary = projectContract(
        row,
        { projectCode: row.projectCode, name: row.projectName },
        capabilities,
      );
      const detail = {
        ...summary,
        partySnapshots: [],
        evidence: [],
        revisions: [summary.currentRevision],
      };
      return { status: 200 as const, data: { contract: detail }, etag: row.entityVersion };
    });

    if (result.status === 404) {
      return problem(c, {
        status: 404,
        code: 'CONTRACT_NOT_FOUND',
        title: 'Contract not found',
        detail: 'The contract does not exist on this engagement.',
        requestId: c.get('requestId'),
      });
    }
    const response = jsonResponse({
      data: result.data,
      meta: meta(c.get('requestId')),
    });
    response.headers.set('ETag', etagFor(result.etag as string));
    return response;
  });
}
