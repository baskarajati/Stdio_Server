/**
 * Integration tests for the project register and detail routes.
 *
 * Runs against the live `stdio_dev` database (seed: Studio Contoh, one
 * project with a DESIGN and a BUILD engagement). Proves the acceptance
 * criteria for the app's navigation entry point:
 *
 * - `GET /projects` returns the contract `ProjectSummary` shape with
 *   engagements, client, counts, capabilities and signals.
 * - `GET /projects/{id}` returns the detail with the weak ETag.
 * - The studio boundary stays hard: a second studio's project is never
 *   visible and its id is a 404.
 * - The register honours `q` (name and project-code search) and pagination.
 */

import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from './app';

const connectionString =
  process.env.DATABASE_URL ?? 'postgres://stdio:stdio@localhost:5432/stdio_dev';

const SEED_STUDIO = '00000000-0000-4000-8000-000000000001';
const SEED_OWNER = '00000000-0000-4000-8000-000000000002';
const SEED_PROJECT = '00000000-0000-4000-8000-000000000004';
const SEED_CLIENT = '00000000-0000-4000-8000-000000000003';
const OTHER_STUDIO = '00000000-0000-4000-8000-0000000000aa';
const OTHER_USER = '00000000-0000-4000-8000-0000000000bb';

let pool: Pool;
let app: ReturnType<typeof createApp>;
let token: string = '';

async function tenantQuery<T>(
  studioId: string,
  fn: (client: {
    query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
  }) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', ['app.studio_id', studioId]);
    await client.query('SET LOCAL ROLE studio_app');
    const result = await fn(client as never);
    await client.query('COMMIT');
    return result;
  } finally {
    client.release(true);
  }
}

async function mintToken(studioId: string, userId: string, value: string): Promise<void> {
  await tenantQuery(studioId, async (client) => {
    await client.query(
      `INSERT INTO access_tokens (studio_id, user_id, token, expires_at)
       VALUES ($1, $2, $3, now() + interval '1 hour')
       ON CONFLICT (token) DO NOTHING`,
      [studioId, userId, value],
    );
  });
}

async function otherStudioProjectId(): Promise<string> {
  return tenantQuery(OTHER_STUDIO, async (client) => {
    const res = await client.query(
      `INSERT INTO projects (studio_id, project_code, name, client_id)
       SELECT $1, 'PRJ-OTHER', 'Proyek Studio Lain', $2
       WHERE NOT EXISTS (SELECT 1 FROM projects WHERE studio_id = $1 AND project_code = 'PRJ-OTHER')
       RETURNING id`,
      [OTHER_STUDIO, SEED_CLIENT],
    );
    const row = res.rows[0] as { id?: string } | undefined;
    if (row?.id) {
      return row.id;
    }
    const existing = await client.query(
      `SELECT id FROM projects WHERE studio_id = $1 AND project_code = 'PRJ-OTHER'`,
      [OTHER_STUDIO],
    );
    return (existing.rows[0] as { id: string }).id;
  });
}

beforeAll(async () => {
  pool = new Pool({ connectionString, max: 5 });
  app = createApp(pool);
  token = `naa_test_${randomUUID()}`;
  await mintToken(SEED_STUDIO, SEED_OWNER, token);

  await tenantQuery(OTHER_STUDIO, async (client) => {
    await client.query(
      `INSERT INTO studios (studio_id, name, currency, timezone)
       VALUES ($1, 'Studio Lain', 'IDR', 'Asia/Jakarta') ON CONFLICT DO NOTHING`,
      [OTHER_STUDIO],
    );
    await client.query(
      `INSERT INTO users (id, studio_id, email, name, role)
       VALUES ($1, $2, 'owner@lain.studio', 'Pemilik Lain', 'OWNER') ON CONFLICT DO NOTHING`,
      [OTHER_USER, OTHER_STUDIO],
    );
  });
});

afterAll(async () => {
  await pool.end();
});

describe('GET /projects', () => {
  it('returns the seed project in the contract summary shape', async () => {
    const res = await app.request('/projects', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    const project = body.data.projects.find((p: any) => p.id === SEED_PROJECT);
    expect(project).toBeDefined();
    expect(project.name).toBe('Apartemen Klien Contoh');
    expect(project.projectCode).toBe('PRJ-001');
    expect(project.status).toBe('ACTIVE');
    expect(project.statusLabel).toBe('Active');
    expect(project.client).toEqual({ id: SEED_CLIENT, name: 'PT Klien Contoh' });
    expect(project.capabilities.read.enabled).toBe(true);
    expect(project.capabilities.write.enabled).toBe(false);
    expect(project.counts.quotations).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(project.engagements)).toBe(true);
    expect(project.engagements.some((e: any) => e.kind === 'BUILD')).toBe(true);
    const build = project.engagements.find((e: any) => e.kind === 'BUILD');
    expect(build.contractStateLabel).toBe('Signed');
    expect(build.currentPhase).toEqual({
      key: 'construction',
      label: 'Construction',
      position: '1 of 1',
    });
    expect(typeof project.timeline.label).toBe('string');
    expect(typeof project.health.tone).toBe('string');
    expect(body.meta.pagination).toBeDefined();
  });

  it('filters by name with q', async () => {
    const res = await app.request('/projects?q=Apartemen', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.data.projects.length).toBeGreaterThanOrEqual(1);
    for (const p of body.data.projects) {
      expect(p.name.toLowerCase()).toContain('apartemen');
    }
  });

  it('paginates with page and pageSize', async () => {
    const res = await app.request('/projects?page=1&pageSize=1', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.data.projects.length).toBeLessThanOrEqual(1);
    expect(body.meta.pagination.pageSize).toBe(1);
    expect(body.meta.pagination.totalItems).toBeGreaterThanOrEqual(1);
  });
});

describe('GET /projects/{id}', () => {
  it('returns the detail with the weak ETag header', async () => {
    const res = await app.request(`/projects/${SEED_PROJECT}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('etag')).toMatch(/^W\/"/);
    const body = (await res.json()) as any;
    expect(body.data.project.id).toBe(SEED_PROJECT);
    expect(body.data.project.name).toBe('Apartemen Klien Contoh');
    expect(body.data.project.engagements.length).toBeGreaterThanOrEqual(2);
    const design = body.data.project.engagements.find((e: any) => e.kind === 'DESIGN');
    expect(design.currentPhase.key).toBe('design-development');
    expect(design.currentPhase.position).toBe('2 of 3');
  });

  it('never leaks another studio project: 404, not 200', async () => {
    const otherId = await otherStudioProjectId();
    const res = await app.request(`/projects/${otherId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as any;
    expect(body.code).toBe('PROJECT_NOT_FOUND');
  });

  it('hides the other studio project from the register', async () => {
    const otherId = await otherStudioProjectId();
    const res = await app.request('/projects?pageSize=100', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = (await res.json()) as any;
    const ids = body.data.projects.map((p: any) => p.id);
    expect(ids).not.toContain(otherId);
  });

  it('returns 404 for an unknown project', async () => {
    const res = await app.request(`/projects/${randomUUID()}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(404);
  });

  it('requires a bearer token', async () => {
    const res = await app.request('/projects');
    expect(res.status).toBe(401);
  });
});
