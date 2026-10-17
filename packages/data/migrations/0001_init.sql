-- Spendcap D1 schema: initial migration
-- 0001_init.sql

CREATE TABLE orgs (
  id TEXT PRIMARY KEY,
  name TEXT,
  created_at TEXT
);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  org_id TEXT,
  name TEXT,
  created_at TEXT
);

CREATE TABLE api_keys (
  key_hash TEXT PRIMARY KEY,
  org_id TEXT,
  project_id TEXT,
  key_prefix TEXT,
  name TEXT,
  env TEXT CHECK (env IN ('live', 'test')),
  scopes TEXT DEFAULT '{}',
  allowed_models TEXT,
  rate_limit_per_min INTEGER,
  budget_scope_id TEXT,
  revoked_at TEXT,
  created_at TEXT,
  last_used_at TEXT
);

CREATE TABLE budgets (
  id TEXT PRIMARY KEY,
  scope_type TEXT,
  scope_id TEXT,
  period TEXT CHECK (period IN ('daily', 'monthly')),
  limit_cents INTEGER,
  created_at TEXT
);

CREATE TABLE usage_daily (
  day TEXT,
  project_id TEXT,
  key_hash TEXT,
  model TEXT,
  task TEXT DEFAULT '',
  calls INTEGER DEFAULT 0,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  cost_cents INTEGER DEFAULT 0,
  PRIMARY KEY (day, project_id, key_hash, model, task)
);

CREATE TABLE usage_detail (
  id TEXT PRIMARY KEY,
  created_at TEXT,
  project_id TEXT,
  key_hash TEXT,
  model TEXT,
  task TEXT DEFAULT '',
  input_tokens INTEGER,
  output_tokens INTEGER,
  cost_cents INTEGER
);

CREATE TABLE pricing (
  model TEXT PRIMARY KEY,
  input_per_1m REAL,
  output_per_1m REAL,
  updated_at TEXT
);

CREATE TABLE provider_keys (
  id TEXT PRIMARY KEY,
  org_id TEXT,
  provider TEXT,
  enc_key TEXT,
  created_at TEXT
);
