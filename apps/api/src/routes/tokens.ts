import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool } from "../db.js";
import { parse } from "./workspaces.js";

/**
 * Personal API tokens: for scripts, CI (the GitHub action) and AI agents (the MCP server).
 * A token acts as the user who made it, with that user's workspace roles. The token itself is
 * shown once; only its SHA-256 hash is stored.
 */
export const TOKEN_PREFIX = "ac_";
export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

const create = z.object({
  name: z.string().trim().min(1).max(80),
  /** Days until it expires; none means it lasts until revoked. */
  expiresInDays: z.number().int().min(1).max(366).optional(),
});

export async function tokenRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/tokens", async (req) => {
    const { rows } = await pool.query(
      `SELECT id, name, prefix, created_at, last_used_at, expires_at FROM api_tokens WHERE tenant_id = $1 AND user_id = $2 ORDER BY created_at DESC`,
      [req.principal.tenantId, req.principal.userId],
    );
    return rows;
  });

  app.post("/api/tokens", async (req, reply) => {
    const body = parse(create, req.body);
    const token = TOKEN_PREFIX + randomBytes(24).toString("base64url");
    const id = randomUUID();
    const expires = body.expiresInDays ? new Date(Date.now() + body.expiresInDays * 86_400_000).toISOString() : null;
    await pool.query(
      `INSERT INTO api_tokens (id, tenant_id, user_id, email, name, token_hash, prefix, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [id, req.principal.tenantId, req.principal.userId, req.principal.email ?? null, body.name, hashToken(token), token.slice(0, 7), expires],
    );
    reply.code(201);
    // The only time the token is shown.
    return { id, name: body.name, token, expires_at: expires };
  });

  app.delete("/api/tokens/:id", async (req, reply) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const { rowCount } = await pool.query(`DELETE FROM api_tokens WHERE id = $1 AND tenant_id = $2 AND user_id = $3`, [id, req.principal.tenantId, req.principal.userId]);
    if (!rowCount) return reply.code(404).send({ error: "no such token" });
    return reply.code(204).send();
  });
}

/** The user an API token belongs to, or null when it's unknown or expired. */
export async function principalForToken(token: string): Promise<{ userId: string; tenantId: string; email?: string } | null> {
  const { rows } = await pool.query<{ id: string; user_id: string; tenant_id: string; email: string | null; expires_at: string | Date | null }>(
    `SELECT id, user_id, tenant_id, email, expires_at FROM api_tokens WHERE token_hash = $1`,
    [hashToken(token)],
  );
  const t = rows[0];
  if (!t || (t.expires_at && new Date(t.expires_at).getTime() < Date.now())) return null;
  // Best effort; never blocks the request.
  void pool.query(`UPDATE api_tokens SET last_used_at = now() WHERE id = $1`, [t.id]).catch(() => undefined);
  return { userId: t.user_id, tenantId: t.tenant_id, ...(t.email ? { email: t.email } : {}) };
}
