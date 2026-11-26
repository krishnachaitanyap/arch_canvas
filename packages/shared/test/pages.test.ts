import { describe, expect, it } from "vitest";
import { addPage, applyOps, emptyModel, movePage, pageModel, pageOf, pagesOf, removePage, renamePage } from "../src/index.js";

const ok = <T extends { ok: boolean }>(r: T) => {
  if (!r.ok) throw new Error((r as unknown as { error: string }).error);
  return (r as unknown as { model: ReturnType<typeof emptyModel> }).model;
};

describe("canvas tabs (pages)", () => {
  it("treats a diagram without pages as one page, and keeps old diagrams unchanged", () => {
    const m = ok(applyOps(emptyModel(), [{ op: "add_node", id: "api", kind: "gcp.cloud_run", label: "API" }]));
    expect(pagesOf(m)).toEqual([{ id: "page-1", name: "Page 1" }]);
    expect(pageOf(m, "api")).toBe("page-1");
    expect(m.nodes[0].page).toBeUndefined();
  });

  it("puts items on pages, groups' children follow the group, and lines stay on one page", () => {
    let m = addPage(emptyModel(), "HA / DR").model;
    expect(pagesOf(m).map((p) => p.id)).toEqual(["page-1", "ha-dr"]);
    m = ok(
      applyOps(m, [
        { op: "add_node", id: "api", kind: "gcp.cloud_run", label: "API" },
        { op: "add_node", id: "proj", kind: "gcp.project", label: "DR", page: "ha-dr" },
        { op: "add_node", id: "db", kind: "gcp.cloud_sql", label: "DB", parentId: "proj" },
        { op: "add_node", id: "standby", kind: "gcp.cloud_sql", label: "Standby", page: "ha-dr" },
        { op: "connect", from: "db", to: "standby" },
      ]),
    );
    expect(pageOf(m, "db")).toBe("ha-dr");
    expect(pageModel(m, "ha-dr").nodes.map((n) => n.id)).toEqual(["proj", "db", "standby"]);
    expect(pageModel(m, "page-1").nodes.map((n) => n.id)).toEqual(["api"]);
    const cross = applyOps(m, [{ op: "connect", from: "api", to: "db" }]);
    expect(cross.ok).toBe(false);
  });

  it("moves an item to another tab, dropping lines to what stays behind", () => {
    let m = addPage(emptyModel(), "CI/CD").model;
    m = ok(
      applyOps(m, [
        { op: "add_node", id: "a", kind: "gcp.cloud_run", label: "A" },
        { op: "add_node", id: "b", kind: "gcp.cloud_sql", label: "B" },
        { op: "connect", from: "a", to: "b" },
        { op: "update_node", id: "b", page: "ci-cd" },
      ]),
    );
    expect(pageOf(m, "b")).toBe("ci-cd");
    expect(m.edges).toEqual([]);
  });

  it("renames, reorders and removes pages; removing deletes what's on it", () => {
    let m = addPage(emptyModel(), "Two").model;
    m = ok(
      applyOps(m, [
        { op: "add_node", id: "a", kind: "generic.component", label: "A" },
        { op: "add_node", id: "b", kind: "generic.component", label: "B", page: "two" },
      ]),
    );
    m = renamePage(m, "two", "Second");
    m = movePage(m, "two", -1);
    expect(pagesOf(m).map((p) => p.name)).toEqual(["Second", "Page 1"]);
    // "a" had no page (the old first page); it stays on Page 1 after the reorder.
    expect(pageOf(m, "a")).toBe("page-1");
    m = removePage(m, "page-1");
    expect(m.nodes.map((n) => n.id)).toEqual(["b"]);
    expect(removePage(m, "two")).toBe(m); // can't remove the last page
  });
});

describe("canvas tabs in draw.io", () => {
  it("exports one draw.io page per tab and imports them back as tabs", async () => {
    const { toDrawio, readDrawio, drawioPagesToModel } = await import("../src/index.js");
    let m = addPage(emptyModel(), "HA / DR").model;
    m = ok(
      applyOps(m, [
        { op: "add_node", id: "api", kind: "gcp.cloud_run", label: "API" },
        { op: "add_node", id: "db", kind: "gcp.cloud_sql", label: "DB" },
        { op: "connect", from: "api", to: "db" },
        { op: "add_node", id: "standby", kind: "gcp.cloud_sql", label: "Standby", page: "ha-dr" },
      ]),
    );
    m = { ...m, layout: { api: { x: 0, y: 0 }, db: { x: 300, y: 0 }, standby: { x: 0, y: 0 } } };
    const pages = await readDrawio(toDrawio(m, "Orders"));
    expect(pages.map((p) => p.name)).toEqual(["Page 1", "HA / DR"]);
    const back = drawioPagesToModel(pages);
    expect(pagesOf(back).map((p) => p.name)).toEqual(["Page 1", "HA / DR"]);
    expect(pageModel(back, pagesOf(back)[1].id).nodes.map((n) => n.id)).toEqual(["standby"]);
    expect(pageModel(back, pagesOf(back)[0].id).edges.map((e) => e.id)).toEqual(["api__db"]);
  });

  it("keeps a one-page diagram a single draw.io page named after the diagram", async () => {
    const { toDrawio, readDrawio } = await import("../src/index.js");
    const m = ok(applyOps(emptyModel(), [{ op: "add_node", id: "api", kind: "gcp.cloud_run", label: "API" }]));
    expect((await readDrawio(toDrawio(m, "Orders"))).map((p) => p.name)).toEqual(["Orders"]);
  });
});

describe("rotation", () => {
  it("keeps an item's rotation through draw.io", async () => {
    const { toDrawio, readDrawio, drawioToModel } = await import("../src/index.js");
    const m0 = ok(applyOps(emptyModel(), [{ op: "add_node", id: "arrow", kind: "generic.shape", label: "", props: { shape: "arrow-right" } }]));
    const m = { ...m0, layout: { arrow: { x: 10, y: 20, w: 140, h: 70, r: 45 } } };
    const xml = toDrawio(m, "R");
    expect(xml).toContain("rotation=45;");
    const back = drawioToModel((await readDrawio(xml))[0]).model;
    expect(back.layout.arrow.r).toBe(45);
  });
});
