-- Typed diagram model (cloud architecture diagrams). Whiteboards keep using source + scene.
ALTER TABLE diagrams
  ADD COLUMN IF NOT EXISTS kind  TEXT  NOT NULL DEFAULT 'whiteboard' CHECK (kind IN ('whiteboard', 'cloud')),
  ADD COLUMN IF NOT EXISTS model JSONB;

ALTER TABLE diagram_versions
  ADD COLUMN IF NOT EXISTS kind  TEXT NOT NULL DEFAULT 'whiteboard',
  ADD COLUMN IF NOT EXISTS model JSONB;
