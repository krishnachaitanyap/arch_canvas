-- SQLite schema for the local fallback (DATABASE_URL=sqlite:<file>). It matches the Postgres
-- migrations in ../migrations, without what SQLite doesn't have: row-level security and
-- JSONB (JSON is stored as text). Keep it in step when a Postgres migration changes a table.

CREATE TABLE IF NOT EXISTS tenants (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
INSERT INTO tenants (id, name) VALUES ('default', 'Default workspace') ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS workspaces (
  id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6)))),
  tenant_id   TEXT NOT NULL REFERENCES tenants(id),
  name        TEXT NOT NULL,
  created_by  TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS workspaces_tenant ON workspaces (tenant_id);

CREATE TABLE IF NOT EXISTS workspace_members (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  tenant_id    TEXT NOT NULL REFERENCES tenants(id),
  user_id      TEXT NOT NULL,
  role         TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
  added_by     TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX IF NOT EXISTS workspace_members_user ON workspace_members (tenant_id, user_id);

CREATE TABLE IF NOT EXISTS projects (
  id            TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6)))),
  tenant_id     TEXT NOT NULL REFERENCES tenants(id),
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  created_by    TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS projects_workspace ON projects (workspace_id, name);

CREATE TABLE IF NOT EXISTS diagrams (
  id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6)))),
  tenant_id   TEXT NOT NULL REFERENCES tenants(id),
  project_id  TEXT REFERENCES projects(id) ON DELETE CASCADE,
  title       TEXT NOT NULL DEFAULT 'Untitled diagram',
  kind        TEXT NOT NULL DEFAULT 'whiteboard' CHECK (kind IN ('whiteboard', 'cloud')),
  source      TEXT NOT NULL DEFAULT '',
  scene       TEXT NOT NULL DEFAULT '{}',
  model       TEXT,
  created_by  TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS diagrams_tenant_updated ON diagrams (tenant_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS diagrams_project ON diagrams (project_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS diagram_versions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  diagram_id     TEXT NOT NULL REFERENCES diagrams(id) ON DELETE CASCADE,
  tenant_id      TEXT NOT NULL REFERENCES tenants(id),
  version        INTEGER,
  name           TEXT,
  restored_from  INTEGER,
  kind           TEXT NOT NULL DEFAULT 'whiteboard',
  source         TEXT NOT NULL,
  scene          TEXT NOT NULL,
  model          TEXT,
  created_by     TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS diagram_versions_diagram ON diagram_versions (diagram_id, created_at DESC);

CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id   TEXT NOT NULL,
  actor       TEXT,
  action      TEXT NOT NULL,
  target      TEXT,
  meta        TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS collab_documents (
  name        TEXT PRIMARY KEY,
  data        BLOB NOT NULL,
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS icon_packs (
  id            TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6)))),
  tenant_id     TEXT NOT NULL REFERENCES tenants(id),
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  family        TEXT NOT NULL CHECK (family IN ('gcp', 'aws', 'azure', 'generic', 'logos', 'custom')),
  license       TEXT NOT NULL DEFAULT '',
  url           TEXT,
  icons         TEXT NOT NULL,
  icon_count    INTEGER NOT NULL,
  created_by    TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS icon_packs_workspace ON icon_packs (workspace_id, created_at);
