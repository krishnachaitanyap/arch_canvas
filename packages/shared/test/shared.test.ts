import { describe, expect, it } from "vitest";
import {
  applyOp,
  applyOps,
  compileTerraform,
  diffModels,
  emptyModel,
  SAMPLE_MODEL,
  toDrawio,
  toMermaid,
  toPlantUml,
  validateModel,
} from "../src/index.js";

describe("ops", () => {
  it("builds a model and enforces catalog nesting rules", () => {
    const r = applyOps(emptyModel(), [
      { op: "add_node", id: "p", kind: "gcp.project", label: "Prod" },
      { op: "add_node", id: "net", kind: "gcp.vpc", label: "net", parentId: "p" },
      { op: "add_node", id: "sn", kind: "gcp.subnet", label: "sn", parentId: "net" },
      { op: "add_node", id: "api", kind: "gcp.cloud_run", label: "API", parentId: "sn" },
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const bad = applyOp(r.model, { op: "add_node", id: "sn2", kind: "gcp.subnet", label: "x", parentId: "p" });
    expect(bad).toMatchObject({ ok: false });
    expect(!bad.ok && bad.error).toMatch(/cannot be placed inside GCP project/);
  });

  it("lets documentation groups wrap anything and edits connections in place", () => {
    const r = applyOps(emptyModel(), [
      { op: "add_node", id: "org", kind: "generic.group", label: "Acme org" },
      { op: "add_node", id: "p", kind: "gcp.project", label: "Prod", parentId: "org" },
      { op: "add_node", id: "api", kind: "gcp.cloud_run", label: "API", parentId: "p" },
      { op: "add_node", id: "db", kind: "gcp.cloud_sql", label: "DB", parentId: "p" },
      { op: "connect", from: "api", to: "db", protocol: "sql" },
      { op: "update_edge", from: "api", to: "db", label: "reads", routing: "curved", protocol: null },
    ]);
    if (!r.ok) throw new Error(r.error);
    expect(r.model.edges[0]).toEqual({ id: "api__db", from: "api", to: "db", label: "reads", routing: "curved" });
    expect(compileTerraform(r.model).resources).toContain("google_cloud_run_v2_service.api");
  });

  it("rejects bad ids, unknown kinds, bad props and duplicate edges", () => {
    const m = emptyModel();
    expect(applyOp(m, { op: "add_node", id: "Bad-Id", kind: "gcp.cloud_run", label: "x" }).ok).toBe(false);
    expect(applyOp(m, { op: "add_node", id: "x", kind: "aws.lambda", label: "x" }).ok).toBe(false);
    expect(applyOp(m, { op: "add_node", id: "x", kind: "gcp.cloud_run", label: "x", props: { cpu: "3" } }).ok).toBe(false);
    const r = applyOps(m, [
      { op: "add_node", id: "a", kind: "gcp.cloud_run", label: "a" },
      { op: "add_node", id: "b", kind: "gcp.cloud_sql", label: "b" },
      { op: "connect", from: "a", to: "b" },
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(applyOp(r.model, { op: "connect", from: "a", to: "b" }).ok).toBe(false);
  });

  it("removing a group keeps its children and drops its edges", () => {
    const r = applyOp(SAMPLE_MODEL, { op: "remove_node", id: "app_subnet" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.model.nodes.find((n) => n.id === "api")?.parentId).toBe("main_vpc");
    const d = diffModels(SAMPLE_MODEL, r.model);
    expect(d.removedNodes).toEqual(["app_subnet"]);
    expect(d.changedNodes).toEqual(["api"]);
  });
});

describe("terraform", () => {
  const out = compileTerraform(SAMPLE_MODEL);
  const main = out.files.find((f) => f.path === "main.tf")!.content;

  it("emits the expected files", () => {
    expect(out.files.map((f) => f.path)).toEqual(["versions.tf", "providers.tf", "variables.tf", "main.tf", "outputs.tf"]);
  });

  it("maps nodes and edges to google resources", () => {
    for (const addr of [
      "google_cloud_run_v2_service.api",
      "google_cloud_run_v2_service.worker",
      "google_sql_database_instance.db",
      "google_sql_user.api_db",
      "google_compute_network.main_vpc",
      "google_service_networking_connection.main_vpc_psa",
      "google_redis_instance.cache",
      "google_storage_bucket.uploads",
      "google_pubsub_subscription.jobs_to_worker",
      "google_compute_region_network_endpoint_group.lb_api",
      "google_compute_managed_ssl_certificate.lb",
      "google_compute_security_policy.lb",
      "google_secret_manager_secret_iam_member.api_api_key",
    ])
      expect(out.resources).toContain(addr);
    expect(main).toContain('ingress  = "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER"');
    expect(main).toContain('location = "asia-south1"');
    expect(main).toContain("cloudsql.iam_authentication");
    expect(main).toContain("google_compute_subnetwork.app_subnet.id");
  });

  it("produces balanced braces and is deterministic", () => {
    for (const f of out.files) {
      expect(f.content.split("{").length).toBe(f.content.split("}").length);
      expect(f.content.split("[").length).toBe(f.content.split("]").length);
    }
    expect(compileTerraform(SAMPLE_MODEL)).toEqual(out);
  });

  it("warns instead of guessing", () => {
    const r = applyOps(emptyModel(), [
      { op: "add_node", id: "api", kind: "gcp.cloud_run", label: "API" },
      { op: "add_node", id: "cache", kind: "gcp.memorystore_redis", label: "Cache" },
      { op: "connect", from: "api", to: "cache" },
    ]);
    if (!r.ok) throw new Error(r.error);
    const msgs = compileTerraform(r.model).warnings.map((w) => w.message).join("\n");
    expect(msgs).toMatch(/not inside a subnet/);
    expect(msgs).toMatch(/default network/);
  });
});

describe("validate and export", () => {
  it("has no errors on the sample", () => {
    expect(validateModel(SAMPLE_MODEL).filter((i) => i.severity === "error")).toEqual([]);
  });

  it("exports draw.io, Mermaid and PlantUML", () => {
    const xml = toDrawio(SAMPLE_MODEL, "Sample");
    expect(xml).toContain("<mxfile");
    expect(xml).toContain('source="n_api" target="n_db"');
    expect(xml).toContain('parent="n_app_subnet"');
    // Parents are written before their children.
    expect(xml.indexOf('id="n_app_subnet"')).toBeLessThan(xml.indexOf('id="n_api"'));
    expect(toMermaid(SAMPLE_MODEL)).toMatch(/subgraph main_vpc/);
    expect(toPlantUml(SAMPLE_MODEL)).toMatch(/database "Postgres" as db/);
  });
});
