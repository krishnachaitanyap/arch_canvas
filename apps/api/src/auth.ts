import type { FastifyReply, FastifyRequest } from "fastify";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { config } from "./config.js";
import { principalForToken, TOKEN_PREFIXES } from "./routes/tokens.js";

export interface Principal {
  userId: string;
  tenantId: string;
  email?: string;
}

declare module "fastify" {
  interface FastifyRequest {
    principal: Principal;
  }
}

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

/** Resolves the IdP's signing keys via standard OIDC discovery. */
async function getJwks(): Promise<ReturnType<typeof createRemoteJWKSet>> {
  if (jwks) return jwks;
  const res = await fetch(`${config.OIDC_ISSUER.replace(/\/$/, "")}/.well-known/openid-configuration`);
  if (!res.ok) throw new Error(`OIDC discovery failed: ${res.status}`);
  const { jwks_uri } = (await res.json()) as { jwks_uri: string };
  jwks = createRemoteJWKSet(new URL(jwks_uri));
  return jwks;
}

/**
 * OIDC bearer-token auth. Works with any standards-compliant IdP:
 * Keycloak (default for self-hosted), Google Identity Platform, Okta, Entra ID.
 *
 * With OIDC_ISSUER unset the API runs in dev mode: no auth, single "default" tenant. The
 * acting user is "dev-user", or whatever the x-dev-user header says (to try out roles).
 */
export async function authenticate(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  // Personal API tokens (scripts, CI, the MCP server) work with or without OIDC.
  const bearer = req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7).trim() : "";
  if (TOKEN_PREFIXES.some((p) => bearer.startsWith(p))) {
    const p = await principalForToken(bearer);
    if (!p) {
      await reply.code(401).send({ error: "invalid or expired API token" });
      return;
    }
    req.principal = p;
    return;
  }
  if (!config.OIDC_ISSUER) {
    const devUser = req.headers["x-dev-user"];
    const userId = typeof devUser === "string" && devUser.trim() ? devUser.trim().slice(0, 200) : "dev-user";
    req.principal = { userId, tenantId: "default", ...(userId.includes("@") ? { email: userId.toLowerCase() } : {}) };
    return;
  }
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    await reply.code(401).send({ error: "missing bearer token" });
    return;
  }
  try {
    const { payload } = await jwtVerify(header.slice(7), await getJwks(), {
      issuer: config.OIDC_ISSUER,
      audience: config.OIDC_AUDIENCE,
    });
    req.principal = toPrincipal(payload);
  } catch {
    await reply.code(401).send({ error: "invalid token" });
  }
}

function toPrincipal(p: JWTPayload): Principal {
  const tenant = p[config.TENANT_CLAIM];
  return {
    userId: String(p.sub),
    tenantId: typeof tenant === "string" && tenant ? tenant : "default",
    email: typeof p.email === "string" ? p.email : undefined,
  };
}
