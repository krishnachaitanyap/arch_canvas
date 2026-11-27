-- Personal API tokens, for scripts, CI and AI agents (the MCP server). Only a SHA-256 hash of
-- each token is stored. Looked up before the tenant is known, so this table has no RLS; every
-- query filters by the token hash or by the owner and tenant.
CREATE TABLE IF NOT EXISTS api_tokens (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     TEXT NOT NULL REFERENCES tenants(id),
  user_id       TEXT NOT NULL,
  email         TEXT,
  name          TEXT NOT NULL,
  token_hash    TEXT NOT NULL UNIQUE,
  prefix        TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at  TIMESTAMPTZ,
  expires_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS api_tokens_owner ON api_tokens (tenant_id, user_id);
