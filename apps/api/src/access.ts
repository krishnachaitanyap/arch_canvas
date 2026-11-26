import type pg from "pg";
import type { Principal } from "./auth.js";

/**
 * Workspace-level access control. Tenants isolate organisations (Postgres RLS); within a
 * tenant, workspace membership decides who sees what:
 *   viewer  read diagrams, versions and comparisons
 *   editor  also create and edit projects and diagrams, restore versions
 *   owner   also manage members, rename and delete the workspace, delete projects
 * Non-members get 404s, so workspaces they can't see stay invisible.
 */
export type Role = "owner" | "editor" | "viewer";
export const ROLES: Role[] = ["owner", "editor", "viewer"];
const RANK: Record<Role, number> = { viewer: 1, editor: 2, owner: 3 };

export const atLeast = (role: Role, min: Role) => RANK[role] >= RANK[min];

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

/** Members are stored by OIDC subject or by email (for people invited before first login). */
export const principalIds = (p: Principal) => [p.userId, ...(p.email ? [p.email.toLowerCase()] : [])];

type Db = pg.PoolClient;

export async function workspaceRole(c: Db, workspaceId: string, p: Principal): Promise<Role | null> {
  const { rows } = await c.query<{ role: Role }>(
    "SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = ANY($2)",
    [workspaceId, principalIds(p)],
  );
  return rows.map((r) => r.role).sort((a, b) => RANK[b] - RANK[a])[0] ?? null;
}

export async function requireWorkspace(c: Db, workspaceId: string, p: Principal, min: Role): Promise<Role> {
  const role = await workspaceRole(c, workspaceId, p);
  if (!role) throw new HttpError(404, "workspace not found");
  if (!atLeast(role, min)) throw new HttpError(403, `this needs the ${min} role in the workspace (you are ${role})`);
  return role;
}

export interface ProjectRow {
  id: string;
  workspace_id: string;
  name: string;
  description: string;
}

export async function requireProject(c: Db, projectId: string, p: Principal, min: Role): Promise<{ project: ProjectRow; role: Role }> {
  const { rows } = await c.query<ProjectRow>("SELECT id, workspace_id, name, description FROM projects WHERE id = $1", [projectId]);
  if (!rows[0]) throw new HttpError(404, "project not found");
  const role = await workspaceRole(c, rows[0].workspace_id, p);
  if (!role) throw new HttpError(404, "project not found");
  if (!atLeast(role, min)) throw new HttpError(403, `this needs the ${min} role in the workspace (you are ${role})`);
  return { project: rows[0], role };
}

export interface DiagramRow {
  id: string;
  project_id: string;
  workspace_id: string;
  title: string;
  kind: "whiteboard" | "cloud";
  source: string;
  scene: Record<string, unknown>;
  model: unknown;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

/** Loads a diagram the caller may access. `forUpdate` locks the row for the rest of the transaction. */
export async function requireDiagram(
  c: Db,
  diagramId: string,
  p: Principal,
  min: Role,
  forUpdate = false,
): Promise<{ diagram: DiagramRow; role: Role }> {
  const { rows } = await c.query<DiagramRow>(
    `SELECT d.*, pr.workspace_id FROM diagrams d JOIN projects pr ON pr.id = d.project_id
     WHERE d.id = $1 ${forUpdate ? "FOR UPDATE OF d" : ""}`,
    [diagramId],
  );
  if (!rows[0]) throw new HttpError(404, "diagram not found");
  const role = await workspaceRole(c, rows[0].workspace_id, p);
  if (!role) throw new HttpError(404, "diagram not found");
  if (!atLeast(role, min)) throw new HttpError(403, `this needs the ${min} role in the workspace (you are ${role})`);
  return { diagram: rows[0], role };
}

export async function audit(c: Db, p: Principal, action: string, target: string | null, meta: Record<string, unknown> = {}) {
  await c.query("INSERT INTO audit_log (tenant_id, actor, action, target, meta) VALUES ($1, $2, $3, $4, $5)", [
    p.tenantId,
    p.userId,
    action,
    target,
    meta,
  ]);
}
