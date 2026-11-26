-- Project tabs were replaced by tabs (pages) inside each diagram. Databases that ran the
-- short-lived 005_project_tabs migration drop its columns; elsewhere this does nothing.
DROP INDEX IF EXISTS diagrams_project_tab;
ALTER TABLE diagrams DROP COLUMN IF EXISTS tab;
ALTER TABLE projects DROP COLUMN IF EXISTS tabs;
