import { describe, expect, it } from "vitest";
import {
  compileTerraform,
  detectSource,
  generateWorkflows,
  importSource,
  parseSqlSchema,
  parseYaml,
  SAMPLE_MODEL,
  sequenceOf,
  sequenceSvg,
  toMermaidSequence,
  validateModel,
} from "../src/index.js";

const edges = (m: { edges: { from: string; to: string }[] }) => m.edges.map((e) => `${e.from}>${e.to}`).sort();
const valid = (m: Parameters<typeof validateModel>[0]) => expect(validateModel(m).filter((i) => i.severity === "error")).toEqual([]);

describe("YAML reader", () => {
  it("reads the parts of YAML config files use", () => {
    expect(
      parseYaml(`
# comment
name: web   # trailing comment
replicas: 3
on: true
ports: ["80:80", 443]
env: {A: "1", B: two}
list:
  - a
  - b: 1
    c: 2
  -
    d: x
nested:
  deeper:
    key: "quoted: value"
script: |
  line one
  line two
same_indent_list:
- x
- y
`),
    ).toEqual({
      name: "web",
      replicas: 3,
      on: true,
      ports: ["80:80", 443],
      env: { A: "1", B: "two" },
      list: ["a", { b: 1, c: 2 }, { d: "x" }],
      nested: { deeper: { key: "quoted: value" } },
      script: "line one\nline two\n",
      same_indent_list: ["x", "y"],
    });
  });
});

describe("Terraform import", () => {
  it("rebuilds the diagram from the Terraform Keelrail generates", () => {
    const tf = compileTerraform(SAMPLE_MODEL).files.map((f) => f.content).join("\n");
    expect(detectSource("main.tf", tf)).toBe("terraform");
    const m = importSource("main.tf", tf);
    valid(m);
    const kinds = m.nodes.map((n) => n.kind).sort();
    for (const k of ["gcp.cloud_run", "gcp.cloud_sql", "gcp.memorystore_redis", "gcp.gcs_bucket", "gcp.pubsub_topic", "gcp.secret", "gcp.vpc", "gcp.subnet"]) expect(kinds).toContain(k);
    // The database and cache sit in the VPC; the API talks to them.
    const id = (kind: string, label?: string) => m.nodes.find((n) => n.kind === kind && (!label || n.id.includes(label)))!.id;
    expect(m.nodes.find((n) => n.kind === "gcp.cloud_sql")!.parentId).toBe(id("gcp.vpc"));
    expect(edges(m)).toContain(`${id("gcp.cloud_run", "api")}>${id("gcp.cloud_sql")}`);
    expect(m.edges.find((e) => e.to === id("gcp.cloud_sql"))!.protocol).toBe("sql");
    // Pub/Sub push subscription: topic → worker
    expect(edges(m)).toContain(`${id("gcp.pubsub_topic")}>${id("gcp.cloud_run", "worker")}`);
  });

  it("draws AWS resources with their icons inside the VPC and subnets", () => {
    const m = importSource(
      "aws.tf",
      `
resource "aws_vpc" "main" { cidr_block = "10.0.0.0/16" }
resource "aws_subnet" "private" {
  vpc_id     = aws_vpc.main.id
  cidr_block = "10.0.1.0/24"
}
resource "aws_db_instance" "orders" {
  identifier           = "orders"
  db_subnet_group_name = aws_db_subnet_group.db.name
  subnet_id            = aws_subnet.private.id
}
resource "aws_lambda_function" "api" {
  function_name = "orders-api"
  environment { variables = { DB = aws_db_instance.orders.address } }
}
resource "aws_iam_role" "lambda" { name = "x" }
`,
    );
    valid(m);
    expect(m.nodes.map((n) => [n.id, n.kind, n.parentId, n.icon])).toEqual([
      ["main", "generic.group", undefined, "aws:VirtualprivatecloudVPC"],
      ["private", "generic.group", "main", "aws:Privatesubnet"],
      ["orders", "generic.component", "private", "aws:AmazonRDS"],
      ["api", "generic.component", undefined, "aws:AWSLambda"],
    ]);
    expect(m.nodes.find((n) => n.id === "api")!.label).toBe("orders-api");
    expect(edges(m)).toEqual(["api>orders"]);
  });
});

describe("Kubernetes import", () => {
  it("links ingress → service → deployment → config, secrets and volumes", () => {
    const yaml = `
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata: { name: shop, namespace: shop }
spec:
  rules:
    - host: shop.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: web
                port: { number: 80 }
---
apiVersion: v1
kind: Service
metadata:
  name: web
  namespace: shop
spec:
  selector:
    app: web
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
  namespace: shop
spec:
  template:
    metadata:
      labels:
        app: web
    spec:
      containers:
        - name: web
          image: shop/web:1.0
          envFrom:
            - configMapRef: { name: web-config }
          env:
            - name: DB_HOST
              value: postgres
            - name: API_KEY
              valueFrom:
                secretKeyRef: { name: api-keys, key: key }
---
apiVersion: v1
kind: Service
metadata: { name: postgres, namespace: shop }
spec: { selector: { app: postgres } }
---
apiVersion: apps/v1
kind: StatefulSet
metadata: { name: postgres, namespace: shop }
spec:
  template:
    metadata: { labels: { app: postgres } }
    spec:
      containers: [{ name: pg, image: postgres:16 }]
      volumes:
        - name: data
          persistentVolumeClaim: { claimName: pg-data }
---
apiVersion: v1
kind: ConfigMap
metadata: { name: web-config, namespace: shop }
---
apiVersion: v1
kind: Secret
metadata: { name: api-keys, namespace: shop }
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata: { name: pg-data, namespace: shop }
`;
    expect(detectSource("app.yaml", yaml)).toBe("kubernetes");
    const m = importSource("app.yaml", yaml);
    valid(m);
    expect(m.nodes[0]).toMatchObject({ kind: "generic.group", label: "namespace: shop" });
    expect(edges(m)).toEqual(["postgres>pg_data", "postgres_svc>postgres", "shop_ing>web_svc", "web>api_keys", "web>postgres_svc", "web>web_config", "web_svc>web"].sort());
  });
});

describe("docker-compose import", () => {
  it("draws services, their dependencies and named volumes", () => {
    const yaml = `
services:
  web:
    build: .
    ports: ["3000:3000"]
    environment:
      DATABASE_URL: postgres://app:secret@db:5432/app
      REDIS_URL: redis://cache:6379
    depends_on: [db]
  db:
    image: postgres:16
    volumes:
      - pgdata:/var/lib/postgresql/data
      - ./init.sql:/docker-entrypoint-initdb.d/init.sql
  cache:
    image: redis:7
volumes:
  pgdata:
`;
    expect(detectSource("docker-compose.yml", yaml)).toBe("compose");
    const m = importSource("docker-compose.yml", yaml);
    valid(m);
    expect(m.nodes.map((n) => [n.id, n.icon])).toEqual([
      ["web", "logos:docker"],
      ["db", "logos:postgresql"],
      ["cache", "logos:redis"],
      ["vol_pgdata", "lucide:hard-drive"],
    ]);
    expect(m.edges.map((e) => [e.from, e.to, e.protocol])).toEqual([
      ["web", "db", "sql"],
      ["web", "cache", "redis"],
      ["db", "vol_pgdata", "storage"],
    ]);
  });
});

describe("SQL import", () => {
  const ddl = `
-- shop schema
CREATE TABLE customers (
  id uuid PRIMARY KEY,
  email varchar(255) NOT NULL UNIQUE,
  name text
);
CREATE TABLE "orders" (
  id bigserial,
  customer_id uuid NOT NULL REFERENCES customers(id),
  placed_at timestamp with time zone DEFAULT now(),
  PRIMARY KEY (id)
);
CREATE TABLE order_lines (
  order_id bigint NOT NULL,
  sku text NOT NULL,
  qty int CHECK (qty > 0),
  PRIMARY KEY (order_id, sku),
  CONSTRAINT fk_order FOREIGN KEY (order_id) REFERENCES orders (id)
);
CREATE TABLE profiles (user_id uuid UNIQUE, bio text);
ALTER TABLE profiles ADD CONSTRAINT fk_user FOREIGN KEY (user_id) REFERENCES customers(id);
`;
  it("reads tables, keys and foreign keys", () => {
    const t = parseSqlSchema(ddl);
    expect(t.map((x) => x.name)).toEqual(["customers", "orders", "order_lines", "profiles"]);
    expect(t[1].columns.map((c) => [c.name, c.type, c.pk, c.notNull])).toEqual([
      ["id", "bigserial", true, false],
      ["customer_id", "uuid", false, true],
      ["placed_at", "timestamp with time zone", false, false],
    ]);
    expect(t[3].fks).toEqual([{ columns: ["user_id"], table: "customers", refColumns: ["id"] }]);
  });

  it("draws entities with crow's-foot lines", () => {
    const m = importSource("schema.sql", ddl);
    valid(m);
    expect(m.nodes[0]).toMatchObject({ id: "customers", kind: "generic.shape", props: { shape: "entity" } });
    expect(m.nodes[0].label).toBe("customers\nid: uuid PK\nemail: varchar(255) UQ\nname: text");
    const e = Object.fromEntries(m.edges.map((x) => [x.id, [x.arrowStart, x.arrowEnd, x.label]]));
    expect(e).toEqual({
      orders__customers: ["er-one-many", "er-one", "customer_id"],
      order_lines__orders: ["er-one-many", "er-one", "order_id"],
      profiles__customers: ["er-one", "er-zero-one", "user_id"],
    });
  });
});

describe("sequence diagrams", () => {
  it("turns a workflow into participants and messages, as SVG and Mermaid", () => {
    const w = generateWorkflows(SAMPLE_MODEL)[0];
    const seq = sequenceOf(SAMPLE_MODEL, w);
    expect(seq.participants[0]).toMatchObject({ id: "users", label: "Users" });
    expect(seq.messages.length).toBe(w.steps.length);
    const svg = sequenceSvg(seq);
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain("Public HTTPS LB");
    const mmd = toMermaidSequence(seq);
    expect(mmd).toContain("sequenceDiagram");
    expect(mmd).toContain("participant users as Users");
    expect(mmd).toMatch(/users->>lb: /);
  });
});
