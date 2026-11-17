-- Core schema. Every tenant-scoped table carries tenant_id and is protected by RLS.

CREATE TABLE IF NOT EXISTS tenants (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO tenants (id, name) VALUES ('default', 'Default workspace') ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS diagrams (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   TEXT NOT NULL REFERENCES tenants(id),
  title       TEXT NOT NULL DEFAULT 'Untitled diagram',
  source      TEXT NOT NULL DEFAULT '',          -- diagram-as-code (Mermaid for now)
  scene       JSONB NOT NULL DEFAULT '{}'::jsonb, -- canvas elements
  created_by  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS diagrams_tenant_updated ON diagrams (tenant_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS diagram_versions (
  id          BIGSERIAL PRIMARY KEY,
  diagram_id  UUID NOT NULL REFERENCES diagrams(id) ON DELETE CASCADE,
  tenant_id   TEXT NOT NULL REFERENCES tenants(id),
  source      TEXT NOT NULL,
  scene       JSONB NOT NULL,
  created_by  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS diagram_versions_diagram ON diagram_versions (diagram_id, created_at DESC);

-- Immutable audit log (enterprise requirement from day one)
CREATE TABLE IF NOT EXISTS audit_log (
  id          BIGSERIAL PRIMARY KEY,
  tenant_id   TEXT NOT NULL,
  actor       TEXT,
  action      TEXT NOT NULL,
  target      TEXT,
  meta        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Yjs documents for real-time collaboration (written by the collab service)
CREATE TABLE IF NOT EXISTS collab_documents (
  name        TEXT PRIMARY KEY,
  data        BYTEA NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Row-level security
ALTER TABLE diagrams ENABLE ROW LEVEL SECURITY;
ALTER TABLE diagram_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE diagrams FORCE ROW LEVEL SECURITY;
ALTER TABLE diagram_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON diagrams;
CREATE POLICY tenant_isolation ON diagrams
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

DROP POLICY IF EXISTS tenant_isolation ON diagram_versions;
CREATE POLICY tenant_isolation ON diagram_versions
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

DROP POLICY IF EXISTS tenant_isolation ON audit_log;
CREATE POLICY tenant_isolation ON audit_log
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
