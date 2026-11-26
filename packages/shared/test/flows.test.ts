import { describe, expect, it } from "vitest";
import { applyOps, describeIntegrations, emptyModel, generateWorkflows, SAMPLE_MODEL, toArchitectureDoc } from "../src/index.js";

describe("workflows", () => {
  const flows = generateWorkflows(SAMPLE_MODEL);

  it("splits the sample into a request flow and an async flow at the Pub/Sub boundary", () => {
    expect(flows.map((f) => [f.id, f.mode])).toEqual([
      ["request:users", "sync"],
      ["async:jobs", "async"],
    ]);
    expect(flows[0].steps.map((s) => s.edgeId)).toEqual([
      "users__lb",
      "lb__api",
      "api__db",
      "api__cache",
      "api__uploads",
      "api__jobs",
      "api__api_key",
    ]);
    expect(flows[1].steps.map((s) => s.edgeId)).toEqual(["jobs__worker", "worker__db", "worker__uploads"]);
    expect(flows[0].summary).toBe("Users → Public HTTPS LB → API, using Postgres, Cache, Uploads and Payment API key, and hands work off to Jobs.");
  });

  it("covers every connection exactly once", () => {
    const ids = flows.flatMap((f) => f.steps.map((s) => s.edgeId));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.sort()).toEqual(SAMPLE_MODEL.edges.map((e) => e.id).sort());
  });

  it("starts from uncalled services when there are no users in the diagram", () => {
    const r = applyOps(emptyModel(), [
      { op: "add_node", id: "cron", kind: "gcp.cloud_run", label: "Nightly job" },
      { op: "add_node", id: "db", kind: "gcp.cloud_sql", label: "DB" },
      { op: "connect", from: "cron", to: "db" },
    ]);
    if (!r.ok) throw new Error(r.error);
    expect(generateWorkflows(r.model).map((f) => f.title)).toEqual(["Request from Nightly job"]);
  });
});

describe("integrations", () => {
  const byId = new Map(describeIntegrations(SAMPLE_MODEL).map((i) => [i.edgeId, i]));

  it("explains each connection consistently with the generated Terraform", () => {
    const sql = byId.get("api__db")!;
    expect(sql.pattern).toBe("Cloud Run service → Cloud SQL");
    expect(sql.howItWorks.join(" ")).toMatch(/IAM database authentication/);
    expect(sql.howItWorks.join(" ")).toMatch(/private IP in main/);
    expect(sql.terraform).toEqual(
      expect.arrayContaining(["google_project_iam_member.api_db_client", "google_project_iam_member.api_db_instance_user", "google_sql_user.api_db"]),
    );
    expect(byId.get("jobs__worker")).toMatchObject({ mode: "async", terraform: expect.arrayContaining(["google_pubsub_subscription.jobs_to_worker"]) });
    expect(byId.get("lb__api")!.terraform).toEqual(
      expect.arrayContaining(["google_compute_region_network_endpoint_group.lb_api", "google_compute_backend_service.lb_api"]),
    );
    expect(byId.get("api__cache")!.mapped).toBe(true);
    expect(byId.get("users__lb")!.summary).toBe("Users send HTTPS requests to Public HTTPS LB at app.example.com.");
  });

  it("flags connections that are documentation only", () => {
    const r = applyOps(SAMPLE_MODEL, [{ op: "connect", from: "worker", to: "lb" }]);
    if (!r.ok) throw new Error(r.error);
    expect(describeIntegrations(r.model).find((i) => i.edgeId === "worker__lb")).toMatchObject({ mapped: false });
  });
});

describe("architecture doc", () => {
  it("includes every section", () => {
    const md = toArchitectureDoc(SAMPLE_MODEL, "Sample");
    for (const h of ["# Sample", "## Diagram", "```mermaid", "## Components", "## Workflows", "### Request from Users", "## How each integration works", "## Review", "## Deployment"])
      expect(md).toContain(h);
    expect(md).toContain("1. **Users → Public HTTPS LB**");
  });
});
