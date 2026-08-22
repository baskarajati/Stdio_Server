/**
 * Project register and detail routes (contract `/projects`).
 *
 * The native app's navigation starts at the project register: opening a
 * project yields its engagements, and the engagement-scoped money routes
 * (SOL-28 revision 7) hang off `currentEngagementID`. Every route runs on
 * the tenant path inside `withStudioTx`, so one studio can never see another
 * studio's projects (ADR 0002, RLS).
 *
 * Labels (`statusLabel`, `stageLabel`, `projectTypeLabel`, the engagement
 * labels, the signals) are derived by the server from stored values; the
 * schema stores the codes, never the labels. `counts.approvals`,
 * `counts.files`, `counts.openTasks` and `counts.specItems` are 0 until those
 * registers exist in the schema; `counts.quotations` is a live count of the
 * quotation rows on the project.
 *
 * `GET /projects/{id}` returns the ETag header per the contract.
 */

import { schema } from '@stdio/db';
import { and, count, desc, eq, ilike, inArray, or, type SQL, sql } from 'drizzle-orm';
import type { Hono } from 'hono';
import type { Pool } from 'pg';

import type { ServerEnv } from '../app';
import { projectCapabilities } from '../capabilities';
import { type Db, type StudioRole, withStudioTx } from '../context/db';
import { etagFor, meta, problem, requestBuildOf } from '../http';
import { jsonResponse } from '../money';
import { dateLabel, statusLabel } from '../projections';

const { projects, projectEngagements, clients, users, quotations } = schema;

type ProjectRow = {
  id: string;
  projectCode: string;
  name: string;
  description: string | null;
  clientId: string;
  siteAddress: string | null;
  startDate: Date | null;
  endDate: Date | null;
  status: string;
  projectType: string;
  serviceModel: string | null;
  managerId: string | null;
  blueprintId: string | null;
  entityVersion: string;
  updatedAt: Date;
  clientName: string | null;
  managerName: string | null;
};

type EngagementRow = {
  id: string;
  projectId: string;
  kind: string;
  sortOrder: string;
  lifecycleStatus: string;
  contractState: string;
  currentPhaseKey: string | null;
  phaseCount: string;
  completedPhaseCount: string;
  gatedByEngagementId: string | null;
  isGateSatisfied: string | null;
  entityVersion: string;
};

/**
 * `numeric` count columns arrive as strings; the wire type is integer.
 * Used by every count and order field on this surface.
 */
function intOf(value: string | null | undefined, fallback = 0): number {
  if (value === null || value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : fallback;
}

/**
 * `is_gate_satisfied` is a stored `'true'`/`'false'` text column; the wire
 * type is boolean-or-null. Empty and missing map to null.
 */
function boolOrNull(value: string | null | undefined): boolean | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  return value === 'true';
}

/** The project-level health signal from the engagement roll-up. */
function projectHealth(engagements: EngagementRow[]): { label: string; tone: string } {
  if (engagements.length === 0) {
    return { label: 'No engagements', tone: 'neutral' };
  }
  const inactive = engagements.filter((e) => e.lifecycleStatus !== 'ACTIVE');
  if (inactive.length > 0) {
    return { label: 'Attention needed', tone: 'warning' };
  }
  return { label: 'On track', tone: 'success' };
}

/** The timeline signal from the scheduled dates. */
function projectTimeline(row: ProjectRow): { label: string; tone: string } {
  if (row.startDate === null && row.endDate === null) {
    return { label: 'Not scheduled', tone: 'neutral' };
  }
  const parts: string[] = [];
  if (row.startDate !== null) {
    const starts = dateLabel(row.startDate);
    if (starts !== null) {
      parts.push(`Starts ${starts}`);
    }
  }
  if (row.endDate !== null) {
    const ends = dateLabel(row.endDate);
    if (ends !== null) {
      parts.push(`Ends ${ends}`);
    }
  }
  return { label: parts.join(' · '), tone: 'info' };
}

/** The stage label: the current phase of the first active engagement, else the status. */
function projectStage(row: ProjectRow, engagements: EngagementRow[]): string {
  const active = engagements.find((e) => e.lifecycleStatus === 'ACTIVE');
  if (active?.currentPhaseKey) {
    return statusLabel(active.currentPhaseKey) ?? statusLabel(row.status) ?? row.status;
  }
  return statusLabel(row.status) ?? row.status;
}

/**
 * Project-level capabilities. Reads are open to every staff role; status
 * writes are frozen (S5) and cancellation is not implemented yet, so both
 * are disabled with the reason the UI must show (D-042).
 */
function projectCapabilitiesFor(role: StudioRole) {
  const caps = projectCapabilities(role);
  return {
    read: { enabled: caps.canReadContracts.enabled, reason: caps.canReadContracts.reason },
    write: {
      enabled: false,
      reason:
        'Project status is derived from the engagement state. Status writes are frozen on the server (S5).',
    },
    cancel: { enabled: false, reason: 'Project cancellation is not available yet.' },
  };
}

/** One `ProjectSummary` wire object. */
function projectSummary(
  row: ProjectRow,
  engagementRows: EngagementRow[],
  quotationCount: number,
  role: StudioRole,
): Record<string, unknown> {
  const engagements = engagementRows.map((e) => ({
    id: e.id,
    entityVersion: e.entityVersion,
    kind: e.kind,
    kindLabel: statusLabel(e.kind) ?? e.kind,
    sortOrder: intOf(e.sortOrder),
    lifecycleStatus: e.lifecycleStatus,
    lifecycleLabel: statusLabel(e.lifecycleStatus) ?? e.lifecycleStatus,
    contractState: e.contractState,
    contractStateLabel: statusLabel(e.contractState) ?? e.contractState,
    currentPhase: e.currentPhaseKey
      ? {
          key: e.currentPhaseKey,
          label: statusLabel(e.currentPhaseKey) ?? e.currentPhaseKey,
          position: `${intOf(e.completedPhaseCount) + 1} of ${intOf(e.phaseCount, 1)}`,
        }
      : null,
    phaseCount: intOf(e.phaseCount),
    completedPhaseCount: intOf(e.completedPhaseCount),
    gatedByEngagementId: e.gatedByEngagementId,
    isGateSatisfied: boolOrNull(e.isGateSatisfied),
  }));

  const status = row.status;
  return {
    blueprintId: row.blueprintId,
    capabilities: projectCapabilitiesFor(role),
    client: { id: row.clientId, name: row.clientName ?? 'Unnamed client' },
    counts: {
      approvals: 0,
      files: 0,
      openTasks: 0,
      quotations: quotationCount,
      specItems: 0,
    },
    description: row.description,
    enabledModules: null,
    endDate: row.endDate ? row.endDate.toISOString() : null,
    engagements,
    entityVersion: row.entityVersion,
    health: projectHealth(engagementRows),
    id: row.id,
    manager: row.managerId && row.managerName ? { id: row.managerId, name: row.managerName } : null,
    name: row.name,
    nextAction: {
      id: 'open-project',
      label: 'Open project',
      capability: { enabled: true, reason: '' },
      targetEntityId: row.id,
      targetTab: 'overview',
    },
    projectCode: row.projectCode,
    projectTypeLabel: statusLabel(row.projectType) ?? row.projectType,
    serviceModelLabel: row.serviceModel
      ? (statusLabel(row.serviceModel) ?? row.serviceModel)
      : null,
    siteAddress: row.siteAddress,
    source: { href: `/projects/${row.id}`, type: 'project' },
    stageLabel: projectStage(row, engagementRows),
    startDate: row.startDate ? row.startDate.toISOString() : null,
    status,
    statusLabel: statusLabel(status) ?? status,
    statusSignal: {
      label: statusLabel(status) ?? status,
      tone: status === 'ACTIVE' ? 'success' : 'neutral',
    },
    timeline: projectTimeline(row),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The project rows plus client and manager names, scoped to this studio. */
async function loadProjects(
  scoped: Db,
  where: SQL | undefined,
  options: { order?: 'desc' | 'asc'; limit?: number; offset?: number } = {},
): Promise<ProjectRow[]> {
  const { order = 'desc', limit, offset } = options;
  const query = scoped.db
    .select({
      id: projects.id,
      projectCode: projects.projectCode,
      name: projects.name,
      description: projects.description,
      clientId: projects.clientId,
      siteAddress: projects.siteAddress,
      startDate: projects.startDate,
      endDate: projects.endDate,
      status: projects.status,
      projectType: projects.projectType,
      serviceModel: projects.serviceModel,
      managerId: projects.managerId,
      blueprintId: projects.blueprintId,
      entityVersion: projects.entityVersion,
      updatedAt: projects.updatedAt,
      clientName: clients.name,
      managerName: users.name,
    })
    .from(projects)
    .leftJoin(
      clients,
      and(eq(clients.id, projects.clientId), eq(clients.studioId, projects.studioId)),
    )
    .leftJoin(users, and(eq(users.id, projects.managerId), eq(users.studioId, projects.studioId)))
    .where(where)
    .orderBy(order === 'desc' ? desc(projects.updatedAt) : sql`${projects.updatedAt} asc`);
  if (limit === undefined && offset === undefined) {
    return query;
  }
  return query.limit(limit ?? 0).offset(offset ?? 0);
}

/** The engagements of one project, scoped to this studio. */
async function loadEngagements(scoped: Db, projectId: string): Promise<EngagementRow[]> {
  return scoped.db
    .select({
      id: projectEngagements.id,
      projectId: projectEngagements.projectId,
      kind: projectEngagements.kind,
      sortOrder: projectEngagements.sortOrder,
      lifecycleStatus: projectEngagements.lifecycleStatus,
      contractState: projectEngagements.contractState,
      currentPhaseKey: projectEngagements.currentPhaseKey,
      phaseCount: projectEngagements.phaseCount,
      completedPhaseCount: projectEngagements.completedPhaseCount,
      gatedByEngagementId: projectEngagements.gatedByEngagementId,
      isGateSatisfied: projectEngagements.isGateSatisfied,
      entityVersion: projectEngagements.entityVersion,
    })
    .from(projectEngagements)
    .where(eq(projectEngagements.projectId, projectId))
    .orderBy(sql`${projectEngagements.sortOrder} asc`);
}

/** The live quotation count on the project, scoped to this studio. */
async function loadQuotationCount(scoped: Db, projectId: string): Promise<number> {
  const rows = await scoped.db
    .select({ value: count() })
    .from(quotations)
    .where(eq(quotations.projectId, projectId));
  return intOf(String(rows[0]?.value ?? 0));
}

export function registerProjectRoutes(app: Hono<ServerEnv>, pool: Pool): void {
  // GET /projects — the register. Optional `q`, `page`, `pageSize`.
  app.get('/projects', async (c) => {
    const user = c.get('user');
    const q = c.req.query('q');
    const pageRaw = c.req.query('page');
    const pageSizeRaw = c.req.query('pageSize');
    const page = Math.max(1, intOf(pageRaw, 1));
    const pageSize = Math.min(100, Math.max(1, intOf(pageSizeRaw, 10)));
    const search = q?.trim() || null;
    const build = requestBuildOf(c);

    const result = await withStudioTx(pool, user, async (scoped) => {
      const filter: SQL | undefined = search
        ? or(ilike(projects.name, `%${search}%`), ilike(projects.projectCode, `%${search}%`))
        : undefined;

      const totalRows = await scoped.db
        .select({ value: count() })
        .from(projects)
        .where(filter ?? sql`true`);
      const totalItems = intOf(String(totalRows[0]?.value ?? 0));
      const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));

      const rows = await loadProjects(scoped, filter ?? sql`true`, {
        limit: pageSize,
        offset: (page - 1) * pageSize,
      });

      const engagementByProject = new Map<string, EngagementRow[]>();
      const ids = rows.map((r) => r.id);
      if (ids.length > 0) {
        const allEngagements = await scoped.db
          .select({
            id: projectEngagements.id,
            projectId: projectEngagements.projectId,
            kind: projectEngagements.kind,
            sortOrder: projectEngagements.sortOrder,
            lifecycleStatus: projectEngagements.lifecycleStatus,
            contractState: projectEngagements.contractState,
            currentPhaseKey: projectEngagements.currentPhaseKey,
            phaseCount: projectEngagements.phaseCount,
            completedPhaseCount: projectEngagements.completedPhaseCount,
            gatedByEngagementId: projectEngagements.gatedByEngagementId,
            isGateSatisfied: projectEngagements.isGateSatisfied,
            entityVersion: projectEngagements.entityVersion,
          })
          .from(projectEngagements)
          .where(inArray(projectEngagements.projectId, ids))
          .orderBy(sql`${projectEngagements.sortOrder} asc`);
        for (const engagement of allEngagements) {
          const list = engagementByProject.get(engagement.projectId) ?? [];
          list.push(engagement);
          engagementByProject.set(engagement.projectId, list);
        }
      }

      const summaries = [];
      for (const row of rows) {
        const quotationCount = await loadQuotationCount(scoped, row.id);
        summaries.push(
          projectSummary(row, engagementByProject.get(row.id) ?? [], quotationCount, user.role),
        );
      }
      return {
        status: 200 as const,
        data: { projects: summaries },
        pagination: { page, pageSize, totalItems, totalPages },
      };
    });

    return jsonResponse({
      data: result.data,
      meta: meta(c.get('requestId'), { requestBuild: build, pagination: result.pagination }),
    });
  });

  // GET /projects/{id} — detail with the weak ETag.
  app.get('/projects/:id', async (c) => {
    const user = c.get('user');
    const projectId = c.req.param('id');
    const build = requestBuildOf(c);

    const result = await withStudioTx(pool, user, async (scoped) => {
      const rows = await loadProjects(scoped, eq(projects.id, projectId));
      const row = rows[0];
      if (!row) {
        return { status: 404 as const };
      }
      const engagements = await loadEngagements(scoped, projectId);
      const quotationCount = await loadQuotationCount(scoped, projectId);
      return {
        status: 200 as const,
        project: projectSummary(row, engagements, quotationCount, user.role),
        entityVersion: row.entityVersion,
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
    return jsonResponse(
      {
        data: { project: result.project },
        meta: meta(c.get('requestId'), { requestBuild: build }),
      },
      { headers: { ETag: etagFor(result.entityVersion) } },
    );
  });
}
