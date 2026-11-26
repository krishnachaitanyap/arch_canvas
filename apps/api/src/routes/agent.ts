import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { DiagramModelSchema } from "@archcanvas/shared";
import { type AgentEvent, runAgent } from "../agent.js";
import { withTenant } from "../db.js";

const body = z.object({
  message: z.string().min(1).max(20_000),
  model: DiagramModelSchema,
  history: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(20_000) }))
    .max(40)
    .default([]),
  diagramId: z.string().uuid().optional(),
});

/**
 * POST /api/agent — runs the diagram agent and streams Server-Sent Events:
 * text, tool, model (working copy after each edit), terraform, done, error.
 */
export async function agentRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/agent", async (req, reply) => {
    const parsed = body.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const { message, model, history, diagramId } = parsed.data;

    reply.hijack();
    reply.raw.writeHead(200, {
      ...(reply.getHeaders() as Record<string, string>),
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    const send = (e: AgentEvent | { type: "error"; message: string }) => {
      if (!reply.raw.writableEnded) reply.raw.write(`data: ${JSON.stringify(e)}\n\n`);
    };

    const started = Date.now();
    let tools = 0;
    try {
      await runAgent(model, message, history, (e) => {
        if (e.type === "tool") tools++;
        send(e);
      });
    } catch (err) {
      req.log.error({ err }, "agent run failed");
      send({ type: "error", message: (err as Error).message });
    } finally {
      reply.raw.end();
      await withTenant(req.principal.tenantId, (c) =>
        c.query("INSERT INTO audit_log (tenant_id, actor, action, target, meta) VALUES ($1, $2, 'ai.agent', $3, $4)", [
          req.principal.tenantId,
          req.principal.userId,
          diagramId ?? null,
          { promptChars: message.length, tools, ms: Date.now() - started },
        ]),
      ).catch((err) => req.log.warn({ err }, "audit write failed"));
    }
  });
}
