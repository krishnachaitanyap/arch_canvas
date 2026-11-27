import { describe, expect, it } from "vitest";
import { compileTerraform, type DiagramModel, describeChanges, lineDiff, parseCode, SAMPLE_MODEL, toCode } from "../src/index.js";

const parse = (src: string, base?: DiagramModel) => {
  const r = parseCode(src, base);
  if (!r.ok) throw new Error(r.errors.map((e) => `${e.line}:${e.col} ${e.message}`).join("\n"));
  return r.model;
};

/** Same diagram regardless of node order. */
const canon = (m: DiagramModel) => ({
  ...m,
  nodes: [...m.nodes].sort((a, b) => a.id.localeCompare(b.id)),
  edges: [...m.edges].sort((a, b) => a.id.localeCompare(b.id)),
});

describe("diagram code", () => {
  it("round-trips the sample architecture and compiles the same Terraform", () => {
    const code = toCode(SAMPLE_MODEL);
    expect(code).toContain('prod "Production" [gcp.project] {');
    expect(code).toContain("api -> db [sql]");
    const back = parse(code);
    expect(canon(back)).toEqual(canon(SAMPLE_MODEL));
    expect(toCode(back)).toBe(code);
    // Same resources (the code lists items group by group, so the order can differ).
    expect([...compileTerraform(back).resources].sort()).toEqual([...compileTerraform(SAMPLE_MODEL).resources].sort());
    expect(compileTerraform(parse(toCode(back))).files).toEqual(compileTerraform(back).files);
  });

  it("reads Eraser-style code: short types, arrows, labels, styles", () => {
    const m = parse(`
      // a small system
      terraform on
      users "Customers" [client]
      app "App project" [project] {
        api "Orders API" [cloud_run, min_instances: 2, public: true]
        db [cloud_sql, tier: "db-custom-2-7680"]
      }
      users > api "HTTPS" [https, curved]
      api --> db [sql, color: "#1A73E8"]
      api <..> users [end: diamond]
    `);
    expect(m.settings).toEqual({ terraform: true });
    expect(m.nodes.map((n) => [n.id, n.kind, n.parentId])).toEqual([
      ["users", "generic.client", undefined],
      ["app", "gcp.project", undefined],
      ["api", "gcp.cloud_run", "app"],
      ["db", "gcp.cloud_sql", "app"],
    ]);
    expect(m.nodes[2].props).toEqual({ min_instances: 2, public: true });
    expect(m.nodes[3].label).toBe("");
    expect(m.edges).toEqual([
      { id: "users__api", from: "users", to: "api", label: "HTTPS", protocol: "https", routing: "curved" },
      { id: "api__db", from: "api", to: "db", dash: "dashed", protocol: "sql", color: "#1a73e8" },
      { id: "api__users", from: "api", to: "users", arrowStart: "arrow", arrowEnd: "diamond", dash: "dotted" },
    ]);
    expect(toCode(m)).toContain("api <.. users [end: diamond]");
  });

  it("writes and reads tabs, icons, notes and shapes", () => {
    const m: DiagramModel = {
      schemaVersion: 1,
      pages: [
        { id: "arch", name: "Architecture" },
        { id: "dr", name: "HA / DR" },
      ],
      nodes: [
        { id: "fn", kind: "generic.component", label: "Lambda", props: {}, icon: "aws:AWSLambda" },
        { id: "note", kind: "generic.note", label: 'Line one\nsays "hi"', props: {} },
        { id: "box", kind: "generic.shape", label: "", props: { shape: "cylinder", fill: "#ffffff", strokeWidth: 2 }, page: "dr" },
      ],
      edges: [],
      layout: {},
    };
    const code = toCode(m);
    expect(code).toContain('page dr "HA / DR" {');
    expect(code).toContain('fn "Lambda" [generic.component, icon: "aws:AWSLambda"]');
    expect(code).toContain('note "Line one\\nsays \\"hi\\"" [generic.note]');
    expect(canon(parse(code))).toEqual(canon(m));
  });

  it("keeps positions, line handles and label offsets from the canvas", () => {
    const base: DiagramModel = {
      ...SAMPLE_MODEL,
      layout: { users: { x: 10, y: 20 }, api: { x: 5, y: 6, r: 90 }, db: { x: 1, y: 2 } },
      edges: SAMPLE_MODEL.edges.map((e) => (e.id === "api__db" ? { ...e, fromHandle: "r" as const, labelDx: 12 } : e)),
    };
    const code = toCode(base).replace('api "API" [gcp.cloud_run, min_instances: 1]', 'api "API" [gcp.cloud_run, min_instances: 3]');
    const m = parse(code, base);
    expect(m.layout.users).toEqual({ x: 10, y: 20 });
    expect(m.layout.api).toEqual({ x: 5, y: 6, r: 90 });
    expect(m.nodes.find((n) => n.id === "api")!.props.min_instances).toBe(3);
    expect(m.edges.find((e) => e.id === "api__db")).toMatchObject({ fromHandle: "r", labelDx: 12 });
  });

  it("reports mistakes with line numbers and doesn't stop at the first one", () => {
    const r = parseCode(`api "API" [gcp.cloud_run]
Bad-Id [gcp.cloud_run]
db [gcp.nosuch]
api -> ghost
api => db
x "unterminated`);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.map((e) => e.line)).toEqual([2, 3, 4, 5, 6]);
    expect(r.errors[3].message).toBe('unexpected character "="');
    expect(r.errors[4].message).toContain("missing closing quote");
    const r2 = parseCode(`api "API" [gcp.cloud_run]
Bad [gcp.cloud_run]
db [gcp.nosuch]
api -> ghost
api => db
sub [gcp.subnet]`);
    if (r2.ok) throw new Error("expected errors");
    const lines = r2.errors.map((e) => e.line);
    expect(lines).toEqual([2, 3, 4, 5]);
    expect(r2.errors.find((e) => e.line === 4)!.message).toContain('no item called "ghost"');
  });

  it("rejects nesting the canvas wouldn't allow", () => {
    const r = parseCode(`p [gcp.project] {\n  r [gcp.region] {\n    p2 [gcp.project]\n  }\n}`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0].message).toContain("can't be inside");
  });

  it("makes diffs of diagrams read like a code review", () => {
    const after: DiagramModel = {
      ...SAMPLE_MODEL,
      nodes: [...SAMPLE_MODEL.nodes, { id: "cdn", kind: "generic.component", label: "CDN", props: {} }],
      edges: [...SAMPLE_MODEL.edges, { id: "users__cdn", from: "users", to: "cdn" }],
    };
    const diff = lineDiff(toCode(SAMPLE_MODEL), toCode(after));
    expect(diff.filter((l) => l.op === "add").map((l) => l.text)).toEqual(['cdn "CDN" [generic.component]', "users -> cdn"]);
    expect(diff.filter((l) => l.op === "del")).toEqual([]);
    expect(describeChanges(SAMPLE_MODEL, parse(toCode(after))).map((c) => c.change)).toEqual(["added", "added"]);
  });
});

describe("templates", () => {
  it("every template parses into a valid diagram", async () => {
    const { TEMPLATES, templateModel, validateModel } = await import("../src/index.js");
    for (const t of TEMPLATES) {
      const m = templateModel(t.id);
      expect(m.nodes.length, t.id).toBeGreaterThan(3);
      expect(validateModel(m).filter((i) => i.severity === "error"), t.id).toEqual([]);
    }
  });
});
