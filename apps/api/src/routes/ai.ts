import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { DiagramModelSchema, describeIntegrations, generateWorkflows, nodeById, type Workflow } from "@archcanvas/shared";
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
  app.post("/api/ai/workflows", async (req, reply) => {
    const parsed = narrateBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    try {
      return await narrateWorkflows(parsed.data.model, parsed.data.title, parsed.data.context);
    } catch (err) {
      req.log.error({ err }, "workflow narration failed");
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

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

const NARRATE_PROMPT = `You write clear architecture walkthroughs for engineers and stakeholders.

You get workflows generated from a Google Cloud architecture diagram, plus facts about each integration.
Rewrite ONLY the wording: a short, specific title per workflow (what the user or system is doing, e.g. "Customer uploads a document"),
a one- or two-sentence summary, and one plain sentence per step explaining what happens and why.

Rules:
- Return JSON only: {"workflows":[{"id":"...","title":"...","summary":"...","steps":[{"edgeId":"...","text":"..."}]}]}
- Keep every workflow id and every step edgeId exactly as given, in the same order. Do not add or remove steps.
- Use only the facts given. Do not invent services, data, or behaviour.
- Use the component names as given. No markdown.`;

const narrateBody = z.object({ model: DiagramModelSchema, title: z.string().max(200).optional(), context: z.string().max(4000).optional() });
const narrated = z.object({
  workflows: z.array(
    z.object({
      id: z.string(),
      title: z.string().min(1).max(120),
      summary: z.string().min(1).max(600),
      steps: z.array(z.object({ edgeId: z.string(), text: z.string().min(1).max(400) })),
    }),
  ),
});

/**
 * Rewrites the generated workflows' wording with the LLM. Structure always comes from the
 * diagram: any workflow or step the model changed, dropped or invented is ignored.
 */
export async function narrateWorkflows(
  model: z.infer<typeof DiagramModelSchema>,
  title?: string,
  context?: string,
): Promise<{ workflows: Workflow[]; rewritten: number }> {
  const base = generateWorkflows(model);
  if (!base.length) return { workflows: base, rewritten: 0 };
  const facts = describeIntegrations(model).map((i) => ({
    edgeId: i.edgeId,
    from: nodeById(model, i.from)?.label,
    to: nodeById(model, i.to)?.label,
    pattern: i.pattern,
    summary: i.summary,
    howItWorks: i.howItWorks,
  }));
  const input = {
    diagram: title ?? "Architecture",
    context: context ?? "",
    workflows: base.map((w) => ({ id: w.id, title: w.title, summary: w.summary, trigger: w.trigger, steps: w.steps.map((s) => ({ edgeId: s.edgeId, text: s.text })) })),
    integrations: facts,
  };
  const raw = await complete(NARRATE_PROMPT, [{ role: "user", content: JSON.stringify(input) }], 8192);
  const json = raw.match(/\{[\s\S]*\}/)?.[0];
  const parsed = json ? narrated.safeParse(JSON.parse(json)) : undefined;
  if (!parsed?.success) throw new Error("The AI response was not in the expected format; showing the generated workflows instead.");
  let rewritten = 0;
  const workflows = base.map((w) => {
    const r = parsed.data.workflows.find((x) => x.id === w.id);
    const sameSteps = r && r.steps.length === w.steps.length && r.steps.every((s, i) => s.edgeId === w.steps[i].edgeId);
    if (!r || !sameSteps) return w;
    rewritten++;
    return { ...w, title: r.title, summary: r.summary, steps: w.steps.map((s, i) => ({ ...s, text: r.steps[i].text })) };
  });
  return { workflows, rewritten };
}

export function stripFences(text: string): string {
  const m = text.match(/```(?:mermaid)?\s*\n([\s\S]*?)```/);
  return (m ? m[1] : text).trim();
}
