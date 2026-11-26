import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit, HttpError, principalIds, requireProject, requireWorkspace, ROLES, type Role } from "../access.js";
import { withTenant } from "../db.js";

const uuid = z.string().uuid();
const name = z.string().trim().min(1).max(120);
/** A project's tabs, in order. Ids are stable so renaming a tab keeps its diagrams. */
const tabs = z
  .array(z.object({ id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/), name: z.string().trim().min(1).max(40) }))
  .max(30)
  .refine((t) => new Set(t.map((x) => x.id)).size === t.length, "tab ids must be unique");
const role = z.enum(ROLES as [Role, ...Role[]]);
const member = z.string().trim().min(1).max(200);

function parse<S extends z.ZodTypeAny>(schema: S, value: unknown): z.output<S> {
  const r = schema.safeParse(value);
  if (!r.success) throw new HttpError(400, r.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
  return r.data;
}

export async function workspaceRoutes(app: FastifyInstance): Promise<void> {
  // ---------------------------------------------------------------- workspaces

  /** Workspaces the caller belongs to. First visit creates a personal workspace with a "General" project. */
  app.get("/api/workspaces", async (req) => {
    const p = req.principal;
    return withTenant(p.tenantId, async (c) => {
      const list = async () =>
        (
          await c.query(
            `SELECT DISTINCT ON (w.id) w.id, w.name, w.created_at, m.role,
                    (SELECT count(*)::int FROM projects pr WHERE pr.workspace_id = w.id) AS project_count,
                    (SELECT count(*)::int FROM workspace_members x WHERE x.workspace_id = w.id) AS member_count
             FROM workspaces w JOIN workspace_members m ON m.workspace_id = w.id
             WHERE m.user_id = ANY($1)
             ORDER BY w.id, CASE m.role WHEN 'owner' THEN 0 WHEN 'editor' THEN 1 ELSE 2 END`,
            [principalIds(p)],
          )
        ).rows.sort((a, b) => a.name.localeCompare(b.name));
      const rows = await list();
      if (rows.length) return rows;
      await createWorkspace(c, p, "My workspace");
      return list();
    });
  });

  app.post("/api/workspaces", async (req, reply) => {
    const body = parse(z.object({ name }), req.body);
    const ws = await withTenant(req.principal.tenantId, (c) => createWorkspace(c, req.principal, body.name));
    return reply.code(201).send(ws);
  });

  app.patch("/api/workspaces/:id", async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const body = parse(z.object({ name }), req.body);
    return withTenant(req.principal.tenantId, async (c) => {
      await requireWorkspace(c, id, req.principal, "owner");
      const { rows } = await c.query("UPDATE workspaces SET name = $2 WHERE id = $1 RETURNING id, name", [id, body.name]);
      await audit(c, req.principal, "workspace.rename", id, { name: body.name });
      return rows[0];
    });
  });

  app.delete("/api/workspaces/:id", async (req, reply) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    await withTenant(req.principal.tenantId, async (c) => {
      await requireWorkspace(c, id, req.principal, "owner");
      await c.query("DELETE FROM workspaces WHERE id = $1", [id]);
      await audit(c, req.principal, "workspace.delete", id);
    });
    return reply.code(204).send();
  });

  // ---------------------------------------------------------------- members

  app.get("/api/workspaces/:id/members", async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    return withTenant(req.principal.tenantId, async (c) => {
      await requireWorkspace(c, id, req.principal, "viewer");
      const { rows } = await c.query(
        `SELECT user_id, role, added_by, created_at FROM workspace_members WHERE workspace_id = $1
         ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'editor' THEN 1 ELSE 2 END, user_id`,
        [id],
      );
      return rows;
    });
  });

  /** Add or change a member. userId is an OIDC subject or an email address. */
  app.put("/api/workspaces/:id/members", async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const body = parse(z.object({ userId: member, role }), req.body);
    const userId = body.userId.includes("@") ? body.userId.toLowerCase() : body.userId;
    return withTenant(req.principal.tenantId, async (c) => {
      await requireWorkspace(c, id, req.principal, "owner");
      if (body.role !== "owner") await assertNotLastOwner(c, id, userId);
      const { rows } = await c.query(
        `INSERT INTO workspace_members (workspace_id, tenant_id, user_id, role, added_by) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = EXCLUDED.role
         RETURNING user_id, role, added_by, created_at`,
        [id, req.principal.tenantId, userId, body.role, req.principal.userId],
      );
      await audit(c, req.principal, "workspace.member.set", id, { userId, role: body.role });
      return rows[0];
    });
  });

  app.delete("/api/workspaces/:id/members/:userId", async (req, reply) => {
    const { id, userId } = parse(z.object({ id: uuid, userId: member }), req.params);
    await withTenant(req.principal.tenantId, async (c) => {
      // Anyone may leave; only owners may remove others.
      const self = principalIds(req.principal).includes(userId);
      await requireWorkspace(c, id, req.principal, self ? "viewer" : "owner");
      await assertNotLastOwner(c, id, userId);
      await c.query("DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2", [id, userId]);
      await audit(c, req.principal, "workspace.member.remove", id, { userId });
    });
    return reply.code(204).send();
  });

  // ---------------------------------------------------------------- projects

  app.get("/api/workspaces/:id/projects", async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    return withTenant(req.principal.tenantId, async (c) => {
      await requireWorkspace(c, id, req.principal, "viewer");
      const { rows } = await c.query(
        `SELECT pr.id, pr.name, pr.description, pr.tabs, pr.created_at,
                count(d.id)::int AS diagram_count,
                GREATEST(pr.updated_at, max(d.updated_at)) AS updated_at
         FROM projects pr LEFT JOIN diagrams d ON d.project_id = pr.id
         WHERE pr.workspace_id = $1 GROUP BY pr.id ORDER BY pr.name`,
        [id],
      );
      return rows;
    });
  });

  app.post("/api/workspaces/:id/projects", async (req, reply) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const body = parse(z.object({ name, description: z.string().max(2000).default("") }), req.body);
    const row = await withTenant(req.principal.tenantId, async (c) => {
      await requireWorkspace(c, id, req.principal, "editor");
      const { rows } = await c.query(
        `INSERT INTO projects (tenant_id, workspace_id, name, description, created_by) VALUES ($1, $2, $3, $4, $5)
         RETURNING id, workspace_id, name, description, tabs, created_at, updated_at, 0 AS diagram_count`,
        [req.principal.tenantId, id, body.name, body.description, req.principal.userId],
      );
      await audit(c, req.principal, "project.create", rows[0].id, { workspaceId: id });
      return rows[0];
    });
    return reply.code(201).send(row);
  });

  app.patch("/api/projects/:id", async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const body = parse(z.object({ name: name.optional(), description: z.string().max(2000).optional(), tabs: tabs.optional() }), req.body);
    return withTenant(req.principal.tenantId, async (c) => {
      await requireProject(c, id, req.principal, "editor");
      const { rows } = await c.query(
        `UPDATE projects SET name = COALESCE($2, name), description = COALESCE($3, description), tabs = COALESCE($4, tabs), updated_at = now()
         WHERE id = $1 RETURNING id, workspace_id, name, description, tabs, updated_at`,
        [id, body.name ?? null, body.description ?? null, body.tabs ? JSON.stringify(body.tabs) : null],
      );
      // Diagrams in a deleted tab go back to "no tab" (they show under All).
      if (body.tabs)
        await c.query("UPDATE diagrams SET tab = NULL WHERE project_id = $1 AND tab IS NOT NULL AND NOT (tab = ANY($2::text[]))", [id, body.tabs.map((t) => t.id)]);
      await audit(c, req.principal, "project.update", id, body.tabs ? { tabs: body.tabs.length } : undefined);
      return rows[0];
    });
  });

  app.delete("/api/projects/:id", async (req, reply) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    await withTenant(req.principal.tenantId, async (c) => {
      await requireProject(c, id, req.principal, "owner");
      await c.query("DELETE FROM projects WHERE id = $1", [id]);
      await audit(c, req.principal, "project.delete", id);
    });
    return reply.code(204).send();
  });
}

async function createWorkspace(c: import("pg").PoolClient, p: import("../auth.js").Principal, wsName: string) {
  const { rows } = await c.query(
    "INSERT INTO workspaces (tenant_id, name, created_by) VALUES ($1, $2, $3) RETURNING id, name, created_at",
    [p.tenantId, wsName, p.userId],
  );
  const ws = rows[0];
  await c.query("INSERT INTO workspace_members (workspace_id, tenant_id, user_id, role, added_by) VALUES ($1, $2, $3, 'owner', $3)", [
    ws.id,
    p.tenantId,
    p.userId,
  ]);
  await c.query("INSERT INTO projects (tenant_id, workspace_id, name, created_by) VALUES ($1, $2, 'General', $3)", [
    p.tenantId,
    ws.id,
    p.userId,
  ]);
  await audit(c, p, "workspace.create", ws.id, { name: wsName });
  return { ...ws, role: "owner", project_count: 1, member_count: 1 };
}

async function assertNotLastOwner(c: import("pg").PoolClient, workspaceId: string, userId: string) {
  const { rows } = await c.query<{ user_id: string }>(
    "SELECT user_id FROM workspace_members WHERE workspace_id = $1 AND role = 'owner'",
    [workspaceId],
  );
  if (rows.length === 1 && rows[0].user_id === userId) throw new HttpError(409, "a workspace needs at least one owner");
}

export { parse };
