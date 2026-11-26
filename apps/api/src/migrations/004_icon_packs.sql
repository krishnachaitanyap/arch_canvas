-- Icon packs uploaded to a workspace (e.g. Google's official Google Cloud icons).
-- Icons are stored as sanitised SVG markup or PNG data URLs.
CREATE TABLE IF NOT EXISTS icon_packs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     TEXT NOT NULL REFERENCES tenants(id),
  workspace_id  UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  family        TEXT NOT NULL CHECK (family IN ('gcp', 'aws', 'azure', 'generic', 'logos', 'custom')),
  license       TEXT NOT NULL DEFAULT '',
  url           TEXT,
  icons         JSONB NOT NULL,
  icon_count    INT NOT NULL,
  created_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS icon_packs_workspace ON icon_packs (workspace_id, created_at);

ALTER TABLE icon_packs ENABLE ROW LEVEL SECURITY;
ALTER TABLE icon_packs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON icon_packs;
CREATE POLICY tenant_isolation ON icon_packs
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
