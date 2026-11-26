import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { sanitizeIconData } from "@archcanvas/shared";
import { audit, HttpError, requireWorkspace } from "../access.js";
import { withTenant } from "../db.js";
import { parse } from "./workspaces.js";

const uuid = z.string().uuid();
const MAX_ICONS = 3000;
const MAX_BYTES = 12 * 1024 * 1024;

const upload = z.object({
  name: z.string().trim().min(1).max(120),
  family: z.enum(["gcp", "aws", "azure", "generic", "logos", "custom"]),
  license: z.string().max(300).default(""),
  url: z.string().url().max(500).optional(),
  icons: z
    .array(z.object({ n: z.string().min(1).max(200), t: z.string().min(1).max(200), c: z.string().max(100).optional(), s: z.string().min(1).max(400_000) }))
    .min(1)
    .max(MAX_ICONS),
});

/** Icon packs uploaded to a workspace. Viewers can use them; editors can add and remove them. */
export async function iconRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/workspaces/:id/icon-packs", async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    return withTenant(req.principal.tenantId, async (c) => {
      await requireWorkspace(c, id, req.principal, "viewer");
      const { rows } = await c.query(
        `SELECT id, name, family, license, url, icon_count AS count, created_by, created_at, false AS "builtIn"
         FROM icon_packs WHERE workspace_id = $1 ORDER BY created_at`,
        [id],
      );
      return rows;
    });
  });

  app.get("/api/icon-packs/:id", async (req, reply) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const row = await withTenant(req.principal.tenantId, async (c) => {
      const { rows } = await c.query("SELECT id, workspace_id, name, family, license, url, icons FROM icon_packs WHERE id = $1", [id]);
      if (!rows[0]) throw new HttpError(404, "icon pack not found");
      await requireWorkspace(c, rows[0].workspace_id, req.principal, "viewer");
      return rows[0];
    });
    // Packs don't change once uploaded, so browsers may cache them.
    return reply.header("cache-control", "private, max-age=86400").send(row);
  });

  app.post("/api/workspaces/:id/icon-packs", { bodyLimit: MAX_BYTES + 1024 * 1024 }, async (req, reply) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const body = parse(upload, req.body);
    const icons = body.icons
      .map((i) => ({ ...i, s: sanitizeIconData(i.s) }))
      .filter((i): i is typeof i & { s: string } => Boolean(i.s));
    if (!icons.length) throw new HttpError(422, "no valid SVG or PNG icons in the upload");
    const row = await withTenant(req.principal.tenantId, async (c) => {
      await requireWorkspace(c, id, req.principal, "editor");
      const { rows } = await c.query(
        `INSERT INTO icon_packs (tenant_id, workspace_id, name, family, license, url, icons, icon_count, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id, name, family, license, url, icon_count AS count, created_by, created_at, false AS "builtIn"`,
        [req.principal.tenantId, id, body.name, body.family, body.license, body.url ?? null, JSON.stringify(icons), icons.length, req.principal.userId],
      );
      await audit(c, req.principal, "icon_pack.upload", rows[0].id, { workspaceId: id, count: icons.length, rejected: body.icons.length - icons.length });
      return rows[0];
    });
    return reply.code(201).send({ ...row, rejected: body.icons.length - icons.length });
  });

  app.delete("/api/icon-packs/:id", async (req, reply) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    await withTenant(req.principal.tenantId, async (c) => {
      const { rows } = await c.query("SELECT workspace_id FROM icon_packs WHERE id = $1", [id]);
      if (!rows[0]) throw new HttpError(404, "icon pack not found");
      await requireWorkspace(c, rows[0].workspace_id, req.principal, "editor");
      await c.query("DELETE FROM icon_packs WHERE id = $1", [id]);
      await audit(c, req.principal, "icon_pack.delete", id);
    });
    return reply.code(204).send();
  });
}
