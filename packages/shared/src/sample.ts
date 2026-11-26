import type { DiagramModel } from "./model.js";

/** The Milestone 1 reference architecture, used as a starter template and in tests. */
export const SAMPLE_MODEL: DiagramModel = {
  schemaVersion: 1,
  nodes: [
    { id: "users", kind: "generic.client", label: "Users", props: {} },
    { id: "prod", kind: "gcp.project", label: "Production", props: {} },
    { id: "lb", kind: "gcp.load_balancer", label: "Public HTTPS LB", parentId: "prod", props: { domain: "app.example.com" } },
    { id: "mumbai", kind: "gcp.region", label: "Mumbai", parentId: "prod", props: { region: "asia-south1" } },
    { id: "main_vpc", kind: "gcp.vpc", label: "main", parentId: "mumbai", props: {} },
    { id: "app_subnet", kind: "gcp.subnet", label: "app", parentId: "main_vpc", props: { cidr: "10.10.0.0/24" } },
    { id: "api", kind: "gcp.cloud_run", label: "API", parentId: "app_subnet", props: { min_instances: 1 } },
    { id: "worker", kind: "gcp.cloud_run", label: "Worker", parentId: "mumbai", props: {} },
    { id: "db", kind: "gcp.cloud_sql", label: "Postgres", parentId: "main_vpc", props: {} },
    { id: "cache", kind: "gcp.memorystore_redis", label: "Cache", parentId: "main_vpc", props: {} },
    { id: "uploads", kind: "gcp.gcs_bucket", label: "Uploads", parentId: "mumbai", props: {} },
    { id: "jobs", kind: "gcp.pubsub_topic", label: "Jobs", parentId: "prod", props: {} },
    { id: "api_key", kind: "gcp.secret", label: "Payment API key", parentId: "prod", props: {} },
  ],
  edges: [
    { id: "users__lb", from: "users", to: "lb", protocol: "https" },
    { id: "lb__api", from: "lb", to: "api", protocol: "https" },
    { id: "api__db", from: "api", to: "db", protocol: "sql" },
    { id: "api__cache", from: "api", to: "cache", protocol: "redis" },
    { id: "api__uploads", from: "api", to: "uploads", protocol: "storage" },
    { id: "api__jobs", from: "api", to: "jobs", label: "enqueue" },
    { id: "api__api_key", from: "api", to: "api_key", protocol: "secret" },
    { id: "jobs__worker", from: "jobs", to: "worker", label: "push" },
    { id: "worker__db", from: "worker", to: "db", protocol: "sql" },
    { id: "worker__uploads", from: "worker", to: "uploads", protocol: "storage" },
  ],
  layout: {},
};
