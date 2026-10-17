#!/usr/bin/env node
// spendcap CLI: manage API keys and budgets against the dashboard API.
//
// Dashboard API contract (the dashboard worker implements these):
//   POST {SPENDCAP_API}/api/keys                  {projectId, env, name} -> {key, keyHash, keyPrefix}
//   POST {SPENDCAP_API}/api/keys/:hash/revoke      {}                     -> {revoked: true}
//   POST {SPENDCAP_API}/api/keys/:hash/rotate      {}                     -> {key, keyHash, keyPrefix}
//   POST {SPENDCAP_API}/api/budgets                {scopeType, scopeId, period, limitCents} -> {ok: true}
//   POST {SPENDCAP_API}/api/provider-keys          {orgId, provider, key} -> {ok: true}
//   PATCH {SPENDCAP_API}/api/keys/:hash            {name?, budgetScopeId?} -> {ok: true}
//
// Auth: Bearer SPENDCAP_ADMIN_TOKEN. Base URL: SPENDCAP_API (default http://localhost:8787).
// Plain process.argv parsing — no CLI dependencies on purpose.
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { api, apiBase, CliError, __setApiConfigForTests } from './client.js';

// Re-exported so tests (and the dashboard contract test, which imports the
// client package directly) get the full surface from one place.
export { CliError, api, apiBase, __setApiConfigForTests };

export interface CliOptions {
  command: string;
  args: string[];
}

export interface ParsedArgs {
  /** Top-level command: 'keys' | 'budgets' | 'provider-keys' | 'help'. */
  command: string;
  /** Subcommand for grouped commands (e.g. 'create' for `keys create`). */
  subcommand?: string;
  positionals: string[];
  flags: Record<string, string | true>;
}

/**
 * Parse raw argv (without node/script prefix) into command, subcommand,
 * positional args and --flags. Supports `--flag value` and `--flag=value`.
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const [command, ...rest] = argv;
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    return { command: 'help', positionals: [], flags: {} };
  }

  let subcommand: string | undefined;
  let tokens = rest;
  if (rest.length > 0 && !rest[0].startsWith('-')) {
    subcommand = rest[0];
    tokens = rest.slice(1);
  }

  const positionals: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.startsWith('--')) {
      const eq = tok.indexOf('=');
      if (eq !== -1) {
        flags[tok.slice(2, eq)] = tok.slice(eq + 1);
      } else if (i + 1 < tokens.length && !tokens[i + 1].startsWith('-')) {
        flags[tok.slice(2)] = tokens[++i];
      } else {
        flags[tok.slice(2)] = true;
      }
    } else if (tok.startsWith('-') && tok.length === 2) {
      // Short boolean flag (e.g. -h).
      flags[tok.slice(1)] = true;
    } else {
      positionals.push(tok);
    }
  }
  return { command, subcommand, positionals, flags };
}

function requireFlag(flags: Record<string, string | true>, name: string, usage: string): string {
  const v = flags[name];
  if (v === undefined || v === true || String(v).length === 0) {
    throw new CliError(`missing required --${name}\n${usage}`);
  }
  return String(v);
}

const KEYS_USAGE = `Usage:
  spendcap keys create --project <id> --env live|test --name <name>
  spendcap keys revoke <keyHash>
  spendcap keys rotate <keyHash>`;

const BUDGETS_USAGE = `Usage:
  spendcap budgets set --scope <id> --period daily|monthly --limit-cents <n>`;

const PROVIDER_KEYS_USAGE = `Usage:
  spendcap provider-keys set --org <id> --provider <name> --key <secret>`;

const HELP = `spendcap — manage API keys, budgets, and provider keys

${KEYS_USAGE}

${BUDGETS_USAGE}

${PROVIDER_KEYS_USAGE}

Options:
  --help, -h        Show this help

Environment:
  SPENDCAP_API          Dashboard API base URL (default http://localhost:8787)
  SPENDCAP_ADMIN_TOKEN  Admin API credential (required for all commands except --help)`;

async function cmdKeysCreate(flags: Record<string, string | true>): Promise<void> {
  const project = requireFlag(flags, 'project', KEYS_USAGE);
  const env = requireFlag(flags, 'env', KEYS_USAGE);
  if (env !== 'live' && env !== 'test') {
    throw new CliError(`--env must be "live" or "test", got "${env}"\n${KEYS_USAGE}`);
  }
  const name = requireFlag(flags, 'name', KEYS_USAGE);
  // The dashboard requires `projectId` (not `project`).
  const out = await api<{ key: string; keyHash: string; keyPrefix: string }>('/api/keys', {
    projectId: project,
    env,
    name,
  });
  // The full key is shown exactly once — it cannot be retrieved again.
  console.log(`key:        ${out.key}`);
  console.log(`key_hash:   ${out.keyHash}`);
  console.log(`key_prefix: ${out.keyPrefix}`);
  console.log('Store the key now; it will not be shown again.');
}

async function cmdKeysRevoke(positionals: string[]): Promise<void> {
  const keyHash = positionals[0];
  if (!keyHash) throw new CliError(`missing <keyHash>\n${KEYS_USAGE}`);
  await api<{ revoked: boolean }>(`/api/keys/${encodeURIComponent(keyHash)}/revoke`, {});
  console.log(`revoked key ${keyHash}`);
}

async function cmdKeysRotate(positionals: string[]): Promise<void> {
  const keyHash = positionals[0];
  if (!keyHash) throw new CliError(`missing <keyHash>\n${KEYS_USAGE}`);
  const out = await api<{ key: string; keyHash: string; keyPrefix: string }>(
    `/api/keys/${encodeURIComponent(keyHash)}/rotate`,
    {},
  );
  console.log(`key:        ${out.key}`);
  console.log(`key_hash:   ${out.keyHash}`);
  console.log(`key_prefix: ${out.keyPrefix}`);
  console.log('Store the new key now; it will not be shown again. The old key is revoked.');
}

async function cmdBudgetsSet(flags: Record<string, string | true>): Promise<void> {
  const scope = requireFlag(flags, 'scope', BUDGETS_USAGE);
  const period = requireFlag(flags, 'period', BUDGETS_USAGE);
  if (period !== 'daily' && period !== 'monthly') {
    throw new CliError(`--period must be "daily" or "monthly", got "${period}"\n${BUDGETS_USAGE}`);
  }
  const limitStr = requireFlag(flags, 'limit-cents', BUDGETS_USAGE);
  const limitCents = Number(limitStr);
  if (!Number.isInteger(limitCents) || limitCents <= 0) {
    throw new CliError(`--limit-cents must be a positive integer, got "${limitStr}"\n${BUDGETS_USAGE}`);
  }
  // v1 budgets are per-project: scopeType is always 'project' and the scope
  // id is the project id (the key's budget_scope_id defaults to it).
  await api<{ ok: boolean }>('/api/budgets', {
    scopeType: 'project',
    scopeId: scope,
    period,
    limitCents,
  });
  console.log(`budget set: scope=${scope} period=${period} limit=${limitCents}¢`);
}

async function cmdProviderKeysSet(flags: Record<string, string | true>): Promise<void> {
  const org = requireFlag(flags, 'org', PROVIDER_KEYS_USAGE);
  const provider = requireFlag(flags, 'provider', PROVIDER_KEYS_USAGE);
  const key = requireFlag(flags, 'key', PROVIDER_KEYS_USAGE);
  await api<{ ok: boolean }>('/api/provider-keys', { orgId: org, provider, key });
  console.log(`provider key set: org=${org} provider=${provider}`);
}

export async function main(argv: string[]): Promise<void> {
  const parsed: CliOptions = { command: argv[0] ?? '', args: argv.slice(1) };
  const p = parseArgs(argv);

  if (p.command === 'help') {
    console.log(HELP);
    return;
  }

  if (p.command === 'keys') {
    switch (p.subcommand) {
      case 'create':
        await cmdKeysCreate(p.flags);
        return;
      case 'revoke':
        await cmdKeysRevoke(p.positionals);
        return;
      case 'rotate':
        await cmdKeysRotate(p.positionals);
        return;
      default:
        throw new CliError(`unknown keys subcommand "${p.subcommand ?? ''}"\n${KEYS_USAGE}`);
    }
  }

  if (p.command === 'budgets') {
    if (p.subcommand === 'set') {
      await cmdBudgetsSet(p.flags);
      return;
    }
    throw new CliError(`unknown budgets subcommand "${p.subcommand ?? ''}"\n${BUDGETS_USAGE}`);
  }

  if (p.command === 'provider-keys') {
    if (p.subcommand === 'set') {
      await cmdProviderKeysSet(p.flags);
      return;
    }
    throw new CliError(
      `unknown provider-keys subcommand "${p.subcommand ?? ''}"\n${PROVIDER_KEYS_USAGE}`,
    );
  }

  throw new CliError(`unknown command "${parsed.command}"\n\n${HELP}`);
}

// Run when invoked directly as `node dist/index.js ...` (not when imported by tests).
const invokedAsScript =
  typeof process !== 'undefined' &&
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedAsScript) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    console.error(`spendcap: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
