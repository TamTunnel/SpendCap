// Multi-tenant helpers for the Spendcap *hosted* tier (commercial).
//
// This is the hosted control plane's companion to the OSS core: orgs and
// projects are the unit of tenancy — they own API keys, budgets and usage
// rows in the hosted D1 database. Self-hosters don't need this package:
// the same `orgs`/`projects` tables ship in the OSS migrations
// (packages/data/migrations/0001_init.sql) and a single org is plenty.
// This package is just the control-plane CRUD on top of those tables.

export interface Org {
  id: string;
  name: string;
  created_at: string;
}

export interface Project {
  id: string;
  org_id: string;
  name: string;
  created_at: string;
}

function newId(prefix: string): string {
  // Prefixed, unguessable ids: org_a1b2... / proj_c3d4...
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
}

/** Create an org; returns the full org record (id included). */
export async function createOrg(db: D1Database, name: string): Promise<Org> {
  const org: Org = { id: newId('org'), name, created_at: new Date().toISOString() };
  await db
    .prepare('INSERT INTO orgs (id, name, created_at) VALUES (?, ?, ?)')
    .bind(org.id, org.name, org.created_at)
    .run();
  return org;
}

/** Create a project scoped to an org. */
export async function createProject(db: D1Database, orgId: string, name: string): Promise<Project> {
  const project: Project = {
    id: newId('proj'),
    org_id: orgId,
    name,
    created_at: new Date().toISOString(),
  };
  await db
    .prepare('INSERT INTO projects (id, org_id, name, created_at) VALUES (?, ?, ?, ?)')
    .bind(project.id, project.org_id, project.name, project.created_at)
    .run();
  return project;
}

/** Look up an org by id; null when it doesn't exist. */
export async function getOrgById(db: D1Database, id: string): Promise<Org | null> {
  const row = await db
    .prepare('SELECT id, name, created_at FROM orgs WHERE id = ?')
    .bind(id)
    .first<Org>();
  return row ?? null;
}
