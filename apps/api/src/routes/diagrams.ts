import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { withTenant } from "../db.js";

const upsert = z.object({
  title: z.string().max(200).optional(),
  source: z.string().max(200_000).optional(),
  scene: z.record(z.unknown()).optional(),
});

const idParam = z.object({ id: z.string().uuid() });

export async function diagramRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/diagrams", async (req) => {
    const { tenantId } = req.principal;
    return withTenant(tenantId, async (c) => {
      const { rows } = await c.query(
        "SELECT id, title, updated_at FROM diagrams ORDER BY updated_at DESC LIMIT 200",
      );
      return rows;
    });
  });

  app.get("/api/diagrams/:id", async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: "bad id" });
    const row = await withTenant(req.principal.tenantId, async (c) => {
      const { rows } = await c.query("SELECT * FROM diagrams WHERE id = $1", [p.data.id]);
      return rows[0];
    });
    return row ?? reply.code(404).send({ error: "not found" });
  });

  app.post("/api/diagrams", async (req, reply) => {
    const b = upsert.safeParse(req.body ?? {});
    if (!b.success) return reply.code(400).send({ error: b.error.flatten() });
    const { tenantId, userId } = req.principal;
    const row = await withTenant(tenantId, async (c) => {
      const { rows } = await c.query(
        `INSERT INTO diagrams (tenant_id, title, source, scene, created_by)
         VALUES ($1, COALESCE($2, 'Untitled diagram'), COALESCE($3, ''), COALESCE($4, '{}'::jsonb), $5)
         RETURNING *`,
        [tenantId, b.data.title, b.data.source, b.data.scene ?? null, userId],
      );
      await audit(c, tenantId, userId, "diagram.create", rows[0].id);
      return rows[0];
    });
    return reply.code(201).send(row);
  });

  app.put("/api/diagrams/:id", async (req, reply) => {
    const p = idParam.safeParse(req.params);
    const b = upsert.safeParse(req.body ?? {});
    if (!p.success || !b.success) return reply.code(400).send({ error: "bad request" });
    const { tenantId, userId } = req.principal;
    const row = await withTenant(tenantId, async (c) => {
      const { rows } = await c.query(
        `UPDATE diagrams SET
           title = COALESCE($2, title),
           source = COALESCE($3, source),
           scene = COALESCE($4, scene),
           updated_at = now()
         WHERE id = $1 RETURNING *`,
        [p.data.id, b.data.title, b.data.source, b.data.scene ?? null],
      );
      if (!rows[0]) return undefined;
      await c.query(
        `INSERT INTO diagram_versions (diagram_id, tenant_id, source, scene, created_by)
         VALUES ($1, $2, $3, $4, $5)`,
        [rows[0].id, tenantId, rows[0].source, rows[0].scene, userId],
      );
      await audit(c, tenantId, userId, "diagram.update", rows[0].id);
      return rows[0];
    });
    return row ?? reply.code(404).send({ error: "not found" });
  });

  app.get("/api/diagrams/:id/versions", async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: "bad id" });
    return withTenant(req.principal.tenantId, async (c) => {
      const { rows } = await c.query(
        "SELECT id, created_by, created_at FROM diagram_versions WHERE diagram_id = $1 ORDER BY created_at DESC LIMIT 100",
        [p.data.id],
      );
      return rows;
    });
  });

  app.delete("/api/diagrams/:id", async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: "bad id" });
    const { tenantId, userId } = req.principal;
    const deleted = await withTenant(tenantId, async (c) => {
      const { rowCount } = await c.query("DELETE FROM diagrams WHERE id = $1", [p.data.id]);
      if (rowCount) await audit(c, tenantId, userId, "diagram.delete", p.data.id);
      return Boolean(rowCount);
    });
    return deleted ? reply.code(204).send() : reply.code(404).send({ error: "not found" });
  });
}

async function audit(
  c: { query: (q: string, v: unknown[]) => Promise<unknown> },
  tenantId: string,
  actor: string,
  action: string,
  target: string,
): Promise<void> {
  await c.query("INSERT INTO audit_log (tenant_id, actor, action, target) VALUES ($1, $2, $3, $4)", [
    tenantId,
    actor,
    action,
    target,
  ]);
}
