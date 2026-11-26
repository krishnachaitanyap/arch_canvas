import { describe, expect, it, vi } from "vitest";
import { generateWorkflows, SAMPLE_MODEL } from "@archcanvas/shared";

const reply = vi.hoisted(() => ({ text: "" }));
vi.mock("../src/llm.js", () => ({ complete: vi.fn(async () => reply.text) }));

const { narrateWorkflows } = await import("../src/routes/ai.js");

describe("narrateWorkflows", () => {
  const base = generateWorkflows(SAMPLE_MODEL);

  it("takes the model's wording but keeps the structure from the diagram", async () => {
    const [request, async_] = base;
    reply.text =
      "Here you go:\n" +
      JSON.stringify({
        workflows: [
          {
            id: request.id,
            title: "Customer uses the app",
            summary: "A customer request flows through the load balancer to the API.",
            steps: request.steps.map((s) => ({ edgeId: s.edgeId, text: `Rewritten ${s.edgeId}` })),
          },
          // Dropped a step: must be ignored, keeping the generated text.
          { id: async_.id, title: "Bad", summary: "Bad", steps: async_.steps.slice(1).map((s) => ({ edgeId: s.edgeId, text: "x" })) },
          // Invented workflow: must be ignored.
          { id: "made-up", title: "Invented", summary: "Invented", steps: [] },
        ],
      });
    const out = await narrateWorkflows(SAMPLE_MODEL, "Sample");
    expect(out.rewritten).toBe(1);
    expect(out.workflows.map((w) => w.id)).toEqual(base.map((w) => w.id));
    expect(out.workflows[0]).toMatchObject({ title: "Customer uses the app", steps: request.steps.map((s) => ({ ...s, text: `Rewritten ${s.edgeId}` })) });
    expect(out.workflows[1]).toEqual(async_);
  });

  it("rejects replies that are not the expected JSON", async () => {
    reply.text = "Sorry, I can't help with that.";
    await expect(narrateWorkflows(SAMPLE_MODEL)).rejects.toThrow(/expected format/);
  });
});
