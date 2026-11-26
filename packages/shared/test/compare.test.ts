import { describe, expect, it } from "vitest";
import { applyOps, describeChanges, hunks, lineDiff, SAMPLE_MODEL, terraformDiff } from "../src/index.js";

const edited = () => {
  const r = applyOps(SAMPLE_MODEL, [
    { op: "update_node", id: "db", label: "Orders DB", props: { high_availability: true } },
    { op: "update_node", id: "jobs", parentId: "mumbai" },
    { op: "remove_node", id: "api_key" },
    { op: "add_node", id: "cdn_bucket", kind: "gcp.gcs_bucket", label: "Static", parentId: "mumbai" },
    { op: "connect", from: "lb", to: "worker", protocol: "https" },
  ]);
  if (!r.ok) throw new Error(r.error);
  return r.model;
};

describe("describeChanges", () => {
  it("lists added, removed and changed items with field-level detail", () => {
    const changes = describeChanges(SAMPLE_MODEL, edited());
    const db = changes.find((c) => c.id === "db")!;
    expect(db.change).toBe("changed");
    expect(db.fields).toEqual(
      expect.arrayContaining([
        { field: "name", from: "Postgres", to: "Orders DB" },
        { field: "High availability", from: "off", to: "on" },
      ]),
    );
    expect(changes.find((c) => c.id === "jobs")!.fields).toEqual([{ field: "inside", from: "Production", to: "Mumbai" }]);
    expect(changes.find((c) => c.id === "api_key")!.change).toBe("removed");
    expect(changes.find((c) => c.id === "api__api_key")).toMatchObject({ change: "removed", target: "connection" });
    expect(changes.find((c) => c.id === "cdn_bucket")).toMatchObject({ change: "added", detail: "Cloud Storage bucket" });
    expect(changes.find((c) => c.id === "lb__worker")).toMatchObject({ change: "added", detail: "Public HTTPS LB → Worker" });
  });

  it("is empty for identical models", () => {
    expect(describeChanges(SAMPLE_MODEL, structuredClone(SAMPLE_MODEL))).toEqual([]);
  });
});

describe("lineDiff", () => {
  it("finds minimal line changes with line numbers", () => {
    const d = lineDiff("a\nb\nc\nd\n", "a\nB\nc\nd\ne\n");
    expect(d.map((l) => `${l.op}:${l.text}`)).toEqual(["eq:a", "del:b", "add:B", "eq:c", "eq:d", "add:e"]);
    expect(d.find((l) => l.text === "e")!.b).toBe(5);
    expect(hunks(lineDiff("1\n2\n3\n4\n5\n6\n7\n8\n9\n", "1\n2\n3\n4\nX\n6\n7\n8\n9\n"), 1)[0].lines.map((l) => l.text)).toEqual([
      "4",
      "5",
      "X",
      "6",
    ]);
  });

  it("handles empty sides", () => {
    expect(lineDiff("", "x\n")).toEqual([{ op: "add", text: "x", b: 1 }]);
    expect(lineDiff("x", "")).toEqual([{ op: "del", text: "x", a: 1 }]);
  });
});

describe("terraformDiff", () => {
  it("reports resources that would be created and destroyed", () => {
    const d = terraformDiff(SAMPLE_MODEL, edited());
    expect(d.resourcesAdded).toContain("google_storage_bucket.cdn_bucket");
    expect(d.resourcesAdded).toContain("google_compute_backend_service.lb_worker");
    expect(d.resourcesRemoved).toContain("google_secret_manager_secret.api_key");
    expect(d.files.find((f) => f.path === "main.tf")!.status).toBe("changed");
    expect(d.files.find((f) => f.path === "versions.tf")!.status).toBe("unchanged");
  });
});
