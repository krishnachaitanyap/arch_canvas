import { describe, expect, it } from "vitest";
import { emptyModel, SAMPLE_MODEL } from "@archcanvas/shared";
import { execute, systemPrompt } from "../src/agent.js";

const call = (name: string, args: Record<string, unknown> = {}) => ({ id: "t1", name, args });

describe("agent tools", () => {
  it("applies a batch of loose model-produced operations and reports failures", () => {
    const r = execute(
      call("edit_diagram", {
        operations: [
          { op: "add_node", id: "prod", kind: "gcp.project", label: "Prod" },
          { op: "add_node", id: "api", kind: "gcp.cloud_run", label: "API", parentId: "prod", props: { min_instances: 1 } },
          { op: "add_node", id: "db", kind: "gcp.cloud_sql", label: "DB", parentId: "prod" },
          { op: "connect", from: "api", to: "db", protocol: "sql", edgeLabel: "reads" },
          { op: "add_node", id: "sub", kind: "gcp.subnet", label: "bad", parentId: "prod" },
          { op: "explode" },
        ],
      }),
      emptyModel(),
    );
    expect(r.ok).toBe(false);
    expect(r.summary).toBe("Applied 4 of 6 changes (2 failed)");
    expect(r.model?.nodes.map((n) => n.id)).toEqual(["prod", "api", "db"]);
    expect(r.model?.edges[0]).toMatchObject({ from: "api", to: "db", protocol: "sql", label: "reads" });
  });

  it("moves a node to the top level with an empty parentId", () => {
    const r = execute(call("edit_diagram", { operations: [{ op: "update_node", id: "jobs", parentId: "" }] }), SAMPLE_MODEL);
    expect(r.model?.nodes.find((n) => n.id === "jobs")?.parentId).toBeUndefined();
  });

  it("validates and compiles without changing the model", () => {
    expect(execute(call("validate_diagram"), SAMPLE_MODEL).model).toBeUndefined();
    const tf = execute(call("generate_terraform"), SAMPLE_MODEL);
    expect(tf.summary).toMatch(/Generated Terraform: \d+ resources/);
  });

  it("puts the whole catalog in the system prompt", () => {
    expect(systemPrompt()).toContain("gcp.memorystore_redis");
  });
});
