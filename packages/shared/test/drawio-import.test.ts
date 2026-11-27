import { describe, expect, it } from "vitest";
import {
  compileTerraform,
  drawioToModel,
  generateWorkflows,
  readDrawio,
  SAMPLE_MODEL,
  toDrawio,
  toMermaid,
  validateModel,
} from "../src/index.js";

const page = (cells: string, name = "Page-1") =>
  `<mxfile><diagram id="p1" name="${name}"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>${cells}</root></mxGraphModel></diagram></mxfile>`;
const v = (id: string, value: string, style: string, x: number, y: number, w = 120, h = 60, parent = "1") =>
  `<mxCell id="${id}" value="${value}" style="${style}" vertex="1" parent="${parent}"><mxGeometry x="${x}" y="${y}" width="${w}" height="${h}" as="geometry"/></mxCell>`;
const e = (id: string, s: string, t: string, value = "") =>
  `<mxCell id="${id}" value="${value}" style="edgeStyle=orthogonalEdgeStyle;" edge="1" parent="1" source="${s}" target="${t}"><mxGeometry relative="1" as="geometry"/></mxCell>`;

async function compress(xml: string): Promise<string> {
  const stream = new Blob([encodeURIComponent(xml)]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  return btoa(String.fromCharCode(...bytes));
}

const byLabel = (r: ReturnType<typeof drawioToModel>, label: string) => r.model.nodes.find((n) => n.label === label);

describe("Keelrail round trip", () => {
  it("re-imports its own export exactly, so every artifact is identical", async () => {
    const pages = await readDrawio(toDrawio(SAMPLE_MODEL, "Sample"));
    const r = drawioToModel(pages[0]);
    expect(r.items.every((i) => i.confidence === "exact")).toBe(true);
    expect(r.model.nodes.map(({ id, kind, parentId, props }) => ({ id, kind, parentId, props }))).toEqual(
      SAMPLE_MODEL.nodes.map(({ id, kind, parentId, props }) => ({ id, kind, parentId, props })),
    );
    expect(r.model.edges).toEqual(SAMPLE_MODEL.edges);
    expect(r.layoutKept).toBe(true);
    expect(compileTerraform(r.model).files).toEqual(compileTerraform(SAMPLE_MODEL).files);
    expect(generateWorkflows(r.model)).toEqual(generateWorkflows(SAMPLE_MODEL));
  });
});

describe("file formats", () => {
  const xml = `<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>${v("a", "Orders API", "rounded=1;", 0, 0)}${v("b", "Orders DB", "shape=cylinder3;", 200, 0)}${e("e1", "a", "b")}</root></mxGraphModel>`;

  it("reads compressed pages", async () => {
    const file = `<mxfile><diagram id="x" name="Compressed">${await compress(xml)}</diagram></mxfile>`;
    const pages = await readDrawio(file);
    expect(pages[0].name).toBe("Compressed");
    const r = drawioToModel(pages[0]);
    expect(r.model.nodes.map((n) => n.kind)).toEqual(["gcp.cloud_run", "gcp.cloud_sql"]);
    expect(r.model.edges).toHaveLength(1);
  });

  it("reads .drawio.svg with the diagram embedded", async () => {
    const mxfile = `<mxfile><diagram name="Svg">${xml.replace(/^<mxGraphModel>/, "<mxGraphModel>")}</diagram></mxfile>`;
    const attr = mxfile.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const pages = await readDrawio(`<svg xmlns="http://www.w3.org/2000/svg" content="${attr}"><g/></svg>`);
    expect(drawioToModel(pages[0]).model.nodes).toHaveLength(2);
  });

  it("lists every page and rejects files that aren't draw.io", async () => {
    const two = `<mxfile><diagram name="One">${xml}</diagram><diagram name="Two">${xml}</diagram></mxfile>`;
    expect((await readDrawio(two)).map((p) => p.name)).toEqual(["One", "Two"]);
    await expect(readDrawio("hello")).rejects.toThrow(/draw.io/);
    await expect(readDrawio("<svg></svg>")).rejects.toThrow(/no embedded draw.io diagram/);
  });
});

describe("AWS diagram", () => {
  const aws = page(
    [
      v("cloud", "AWS Cloud", "shape=mxgraph.aws4.group;grIcon=mxgraph.aws4.group_aws_cloud;container=1;", 0, 0, 900, 600),
      v("vpc", "VPC", "shape=mxgraph.aws4.group;grIcon=mxgraph.aws4.group_vpc;container=1;", 40, 40, 800, 500, "cloud"),
      v("subnet", "Private subnet 10.0.1.0/24", "shape=mxgraph.aws4.group;grIcon=mxgraph.aws4.group_security_group;container=1;", 300, 60, 450, 380, "vpc"),
      v("alb", "ALB", "shape=mxgraph.aws4.resourceIcon;resIcon=mxgraph.aws4.application_load_balancer;", 40, 100, 60, 60, "vpc"),
      v("fn", "Orders function", "shape=mxgraph.aws4.resourceIcon;resIcon=mxgraph.aws4.lambda;", 40, 60, 60, 60, "subnet"),
      v("rds", "Orders DB", "shape=mxgraph.aws4.resourceIcon;resIcon=mxgraph.aws4.rds;", 250, 60, 60, 60, "subnet"),
      v("cache", "Sessions", "shape=mxgraph.aws4.resourceIcon;resIcon=mxgraph.aws4.elasticache;", 250, 220, 60, 60, "subnet"),
      v("s3", "Receipts", "shape=mxgraph.aws4.resourceIcon;resIcon=mxgraph.aws4.s3;", 40, 540, 60, 60, "cloud"),
      v("sqs", "Order events", "shape=mxgraph.aws4.resourceIcon;resIcon=mxgraph.aws4.sqs;", 200, 540, 60, 60, "cloud"),
      v("users", "Shoppers", "shape=mxgraph.aws4.users;", -200, 200, 60, 60),
      v("kinesis_like", "Fraud ML", "shape=mxgraph.aws4.resourceIcon;resIcon=mxgraph.aws4.sagemaker;", 400, 540, 60, 60, "cloud"),
      e("e1", "users", "alb", "HTTPS"),
      e("e2", "alb", "fn"),
      e("e3", "fn", "rds", "SQL"),
      e("e4", "fn", "cache"),
      e("e5", "fn", "s3"),
      e("e6", "fn", "sqs"),
      e("e7", "vpc", "s3"),
    ].join(""),
  );

  it("translates AWS services and groups to their GCP equivalents", async () => {
    const r = drawioToModel((await readDrawio(aws))[0]);
    const kinds = Object.fromEntries(r.model.nodes.map((n) => [n.label, n.kind]));
    expect(kinds).toMatchObject({
      "AWS Cloud": "gcp.project",
      VPC: "gcp.vpc",
      "Private subnet 10.0.1.0/24": "gcp.subnet",
      ALB: "gcp.load_balancer",
      "Orders function": "gcp.cloud_run",
      "Orders DB": "gcp.cloud_sql",
      Sessions: "gcp.memorystore_redis",
      Receipts: "gcp.gcs_bucket",
      "Order events": "gcp.pubsub_topic",
      Shoppers: "generic.client",
    });
    expect(r.items.find((i) => i.label === "Orders function")).toMatchObject({ confidence: "medium", reason: "AWS icon → Cloud Run service" });
    // No GCP equivalent: kept as a documentation-only component with its AWS icon.
    expect(r.items.find((i) => i.label === "Fraud ML")).toMatchObject({ kind: "generic.component", confidence: "low" });
    expect(byLabel(r, "Fraud ML")!.icon).toBe("aws~sagemaker");
    expect(byLabel(r, "Private subnet 10.0.1.0/24")!.props).toMatchObject({ cidr: "10.0.1.0/24", header: "tab" });
    // Nesting is kept where GCP allows it...
    expect(byLabel(r, "Orders function")!.parentId).toBe(byLabel(r, "Private subnet 10.0.1.0/24")!.id);
    // ...and a load balancer can't live in a VPC on GCP, so it moves up to the project.
    expect(byLabel(r, "ALB")!.parentId).toBe(byLabel(r, "AWS Cloud")!.id);
    expect(r.warnings.join("\n")).toMatch(/"ALB" can't go inside "VPC"/);
    // Connections, with protocols from labels; the one drawn from a group is reported.
    expect(r.model.edges).toHaveLength(6);
    expect(r.model.edges[0]).toMatchObject({ from: "shoppers", to: "alb", protocol: "https" });
    expect(r.warnings.join("\n")).toMatch(/attached to a group/);
    expect(r.layoutKept).toBe(false);
  });

  it("produces a valid model with Terraform and workflows", async () => {
    const r = drawioToModel((await readDrawio(aws))[0]);
    expect(validateModel(r.model).filter((i) => i.severity === "error")).toEqual([]);
    expect(compileTerraform(r.model).resources).toEqual(
      expect.arrayContaining(["google_cloud_run_v2_service.orders_function", "google_sql_database_instance.orders_db", "google_redis_instance.sessions"]),
    );
    expect(generateWorkflows(r.model).map((w) => w.title)).toEqual(["Request from Shoppers"]);
  });

  it("applies overrides: pick a type for an unknown shape, or skip one", async () => {
    const p = (await readDrawio(aws))[0];
    const r = drawioToModel(p, { kinds_like: null, kinesis_like: "gcp.cloud_run", s3: null });
    expect(byLabel(r, "Fraud ML")!.kind).toBe("gcp.cloud_run");
    expect(byLabel(r, "Receipts")).toBeUndefined();
    expect(r.model.edges.some((x) => x.to === "receipts")).toBe(false);
  });
});

describe("hand-drawn diagram with plain shapes", () => {
  const plain = page(
    [
      v("prod", "Production", "rounded=0;dashed=1;fillColor=none;", 0, 0, 700, 400),
      v("backend", "Backend", "rounded=1;fillColor=#f5f5f5;", 40, 40, 300, 300),
      v("api", "Orders &lt;b&gt;API&lt;/b&gt;", "rounded=1;whiteSpace=wrap;html=1;", 80, 120, 120, 60),
      v("db", "Orders DB", "shape=cylinder3;whiteSpace=wrap;", 400, 60, 80, 80),
      v("cache", "Session cache", "shape=cylinder3;", 400, 220, 80, 80),
      v("kafka", "Kafka events", "rounded=1;", 560, 140, 100, 60),
      v("cust", "Customer", "shape=umlActor;verticalLabelPosition=bottom;", -200, 150, 30, 60),
      v("note", "Note: draft for review", "text;html=1;", 0, 450, 200, 20),
      v("blob", "???", "ellipse;", 560, 300, 60, 60),
      e("e1", "cust", "api", "HTTPS"),
      e("e2", "api", "db"),
      e("e3", "api", "cache"),
      e("e4", "api", "kafka"),
    ].join(""),
  );

  it("uses shapes, labels and visual containment", async () => {
    const r = drawioToModel((await readDrawio(plain))[0]);
    const kinds = Object.fromEntries(r.model.nodes.map((n) => [n.label, n.kind]));
    expect(kinds).toEqual({
      "???": "generic.shape",
      Backend: "generic.group",
      Production: "gcp.project",
      "Orders API": "gcp.cloud_run",
      "Orders DB": "gcp.cloud_sql",
      "Session cache": "gcp.memorystore_redis",
      "Kafka events": "gcp.pubsub_topic",
      Customer: "generic.client",
    });
    // Shapes drawn inside the dashed "Production" box belong to it; "Backend" has no GCP meaning
    // and stays as a documentation-only group around the API.
    for (const l of ["Orders DB", "Session cache", "Kafka events", "Backend"]) expect(byLabel(r, l)!.parentId).toBe("production");
    expect(byLabel(r, "Orders API")!.parentId).toBe("backend");
    expect(r.items.find((i) => i.label === "Backend")).toMatchObject({ kind: "generic.group", container: true });
    expect(byLabel(r, "???")).toMatchObject({ kind: "generic.shape", props: { shape: "circle" } }); // 60×60 ellipse
    expect(r.items.some((i) => i.label.startsWith("Note"))).toBe(false);
    expect(r.model.edges.map((x) => `${x.from}>${x.to}`)).toEqual(["customer>orders_api", "orders_api>orders_db", "orders_api>session_cache", "orders_api>kafka_events"]);
    expect(generateWorkflows(r.model)[0].summary).toBe("Customer → Orders API, using Orders DB and Session cache, and hands work off to Kafka events.");
  });
});

describe("flowcharts", () => {
  const flow = page(
    [
      v("start", "Start", "rounded=1;arcSize=50;whiteSpace=wrap;", 0, 0, 120, 40),
      v("order", "Process order", "rounded=0;whiteSpace=wrap;fillColor=#dae8fc;strokeColor=#6c8ebf;", 0, 80, 140, 60),
      v("ok", "In stock?", "rhombus;whiteSpace=wrap;", 0, 180, 140, 90),
      v("db", "Orders", "shape=cylinder3;whiteSpace=wrap;", 220, 80, 80, 80),
      v("ship", "Ship it", "shape=parallelogram;whiteSpace=wrap;", 0, 320, 140, 60),
      `<mxCell id="e1" value="" style="endArrow=block;endFill=1;html=1;" edge="1" parent="1" source="start" target="order"><mxGeometry relative="1" as="geometry"/></mxCell>`,
      `<mxCell id="e2" value="" style="edgeStyle=orthogonalEdgeStyle;dashed=1;endArrow=open;html=1;" edge="1" parent="1" source="order" target="db"><mxGeometry relative="1" as="geometry"/></mxCell>`,
      `<mxCell id="e3" value="yes" style="edgeStyle=orthogonalEdgeStyle;endArrow=block;endFill=0;startArrow=diamond;startFill=0;html=1;" edge="1" parent="1" source="ok" target="ship"><mxGeometry relative="1" as="geometry"/></mxCell>`,
    ].join(""),
  );

  it("keeps flowchart shapes as shapes, not cloud resources", async () => {
    const r = drawioToModel((await readDrawio(flow))[0]);
    const shape = (label: string) => r.model.nodes.find((n) => n.label === label);
    expect(r.model.nodes.every((n) => n.kind === "generic.shape")).toBe(true);
    expect(shape("Start")!.props.shape).toBe("terminator");
    expect(shape("Process order")!.props).toEqual({ shape: "rectangle", fill: "#dae8fc", stroke: "#6c8ebf" });
    expect(shape("In stock?")!.props.shape).toBe("diamond");
    expect(shape("Orders")!.props.shape).toBe("cylinder");
    expect(shape("Ship it")!.props.shape).toBe("parallelogram");
  });

  it("imports line styles and arrowheads", async () => {
    const r = drawioToModel((await readDrawio(flow))[0]);
    const [e1, e2, e3] = r.model.edges;
    expect(e1).toMatchObject({ routing: "straight" });
    expect(e1.arrowEnd).toBeUndefined();
    expect(e2).toMatchObject({ dash: "dashed", arrowEnd: "open" });
    expect(e3).toMatchObject({ label: "yes", arrowEnd: "triangle", arrowStart: "odiamond" });
  });

  it("round-trips shapes and styles through draw.io, and exports Mermaid flowchart syntax", async () => {
    const r = drawioToModel((await readDrawio(flow))[0]);
    const again = drawioToModel((await readDrawio(toDrawio(r.model, "Flow")))[0]);
    expect(again.model.nodes.map(({ id, kind, props, label }) => ({ id, kind, props, label }))).toEqual(
      r.model.nodes.map(({ id, kind, props, label }) => ({ id, kind, props, label })),
    );
    expect(again.model.edges).toEqual(r.model.edges);
    const mmd = toMermaid(r.model);
    expect(mmd).toContain('in_stock{"In stock?"}');
    expect(mmd).toContain('ship_it[/"Ship it"/]');
    expect(mmd).toContain("process_order -.-> orders");
  });
});

describe("styled group boxes", () => {
  const grp = (icon: string, extra: string) =>
    `points=[];outlineConnect=0;gradientColor=none;html=1;whiteSpace=wrap;fontSize=12;fontStyle=0;container=1;pointerEvents=0;collapsible=0;recursiveResize=0;shape=mxgraph.aws4.group;grIcon=mxgraph.aws4.${icon};verticalAlign=top;align=left;spacingLeft=30;${extra}`;
  const aws = page(
    v("region", "Region", grp("group_region", "strokeColor=#147EBA;fillColor=none;fontColor=#147EBA;dashed=0;"), 0, 0, 900, 700) +
      v("vpc", "VPC", grp("group_vpc", "strokeColor=#248814;fillColor=none;fontColor=#AAB7B8;dashed=0;"), 40, 60, 800, 600, "region") +
      v("az", "Availability Zone A", "fillColor=none;strokeColor=#147EBA;dashed=1;verticalAlign=top;fontStyle=0;fontColor=#147EBA;whiteSpace=wrap;html=1;align=center;container=1;", 40, 60, 360, 500, "vpc") +
      v("pub", "Public subnet", grp("group_security_group", "strokeColor=none;fillColor=#E9F3E6;fontColor=#248814;dashed=0;"), 20, 40, 300, 180, "az") +
      v("priv", "Private subnet", grp("group_security_group", "strokeColor=none;fillColor=#E6F2F8;fontColor=#147EBA;dashed=0;"), 20, 260, 300, 180, "az") +
      v("team", "Payments team", "rounded=0;whiteSpace=wrap;html=1;container=1;dashed=1;dashPattern=1 3;strokeWidth=3;strokeColor=#DD344C;fillColor=none;", 950, 0, 300, 200),
  );

  it("keeps each box's border, thickness, colours, title and AWS icon", async () => {
    const r = drawioToModel((await readDrawio(aws))[0]);
    const look = (label: string) => {
      const n = byLabel(r, label)!;
      return { icon: n.icon, ...n.props };
    };
    expect(look("Region")).toMatchObject({ icon: "aws:Region", color: "#147eba", border: "solid", header: "tab", fill: "none" });
    expect(look("VPC")).toMatchObject({ icon: "aws:VirtualprivatecloudVPC", color: "#248814", border: "solid", header: "tab" });
    expect(look("Availability Zone A")).toMatchObject({ border: "dashed", header: "center", color: "#147eba" });
    expect(look("Public subnet")).toMatchObject({ icon: "aws:Publicsubnet", border: "none", fill: "#e9f3e6", header: "tab" });
    expect(look("Private subnet")).toMatchObject({ icon: "aws:Privatesubnet", fill: "#e6f2f8" });
    expect(look("Payments team")).toMatchObject({ border: "dotted", borderWidth: "3", color: "#dd344c", header: "label" });
  });

  it("round-trips group styles through draw.io, using AWS group shapes", async () => {
    const r = drawioToModel((await readDrawio(aws))[0]);
    const xml = toDrawio(r.model, "AWS");
    expect(xml).toContain("grIcon=mxgraph.aws4.group_region");
    expect(xml).toContain("dashPattern=1 3");
    const again = drawioToModel((await readDrawio(xml))[0]);
    const strip = (m: typeof r.model) => m.nodes.map(({ kind, label, props, icon }) => ({ kind, label, props, icon }));
    expect(strip(again.model)).toEqual(strip(r.model));
  });
});

describe("General, ER and UML shapes", () => {
  it("round-trips new shapes, line styles and crow's-foot ends through draw.io", async () => {
    const shape = (id: string, s: string, label: string, extra: Record<string, unknown> = {}) => ({ id, kind: "generic.shape", label, props: { shape: s, ...extra } });
    const model = {
      nodes: [
        shape("customer", "entity", "Customer\nid: uuid PK\nname: text"),
        shape("orders", "entity", "Order\nid: uuid PK"),
        shape("order_class", "class", "Order\n+ id: string\n--\n+ place(): void"),
        shape("cube", "cube", "Cache", { lineStyle: "dashed", strokeWidth: "3", shadow: true }),
        shape("bubble", "callout-round", "Hi"),
      ],
      edges: [{ id: "customer__orders", from: "customer", to: "orders", arrowStart: "er-one" as const, arrowEnd: "er-zero-many" as const }],
      layout: {
        customer: { x: 0, y: 0, w: 170, h: 120 },
        orders: { x: 300, y: 0, w: 170, h: 120 },
        order_class: { x: 0, y: 200, w: 180, h: 140 },
        cube: { x: 300, y: 200, w: 120, h: 90 },
        bubble: { x: 500, y: 200, w: 150, h: 90 },
      },
    };
    const xml = toDrawio(model as never, "Shapes");
    expect(xml).toContain("endArrow=ERzeroToMany");
    expect(xml).toContain("shape=cube");
    const again = drawioToModel((await readDrawio(xml))[0]);
    expect(again.model.nodes.map(({ id, props, label }) => ({ id, props, label }))).toEqual(model.nodes.map(({ id, props, label }) => ({ id, props, label })));
    expect(again.model.edges[0]).toMatchObject({ arrowStart: "er-one", arrowEnd: "er-zero-many" });
  });

  it("reads draw.io's own UML and ER shapes", async () => {
    const r = drawioToModel(
      (
        await readDrawio(
          page(
            v("a", "User", "shape=umlActor;verticalLabelPosition=bottom;", 0, 0, 30, 60) +
              v("b", "Box", "shape=cube;whiteSpace=wrap;", 100, 0, 120, 80) +
              v("c", "Svc", "shape=component;align=left;", 300, 0, 120, 60) +
              v("d", "Start", "rhombus;", 500, 0, 80, 80) +
              `<mxCell id="e1" style="edgeStyle=entityRelationEdgeStyle;endArrow=ERmany;startArrow=ERmandOne;" edge="1" parent="1" source="b" target="c"><mxGeometry relative="1" as="geometry"/></mxCell>`,
          ),
        )
      )[0],
    );
    expect(byLabel(r, "Box")).toMatchObject({ kind: "generic.shape", props: { shape: "cube" } });
    expect(byLabel(r, "Svc")).toMatchObject({ kind: "generic.shape", props: { shape: "component" } });
    expect(r.model.edges[0]).toMatchObject({ arrowStart: "er-one", arrowEnd: "er-many" });
  });
});
