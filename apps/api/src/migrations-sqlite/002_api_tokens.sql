CREATE TABLE IF NOT EXISTS api_tokens (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES tenants(id),
  user_id       TEXT NOT NULL,
  email         TEXT,
  name          TEXT NOT NULL,
  token_hash    TEXT NOT NULL UNIQUE,
  prefix        TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_used_at  TEXT,
  expires_at    TEXT
);
CREATE INDEX IF NOT EXISTS api_tokens_owner ON api_tokens (tenant_id, user_id);
