import Fastify from "fastify";
import cors from "@fastify/cors";
import { config } from "./config.js";
import { authenticate } from "./auth.js";
import { pool } from "./db.js";
import { migrate } from "./migrate.js";
import { agentRoutes } from "./routes/agent.js";
import { aiRoutes } from "./routes/ai.js";
import { diagramRoutes } from "./routes/diagrams.js";
import { iconRoutes } from "./routes/icons.js";
import { tokenRoutes } from "./routes/tokens.js";
import { liveRoutes } from "./routes/live.js";
import { terraformRoutes } from "./routes/terraform.js";
import { workspaceRoutes } from "./routes/workspaces.js";

const app = Fastify({ logger: true, bodyLimit: 5 * 1024 * 1024 });

// Client errors carry their own status (HttpError, validation); everything else is a 500.
app.setErrorHandler((err: Error & { statusCode?: number; validation?: unknown }, req, reply) => {
  const status = err.statusCode && err.statusCode < 500 ? err.statusCode : 500;
  if (status === 500) req.log.error({ err }, "request failed");
  return reply.code(status).send({ error: status === 500 ? "internal error" : err.message });
});

await app.register(cors, { origin: config.CORS_ORIGIN === "*" ? true : config.CORS_ORIGIN.split(",") });

// Health probes (unauthenticated) for Kubernetes / Cloud Run
app.get("/healthz", async () => ({ ok: true }));
app.get("/readyz", async (_req, reply) => {
  try {
    await pool.query("SELECT 1");
    return { ok: true };
  } catch {
    return reply.code(503).send({ ok: false });
  }
});

app.get("/api/config", async () => ({
  aiEnabled: config.LLM_PROVIDER !== "none",
  aiProvider: config.LLM_PROVIDER,
  aiModel: config.LLM_MODEL,
  authEnabled: Boolean(config.OIDC_ISSUER),
  // Shown in dev so you know who you are acting as; with OIDC the web app reads the token.
  devUser: config.OIDC_ISSUER ? undefined : "dev-user",
}));

// Everything under /api (except /api/config) requires auth
await app.register(async (secured) => {
  secured.addHook("onRequest", authenticate);
  await secured.register(workspaceRoutes);
  await secured.register(diagramRoutes);
  await secured.register(iconRoutes);
  await secured.register(aiRoutes);
  await secured.register(agentRoutes);
  await secured.register(terraformRoutes);
  await secured.register(tokenRoutes);
  await secured.register(liveRoutes);
});

if (process.env.MIGRATE_ON_START !== "false") await migrate();

await app.listen({ port: config.PORT, host: "0.0.0.0" });

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    await app.close();
    await pool.end();
    process.exit(0);
  });
}
