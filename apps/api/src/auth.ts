import type { FastifyReply, FastifyRequest } from "fastify";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { config } from "./config.js";

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
 * With OIDC_ISSUER unset the API runs in dev mode: no auth, single "default" tenant.
 */
export async function authenticate(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!config.OIDC_ISSUER) {
    req.principal = { userId: "dev-user", tenantId: "default" };
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
