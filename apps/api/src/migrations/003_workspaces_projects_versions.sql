-- Workspaces (with member roles) contain projects; projects contain diagrams.
-- Versions get per-diagram numbers and optional names.

CREATE TABLE IF NOT EXISTS workspaces (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   TEXT NOT NULL REFERENCES tenants(id),
  name        TEXT NOT NULL,
  created_by  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS workspaces_tenant ON workspaces (tenant_id);

-- user_id is the OIDC subject or an email address (for people invited before first login).
CREATE TABLE IF NOT EXISTS workspace_members (
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  tenant_id    TEXT NOT NULL REFERENCES tenants(id),
  user_id      TEXT NOT NULL,
  role         TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
  added_by     TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX IF NOT EXISTS workspace_members_user ON workspace_members (tenant_id, user_id);

CREATE TABLE IF NOT EXISTS projects (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     TEXT NOT NULL REFERENCES tenants(id),
  workspace_id  UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  created_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS projects_workspace ON projects (workspace_id, name);

ALTER TABLE diagrams ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES projects(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS diagrams_project ON diagrams (project_id, updated_at DESC);

ALTER TABLE diagram_versions
  ADD COLUMN IF NOT EXISTS version       INT,
  ADD COLUMN IF NOT EXISTS name          TEXT,
  ADD COLUMN IF NOT EXISTS restored_from INT;

-- Row-level security, same policy as the other tenant tables.
ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspaces FORCE ROW LEVEL SECURITY;
ALTER TABLE workspace_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_members FORCE ROW LEVEL SECURITY;
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON workspaces;
CREATE POLICY tenant_isolation ON workspaces
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
DROP POLICY IF EXISTS tenant_isolation ON workspace_members;
CREATE POLICY tenant_isolation ON workspace_members
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
DROP POLICY IF EXISTS tenant_isolation ON projects;
CREATE POLICY tenant_isolation ON projects
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

-- Backfill, one tenant at a time so it also works for a non-superuser role under RLS:
-- existing diagrams move into a "Default workspace / General" project whose owners are
-- the people who created them; versions are numbered in creation order.
DO $$
DECLARE
  t  RECORD;
  ws UUID;
  pr UUID;
BEGIN
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.tenant_id', t.id, true);
    IF EXISTS (SELECT 1 FROM diagrams WHERE project_id IS NULL) THEN
      INSERT INTO workspaces (tenant_id, name, created_by) VALUES (t.id, 'Default workspace', 'migration') RETURNING id INTO ws;
      INSERT INTO projects (tenant_id, workspace_id, name, created_by) VALUES (t.id, ws, 'General', 'migration') RETURNING id INTO pr;
      INSERT INTO workspace_members (workspace_id, tenant_id, user_id, role, added_by)
        SELECT DISTINCT ws, t.id, created_by, 'owner', 'migration' FROM diagrams WHERE created_by IS NOT NULL
        ON CONFLICT DO NOTHING;
      UPDATE diagrams SET project_id = pr WHERE project_id IS NULL;
    END IF;

    UPDATE diagram_versions v SET version = n.rn
      FROM (SELECT id, row_number() OVER (PARTITION BY diagram_id ORDER BY created_at, id) AS rn FROM diagram_versions) n
      WHERE v.id = n.id AND v.version IS NULL;

    -- Diagrams saved once (created, never updated) had no version: give them v1.
    INSERT INTO diagram_versions (diagram_id, tenant_id, kind, source, scene, model, created_by, version, created_at)
      SELECT d.id, d.tenant_id, d.kind, d.source, d.scene, d.model, d.created_by, 1, d.updated_at
      FROM diagrams d WHERE NOT EXISTS (SELECT 1 FROM diagram_versions v WHERE v.diagram_id = d.id);
  END LOOP;
END $$;

ALTER TABLE diagrams ALTER COLUMN project_id SET NOT NULL;
ALTER TABLE diagram_versions ALTER COLUMN version SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS diagram_versions_number ON diagram_versions (diagram_id, version);
