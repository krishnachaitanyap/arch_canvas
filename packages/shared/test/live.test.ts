import { describe, expect, it } from "vitest";
import { applyPatch, type DiagramModel, diffPatch, SAMPLE_MODEL } from "../src/index.js";

const base: DiagramModel = { ...SAMPLE_MODEL, layout: { users: { x: 0, y: 0 }, api: { x: 10, y: 10 } } };

describe("live collaboration patches", () => {
  it("round-trips: applying a's diff to a gives b", () => {
    const b: DiagramModel = {
      ...base,
      nodes: [...base.nodes.filter((n) => n.id !== "uploads").map((n) => (n.id === "api" ? { ...n, label: "Orders API" } : n)), { id: "cdn", kind: "generic.component", label: "CDN", props: {} }],
      edges: base.edges.filter((e) => e.to !== "uploads"),
      layout: { users: { x: 5, y: 0 }, cdn: { x: 1, y: 1 } },
      pages: [{ id: "page-1", name: "Main" }],
      settings: { terraform: true },
    };
    const p = diffPatch(base, b)!;
    expect(p.nodes?.del).toEqual(["uploads"]);
    expect(p.nodes?.set?.map((n) => n.id)).toEqual(["api", "cdn"]);
    const r = applyPatch(base, p);
    expect(r).toEqual({ ...b, nodes: r.nodes });
    expect(new Set(r.nodes.map((n) => n.id))).toEqual(new Set(b.nodes.map((n) => n.id)));
    expect(diffPatch(base, base)).toBeNull();
  });

  it("merges two people's edits to different items", () => {
    const alice = { ...base, nodes: base.nodes.map((n) => (n.id === "api" ? { ...n, label: "API v2" } : n)) };
    const bob = { ...base, layout: { ...base.layout, users: { x: 99, y: 0 } } };
    const server = applyPatch(applyPatch(base, diffPatch(base, alice)!), diffPatch(base, bob)!);
    expect(server.nodes.find((n) => n.id === "api")!.label).toBe("API v2");
    expect(server.layout.users).toEqual({ x: 99, y: 0 });
  });

  it("repairs what concurrent edits leave behind", () => {
    // Alice deletes a group while Bob connects a new item inside it.
    const alice = { ...base, nodes: base.nodes.filter((n) => n.id !== "main_vpc") };
    const bob = {
      ...base,
      nodes: [...base.nodes, { id: "pg2", kind: "gcp.cloud_sql", label: "Replica", parentId: "main_vpc", props: {} }],
      edges: [...base.edges, { id: "api__pg2", from: "api", to: "pg2" }],
    };
    const m = applyPatch(applyPatch(base, diffPatch(base, alice)!), diffPatch(base, bob)!);
    expect(m.nodes.find((n) => n.id === "pg2")!.parentId).toBeUndefined();
    const gone = applyPatch(m, { nodes: { del: ["pg2"] } });
    expect(gone.edges.some((e) => e.to === "pg2")).toBe(false);
  });
});
