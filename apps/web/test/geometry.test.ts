import { describe, expect, it } from "vitest";
import { NODE_W } from "../src/cloud/layout";
import { applyOps, type DiagramModel, emptyModel } from "@archcanvas/shared";
import { absBox, align, containerAt, copySelection, growGroups, pasteOps, placeMissing, reparentOps } from "../src/cloud/geometry";

function build(): DiagramModel {
  const r = applyOps(emptyModel(), [
    { op: "add_node", id: "prod", kind: "gcp.project", label: "Prod" },
    { op: "add_node", id: "vpc", kind: "gcp.vpc", label: "VPC", parentId: "prod" },
    { op: "add_node", id: "api", kind: "gcp.cloud_run", label: "API", parentId: "prod" },
    { op: "add_node", id: "db", kind: "gcp.cloud_sql", label: "DB", parentId: "vpc" },
    { op: "add_node", id: "ext", kind: "generic.component", label: "Stripe" },
    { op: "connect", from: "api", to: "db" },
  ]);
  if (!r.ok) throw new Error(r.error);
  return {
    ...r.model,
    layout: {
      prod: { x: 0, y: 0, w: 800, h: 500 },
      vpc: { x: 400, y: 60, w: 360, h: 300 },
      api: { x: 40, y: 80 },
      db: { x: 40, y: 80 },
      ext: { x: 1000, y: 100 },
    },
  };
}

describe("canvas geometry", () => {
  it("computes absolute boxes through nested groups", () => {
    expect(absBox(build(), "db")).toMatchObject({ x: 440, y: 140 });
  });

  it("finds the deepest group a node may be dropped into", () => {
    const m = build();
    expect(containerAt(m, { x: 500, y: 200 }, "gcp.cloud_sql")?.id).toBe("vpc");
    // A load balancer can't live in a VPC on GCP, so the project is the target instead.
    expect(containerAt(m, { x: 500, y: 200 }, "gcp.load_balancer")?.id).toBe("prod");
    expect(containerAt(m, { x: 900, y: 600 }, "gcp.cloud_run")).toBeUndefined();
    // A group can't be dropped into itself.
    expect(containerAt(m, { x: 500, y: 200 }, "gcp.vpc", ["vpc"])?.id).toBe("prod");
  });

  it("re-parents without moving the node on screen", () => {
    const m = build();
    const before = absBox(m, "api");
    const { ops, layout } = reparentOps(m, "api", undefined);
    const r = applyOps(m, ops);
    if (!r.ok) throw new Error(r.error);
    const after = { ...r.model, layout: layout(r.model) };
    expect(after.nodes.find((n) => n.id === "api")?.parentId).toBeUndefined();
    expect(absBox(after, "api")).toMatchObject({ x: before.x, y: before.y });
  });

  it("grows groups to fit their contents and places new nodes below siblings", () => {
    const m = build();
    const moved = { ...m, layout: { ...m.layout, db: { x: 340, y: 280 } } };
    const grown = growGroups(moved);
    expect(grown.vpc.w).toBeGreaterThanOrEqual(340 + NODE_W);
    expect(grown.prod.w).toBeGreaterThanOrEqual(400 + grown.vpc.w!);
    const r = applyOps(m, [{ op: "add_node", id: "cache", kind: "gcp.memorystore_redis", label: "Cache", parentId: "vpc" }]);
    if (!r.ok) throw new Error(r.error);
    const placed = placeMissing(r.model);
    expect(placed.cache.y).toBeGreaterThan(m.layout.db.y);
  });

  it("aligns and distributes in absolute coordinates", () => {
    const m = build();
    const l = align(m, ["api", "ext"], "top");
    const mm = { ...m, layout: l };
    expect(absBox(mm, "api").y).toBe(absBox(mm, "ext").y);
  });

  it("copies a group with its contents and pastes it with fresh ids", () => {
    const m = build();
    const clip = copySelection(m, ["vpc"])!;
    expect(clip.nodes.map((n) => n.id).sort()).toEqual(["db", "vpc"]);
    const r = pasteOps(m, clip, 40);
    if ("error" in r) throw new Error(r.error);
    const copy = r.model.nodes.find((n) => n.id === "vpc_copy")!;
    expect(copy.parentId).toBe("prod");
    expect(r.model.nodes.find((n) => n.id === "db_copy")?.parentId).toBe("vpc_copy");
    expect(r.model.layout.vpc_copy).toMatchObject({ x: 440, y: 100 });
    expect(r.ids).toEqual(["vpc_copy"]);
  });

  it("imports keep their ids unless taken, and move by an x/y offset", () => {
    const m = build();
    const clip = copySelection(m, ["vpc", "ext"])!;
    const r = pasteOps(m, clip, { x: 1200, y: 0 }, undefined, true);
    if ("error" in r) throw new Error(r.error);
    // vpc, db and ext already exist, so they get suffixes; positions move right by 1200.
    expect(r.ids.sort()).toEqual(["ext_2", "vpc_2"]);
    expect(r.model.nodes.find((n) => n.id === "db_2")?.parentId).toBe("vpc_2");
    expect(r.model.layout.ext_2).toMatchObject({ x: 2200, y: 100 });
    const fresh = pasteOps({ ...m, nodes: [], edges: [], layout: {} }, clip, { x: 0, y: 0 }, undefined, true);
    if ("error" in fresh) throw new Error(fresh.error);
    expect(fresh.ids.sort()).toEqual(["ext", "vpc"]);
  });
});
