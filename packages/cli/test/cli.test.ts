import { afterEach, describe, expect, it, vi } from 'vitest';
import { CliError, main, parseArgs } from '../src/index.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete process.env.SPENDCAP_ADMIN_TOKEN;
  delete process.env.SPENDCAP_API;
});

describe('parseArgs', () => {
  it('parses keys create flags', () => {
    const p = parseArgs(['keys', 'create', '--project', 'p1', '--env', 'live', '--name', 'ci']);
    expect(p.command).toBe('keys');
    expect(p.subcommand).toBe('create');
    expect(p.flags).toEqual({ project: 'p1', env: 'live', name: 'ci' });
    expect(p.positionals).toEqual([]);
  });

  it('supports --flag=value form', () => {
    const p = parseArgs(['keys', 'create', '--project=p1', '--env=test', '--name=ci']);
    expect(p.flags).toEqual({ project: 'p1', env: 'test', name: 'ci' });
  });

  it('parses positional keyHash for revoke/rotate', () => {
    const p = parseArgs(['keys', 'revoke', 'abc123']);
    expect(p.command).toBe('keys');
    expect(p.subcommand).toBe('revoke');
    expect(p.positionals).toEqual(['abc123']);
  });

  it('parses budgets set', () => {
    const p = parseArgs(['budgets', 'set', '--scope', 'proj', '--period', 'daily', '--limit-cents', '500']);
    expect(p.command).toBe('budgets');
    expect(p.subcommand).toBe('set');
    expect(p.flags['limit-cents']).toBe('500');
  });

  it('treats empty argv and --help as help', () => {
    expect(parseArgs([]).command).toBe('help');
    expect(parseArgs(['--help']).command).toBe('help');
    expect(parseArgs(['-h']).command).toBe('help');
  });
});

describe('main validation', () => {
  it('prints help and returns for --help', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await main(['--help']);
    expect(spy).toHaveBeenCalledOnce();
    expect(String(spy.mock.calls[0][0])).toContain('spendcap keys create');
  });

  it('rejects unknown commands', async () => {
    await expect(main(['frobnicate'])).rejects.toThrow(CliError);
  });

  it('rejects unknown keys subcommands', async () => {
    await expect(main(['keys', 'frobnicate'])).rejects.toThrow(/subcommand/);
  });

  it('requires --name for keys create', async () => {
    await expect(main(['keys', 'create', '--project', 'p', '--env', 'live'])).rejects.toThrow(
      /--name/,
    );
  });

  it('rejects invalid --env', async () => {
    await expect(
      main(['keys', 'create', '--project', 'p', '--env', 'prod', '--name', 'n']),
    ).rejects.toThrow(/live.*test/);
  });

  it('requires a keyHash for revoke', async () => {
    await expect(main(['keys', 'revoke'])).rejects.toThrow(/keyHash/);
  });

  it('requires a keyHash for rotate', async () => {
    await expect(main(['keys', 'rotate'])).rejects.toThrow(/keyHash/);
  });

  it('rejects invalid --period', async () => {
    await expect(
      main(['budgets', 'set', '--scope', 's', '--period', 'weekly', '--limit-cents', '100']),
    ).rejects.toThrow(/daily.*monthly/);
  });

  it('rejects non-numeric --limit-cents', async () => {
    await expect(
      main(['budgets', 'set', '--scope', 's', '--period', 'daily', '--limit-cents', 'lots']),
    ).rejects.toThrow(/limit-cents/);
  });

  it('rejects zero --limit-cents', async () => {
    await expect(
      main(['budgets', 'set', '--scope', 's', '--period', 'daily', '--limit-cents', '0']),
    ).rejects.toThrow(/positive integer/);
  });

  it('requires SPENDCAP_ADMIN_TOKEN before any API call', async () => {
    await expect(
      main(['keys', 'create', '--project', 'p', '--env', 'live', '--name', 'n']),
    ).rejects.toThrow(/SPENDCAP_ADMIN_TOKEN/);
  });
});

describe('fix-2 CLI <-> dashboard contract (stubbed HTTP)', () => {
  const BASE = 'https://dashboard.test';
  let calls: Array<{ url: string; body: unknown }>;

  function stubFetch() {
    calls = [];
    process.env.SPENDCAP_ADMIN_TOKEN = 'tok';
    process.env.SPENDCAP_API = BASE;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, body: JSON.parse(String(init.body)) });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }),
    );
    vi.spyOn(console, 'log').mockImplementation(() => {});
  }

  it('keys create sends {projectId, env, name} to POST /api/keys', async () => {
    stubFetch();
    await main(['keys', 'create', '--project', 'p1', '--env', 'live', '--name', 'n']);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${BASE}/api/keys`);
    expect(calls[0].body).toEqual({ projectId: 'p1', env: 'live', name: 'n' });
  });

  it('keys revoke posts to /api/keys/:hash/revoke', async () => {
    stubFetch();
    await main(['keys', 'revoke', 'abc123']);
    expect(calls[0].url).toBe(`${BASE}/api/keys/abc123/revoke`);
    expect(calls[0].body).toEqual({});
  });

  it('keys rotate posts to /api/keys/:hash/rotate', async () => {
    stubFetch();
    await main(['keys', 'rotate', 'abc123']);
    expect(calls[0].url).toBe(`${BASE}/api/keys/abc123/rotate`);
  });

  it('budgets set posts {scopeType, scopeId, period, limitCents} to /api/budgets', async () => {
    stubFetch();
    await main(['budgets', 'set', '--scope', 'proj', '--period', 'daily', '--limit-cents', '500']);
    expect(calls[0].url).toBe(`${BASE}/api/budgets`);
    expect(calls[0].body).toEqual({
      scopeType: 'project',
      scopeId: 'proj',
      period: 'daily',
      limitCents: 500,
    });
  });

  it('provider-keys set posts {orgId, provider, key} to /api/provider-keys', async () => {
    stubFetch();
    await main([
      'provider-keys',
      'set',
      '--org',
      'org1',
      '--provider',
      'openai-compatible',
      '--key',
      'sk-x',
    ]);
    expect(calls[0].url).toBe(`${BASE}/api/provider-keys`);
    expect(calls[0].body).toEqual({ orgId: 'org1', provider: 'openai-compatible', key: 'sk-x' });
  });

  it('provider-keys set requires --org/--provider/--key', async () => {
    await expect(main(['provider-keys', 'set', '--org', 'o'])).rejects.toThrow(CliError);
    await expect(main(['provider-keys', 'frobnicate'])).rejects.toThrow(/subcommand/);
  });

  it('parses provider-keys set flags', async () => {
    const p = parseArgs(['provider-keys', 'set', '--org', 'o', '--provider', 'p', '--key', 'k']);
    expect(p.command).toBe('provider-keys');
    expect(p.subcommand).toBe('set');
    expect(p.flags).toEqual({ org: 'o', provider: 'p', key: 'k' });
  });
});

describe('fix-16 CLI default API port', () => {
  it('defaults SPENDCAP_API to the dashboard port documented in the README', async () => {
    const { apiBase } = await import('../src/client.js');
    delete process.env.SPENDCAP_API;
    expect(apiBase()).toBe('http://localhost:8787');
  });
});
