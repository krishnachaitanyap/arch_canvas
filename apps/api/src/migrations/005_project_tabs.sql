-- Projects can have their own tabs (e.g. "Architecture", "HA / DR", "CI/CD") to organise
-- their diagrams; a diagram belongs to at most one tab. Tabs are [{ "id", "name" }] in order.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS tabs JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE diagrams ADD COLUMN IF NOT EXISTS tab TEXT;
CREATE INDEX IF NOT EXISTS diagrams_project_tab ON diagrams (project_id, tab);
