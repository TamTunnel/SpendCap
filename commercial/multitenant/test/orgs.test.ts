// Runs against a real (miniflare, in-memory) D1 database with the repo's
// actual migrations applied — 0001 for orgs/projects, 0003 to validate the
// billing migration SQL stays valid in the same chain.

import { beforeAll, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { createOrg, createProject, getOrgById } from '../src/orgs.js';
import initSql from '../../../packages/data/migrations/0001_init.sql?raw';
import billingSql from '../../../packages/data/migrations/0003_billing.sql?raw';

declare module 'cloudflare:test' {
  interface ProvidedEnv {
    DB: D1Database;
  }
}

beforeAll(async () => {
  // Apply the repo's migrations to the fresh miniflare D1. Note: this
  // workerd D1 build can't exec() a multi-LINE statement, so split the
  // files into single statements (no `;` appears inside any statement or
  // string literal in our migrations) and exec them one at a time.
  const statements = (sql: string) =>
    sql
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n')
      .split(';')
      .map((s) => s.replace(/\s+/g, ' ').trim())
      .filter((s) => s.length > 0);
  for (const sql of [...statements(initSql), ...statements(billingSql)]) {
    await env.DB.exec(sql);
  }
});

describe('orgs (hosted control plane)', () => {
  it('creates an org and reads it back by id', async () => {
    const org = await createOrg(env.DB, 'Acme Inc');
    expect(org.id).toMatch(/^org_/);
    expect(org.name).toBe('Acme Inc');
    expect(typeof org.created_at).toBe('string');

    const found = await getOrgById(env.DB, org.id);
    expect(found).toMatchObject({ id: org.id, name: 'Acme Inc' });
  });

  it('returns null for an unknown org id', async () => {
    expect(await getOrgById(env.DB, 'org_nope')).toBeNull();
  });

  it('creates a project scoped to its org', async () => {
    const org = await createOrg(env.DB, 'Project Co');
    const project = await createProject(env.DB, org.id, 'fleet-1');
    expect(project.id).toMatch(/^proj_/);
    expect(project.org_id).toBe(org.id);
    expect(project.name).toBe('fleet-1');
  });

  it('mints distinct ids for distinct orgs', async () => {
    const a = await createOrg(env.DB, 'A');
    const b = await createOrg(env.DB, 'B');
    expect(a.id).not.toBe(b.id);
  });
});
