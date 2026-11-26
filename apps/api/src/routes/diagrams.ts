import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { z } from "zod";
import { DiagramModelSchema, validateModel } from "@archcanvas/shared";
import { audit, HttpError, principalIds, requireDiagram, requireProject } from "../access.js";
import { withTenant } from "../db.js";
import { parse } from "./workspaces.js";

const uuid = z.string().uuid();
const versionNo = z.coerce.number().int().positive();
const versionName = z.string().trim().max(200);

const content = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  kind: z.enum(["whiteboard", "cloud"]).optional(),
  source: z.string().max(200_000).optional(),
  scene: z.record(z.unknown()).optional(),
  model: DiagramModelSchema.optional(),
  /** Names the version this save creates (e.g. "Before HA migration"). */
  message: versionName.optional(),
});

/** Structural errors (unknown kinds, bad nesting, dangling edges) are rejected on save. */
function assertValidModel(model: z.infer<typeof DiagramModelSchema> | undefined) {
  if (!model) return;
  const errors = validateModel(model).filter((i) => i.severity === "error");
  if (errors.length) throw new HttpError(422, `invalid model: ${errors.map((e) => e.message).join("; ")}`);
}

const LIST_COLUMNS = `d.id, d.title, d.kind, d.project_id, d.created_by, d.created_at, d.updated_at,
  (SELECT max(version) FROM diagram_versions v WHERE v.diagram_id = d.id) AS version,
  CASE WHEN d.kind = 'cloud' THEN COALESCE(jsonb_array_length(d.model->'nodes'), 0) END AS node_count`;

export async function diagramRoutes(app: FastifyInstance): Promise<void> {
  /** Diagrams in a project, or every diagram the caller can see. */
  app.get("/api/diagrams", async (req) => {
    const q = parse(z.object({ projectId: uuid.optional() }), req.query);
    return withTenant(req.principal.tenantId, async (c) => {
      if (q.projectId) {
        await requireProject(c, q.projectId, req.principal, "viewer");
        return (await c.query(`SELECT ${LIST_COLUMNS} FROM diagrams d WHERE d.project_id = $1 ORDER BY d.updated_at DESC`, [q.projectId]))
          .rows;
      }
      const { rows } = await c.query(
        `SELECT ${LIST_COLUMNS}, pr.name AS project_name, pr.workspace_id
         FROM diagrams d JOIN projects pr ON pr.id = d.project_id
         WHERE pr.workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id = ANY($1))
         ORDER BY d.updated_at DESC LIMIT 500`,
        [principalIds(req.principal)],
      );
      return rows;
    });
  });

  /** Resolves the short id at the end of a diagram URL ("/d/orders-api-612b054b") to the full id. */
  app.get("/api/diagrams/lookup/:short", async (req) => {
    const { short } = parse(z.object({ short: z.string().regex(/^[0-9a-f-]{8,36}$/i, "expected a hex id prefix") }), req.params);
    return withTenant(req.principal.tenantId, async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `SELECT d.id FROM diagrams d JOIN projects pr ON pr.id = d.project_id
         WHERE d.id::text LIKE $1 || '%'
           AND pr.workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id = ANY($2))
         LIMIT 2`,
        [short.toLowerCase(), principalIds(req.principal)],
      );
      if (!rows.length) throw new HttpError(404, "diagram not found");
      if (rows.length > 1) throw new HttpError(409, "that short id matches more than one diagram; use the full link");
      return { id: rows[0].id };
    });
  });

  app.get("/api/diagrams/:id", async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    return withTenant(req.principal.tenantId, async (c) => {
      const { diagram, role } = await requireDiagram(c, id, req.principal, "viewer");
      const { rows } = await c.query(
        `SELECT pr.name AS project_name, w.id AS workspace_id, w.name AS workspace_name,
                (SELECT max(version) FROM diagram_versions WHERE diagram_id = $1) AS version
         FROM projects pr JOIN workspaces w ON w.id = pr.workspace_id WHERE pr.id = $2`,
        [id, diagram.project_id],
      );
      return { ...diagram, ...rows[0], role };
    });
  });

  app.post("/api/diagrams", async (req, reply) => {
    const body = parse(content.extend({ projectId: uuid }), req.body);
    assertValidModel(body.model);
    const p = req.principal;
    const row = await withTenant(p.tenantId, async (c) => {
      await requireProject(c, body.projectId, p, "editor");
      const { rows } = await c.query(
        `INSERT INTO diagrams (tenant_id, project_id, title, kind, source, scene, model, created_by)
         VALUES ($1, $2, COALESCE($3, 'Untitled diagram'), COALESCE($4, 'whiteboard'), COALESCE($5, ''),
                 COALESCE($6, '{}'::jsonb), $7, $8)
         RETURNING *`,
        [p.tenantId, body.projectId, body.title, body.kind, body.source, body.scene ?? null, body.model ?? null, p.userId],
      );
      const version = await addVersion(c, rows[0], p.userId, body.message ?? null);
      await audit(c, p, "diagram.create", rows[0].id, { projectId: body.projectId });
      return { ...rows[0], version };
    });
    return reply.code(201).send(row);
  });

  /** Saves content and records a new version (skipped when nothing changed and no name is given). Can also move the diagram. */
  app.put("/api/diagrams/:id", async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const body = parse(content.extend({ projectId: uuid.optional() }), req.body);
    assertValidModel(body.model);
    const p = req.principal;
    return withTenant(p.tenantId, async (c) => {
      const { diagram } = await requireDiagram(c, id, p, "editor", true);
      if (body.projectId && body.projectId !== diagram.project_id) await requireProject(c, body.projectId, p, "editor");
      const { rows } = await c.query(
        `UPDATE diagrams SET
           title = COALESCE($2, title), source = COALESCE($3, source), scene = COALESCE($4, scene),
           model = COALESCE($5, model), project_id = COALESCE($6, project_id), updated_at = now()
         WHERE id = $1 RETURNING *`,
        [id, body.title ?? null, body.source ?? null, body.scene ?? null, body.model ?? null, body.projectId ?? null],
      );
      const latest = await latestVersion(c, id);
      const changed = !latest || !sameContent(latest, rows[0]);
      const version = changed || body.message ? await addVersion(c, rows[0], p.userId, body.message ?? null) : latest!.version;
      await audit(c, p, "diagram.update", id, { version, moved: Boolean(body.projectId && body.projectId !== diagram.project_id) });
      return { ...rows[0], version, versionCreated: changed || Boolean(body.message) };
    });
  });

  app.delete("/api/diagrams/:id", async (req, reply) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    await withTenant(req.principal.tenantId, async (c) => {
      await requireDiagram(c, id, req.principal, "editor", true);
      await c.query("DELETE FROM diagrams WHERE id = $1", [id]);
      await audit(c, req.principal, "diagram.delete", id);
    });
    return reply.code(204).send();
  });

  /** Copy a diagram (optionally from a specific version) into the same or another project. */
  app.post("/api/diagrams/:id/duplicate", async (req, reply) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const body = parse(
      z.object({ projectId: uuid.optional(), title: z.string().trim().min(1).max(200).optional(), version: versionNo.optional() }),
      req.body ?? {},
    );
    const p = req.principal;
    const row = await withTenant(p.tenantId, async (c) => {
      const { diagram } = await requireDiagram(c, id, p, "viewer");
      const target = body.projectId ?? diagram.project_id;
      await requireProject(c, target, p, "editor");
      const src = body.version ? await getVersion(c, id, body.version) : diagram;
      const title = body.title ?? `${diagram.title} (copy${body.version ? ` of v${body.version}` : ""})`;
      const { rows } = await c.query(
        `INSERT INTO diagrams (tenant_id, project_id, title, kind, source, scene, model, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [p.tenantId, target, title, src.kind, src.source, src.scene, src.model, p.userId],
      );
      const version = await addVersion(c, rows[0], p.userId, `Copied from "${diagram.title}"${body.version ? ` v${body.version}` : ""}`);
      await audit(c, p, "diagram.duplicate", rows[0].id, { from: id, version: body.version ?? null });
      return { ...rows[0], version };
    });
    return reply.code(201).send(row);
  });

  // ---------------------------------------------------------------- versions

  app.get("/api/diagrams/:id/versions", async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    return withTenant(req.principal.tenantId, async (c) => {
      await requireDiagram(c, id, req.principal, "viewer");
      const { rows } = await c.query(
        `SELECT version, name, kind, created_by, created_at, restored_from,
                CASE WHEN kind = 'cloud' THEN COALESCE(jsonb_array_length(model->'nodes'), 0) END AS node_count,
                CASE WHEN kind = 'cloud' THEN COALESCE(jsonb_array_length(model->'edges'), 0) END AS edge_count
         FROM diagram_versions WHERE diagram_id = $1 ORDER BY version DESC LIMIT 500`,
        [id],
      );
      return rows;
    });
  });

  app.get("/api/diagrams/:id/versions/:version", async (req) => {
    const { id, version } = parse(z.object({ id: uuid, version: versionNo }), req.params);
    return withTenant(req.principal.tenantId, async (c) => {
      await requireDiagram(c, id, req.principal, "viewer");
      return getVersion(c, id, version);
    });
  });

  /** Name (or rename / clear the name of) a version. */
  app.patch("/api/diagrams/:id/versions/:version", async (req) => {
    const { id, version } = parse(z.object({ id: uuid, version: versionNo }), req.params);
    const body = parse(z.object({ name: versionName }), req.body);
    return withTenant(req.principal.tenantId, async (c) => {
      await requireDiagram(c, id, req.principal, "editor");
      const { rows } = await c.query(
        "UPDATE diagram_versions SET name = NULLIF($3, '') WHERE diagram_id = $1 AND version = $2 RETURNING version, name",
        [id, version, body.name],
      );
      if (!rows[0]) throw new HttpError(404, "version not found");
      await audit(c, req.principal, "diagram.version.name", id, { version, name: body.name });
      return rows[0];
    });
  });

  /** Restore an old version: its content becomes current, recorded as a new version. History is never rewritten. */
  app.post("/api/diagrams/:id/versions/:version/restore", async (req) => {
    const { id, version } = parse(z.object({ id: uuid, version: versionNo }), req.params);
    const p = req.principal;
    return withTenant(p.tenantId, async (c) => {
      await requireDiagram(c, id, p, "editor", true);
      const v = await getVersion(c, id, version);
      const { rows } = await c.query(
        "UPDATE diagrams SET source = $2, scene = $3, model = $4, kind = $5, updated_at = now() WHERE id = $1 RETURNING *",
        [id, v.source, v.scene, v.model, v.kind],
      );
      const created = await addVersion(c, rows[0], p.userId, `Restored v${version}`, version);
      await audit(c, p, "diagram.version.restore", id, { from: version, to: created });
      return { ...rows[0], version: created };
    });
  });
}

// ---------------------------------------------------------------- helpers

interface VersionRow {
  version: number;
  name: string | null;
  kind: "whiteboard" | "cloud";
  source: string;
  scene: Record<string, unknown>;
  model: unknown;
  created_by: string | null;
  created_at: string;
  restored_from: number | null;
}

async function addVersion(
  c: pg.PoolClient,
  d: { id: string; tenant_id: string; kind: string; source: string; scene: unknown; model: unknown },
  userId: string,
  name: string | null,
  restoredFrom: number | null = null,
): Promise<number> {
  // The diagram row is locked (or new) in this transaction, so max()+1 cannot race.
  const { rows } = await c.query<{ version: number }>(
    `INSERT INTO diagram_versions (diagram_id, tenant_id, kind, source, scene, model, created_by, name, restored_from, version)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
             (SELECT COALESCE(max(version), 0) + 1 FROM diagram_versions WHERE diagram_id = $1))
     RETURNING version`,
    [d.id, d.tenant_id, d.kind, d.source, d.scene, d.model, userId, name || null, restoredFrom],
  );
  return rows[0].version;
}

async function latestVersion(c: pg.PoolClient, id: string): Promise<VersionRow | undefined> {
  const { rows } = await c.query<VersionRow>(
    "SELECT * FROM diagram_versions WHERE diagram_id = $1 ORDER BY version DESC LIMIT 1",
    [id],
  );
  return rows[0];
}

async function getVersion(c: pg.PoolClient, id: string, version: number): Promise<VersionRow> {
  const { rows } = await c.query<VersionRow>(
    `SELECT version, name, kind, source, scene, model, created_by, created_at, restored_from
     FROM diagram_versions WHERE diagram_id = $1 AND version = $2`,
    [id, version],
  );
  if (!rows[0]) throw new HttpError(404, "version not found");
  return rows[0];
}

/** Both sides come back from jsonb, so key order is canonical and JSON comparison is exact. */
function sameContent(a: { kind: string; source: string; scene: unknown; model: unknown }, b: typeof a): boolean {
  return a.kind === b.kind && a.source === b.source && JSON.stringify(a.scene) === JSON.stringify(b.scene) && JSON.stringify(a.model) === JSON.stringify(b.model);
}
