import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { complete } from "../llm.js";
import { withTenant } from "../db.js";

const SYSTEM_PROMPT = `You are an expert software architect who draws diagrams as Mermaid code.

Rules:
- Output ONLY Mermaid code. No prose, no explanations, no markdown fences.
- Prefer "flowchart LR" or "flowchart TD" for architecture and data-flow diagrams.
- Use "sequenceDiagram" for request/response flows, "erDiagram" for data models, "classDiagram" for object models.
- Group related components with subgraph blocks (e.g. per cloud, VPC, network zone or team).
- Use short, clear node labels. Label edges with the protocol or action (e.g. HTTPS, gRPC, publishes).
- Keep diagrams readable: at most ~25 nodes unless the user asks for more.
- When editing an existing diagram, return the complete updated diagram, preserving what the user did not ask to change.`;

const body = z.object({
  prompt: z.string().min(1).max(20_000),
  currentSource: z.string().max(50_000).optional(),
});

export async function aiRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/ai/generate", async (req, reply) => {
    const parsed = body.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const { prompt, currentSource } = parsed.data;

    const userContent = currentSource
      ? `Current diagram:\n${currentSource}\n\nChange request: ${prompt}`
      : `Draw: ${prompt}`;

    try {
      const raw = await complete(SYSTEM_PROMPT, [{ role: "user", content: userContent }]);
      const source = stripFences(raw);
      await withTenant(req.principal.tenantId, (c) =>
        c.query(
          "INSERT INTO audit_log (tenant_id, actor, action, meta) VALUES ($1, $2, 'ai.generate', $3)",
          [req.principal.tenantId, req.principal.userId, { promptChars: prompt.length, edit: Boolean(currentSource) }],
        ),
      ).catch((err) => req.log.warn({ err }, "audit write failed"));
      return { source };
    } catch (err) {
      req.log.error({ err }, "AI generation failed");
      return reply.code(502).send({ error: (err as Error).message });
    }
  });
}

export function stripFences(text: string): string {
  const m = text.match(/```(?:mermaid)?\s*\n([\s\S]*?)```/);
  return (m ? m[1] : text).trim();
}
