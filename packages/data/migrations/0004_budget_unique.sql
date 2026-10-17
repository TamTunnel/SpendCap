-- Spendcap D1 schema: budget uniqueness
-- 0004_budget_unique.sql
--
-- One budget row per (scope_id, period). Without this, two rows for the same
-- scope+period silently shadow each other: the enforcer loads both, and the
-- check-and-reserve sees whichever the SELECT returns first. The dashboard's
-- POST /api/budgets upserts ON CONFLICT(scope_id, period), which requires
-- this index to exist.
CREATE UNIQUE INDEX IF NOT EXISTS idx_budgets_scope_period ON budgets(scope_id, period);
