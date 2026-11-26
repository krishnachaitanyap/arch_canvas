/**
 * Resource catalog: one definition per diagram node kind. It drives the editor palette and
 * properties form, the agent's knowledge of what it can draw, validation rules, and the
 * Terraform compiler (see terraform.ts for the per-kind mappings).
 */
export type PropType = "string" | "number" | "boolean" | "enum" | "color";

export interface PropSpec {
  key: string;
  label: string;
  type: PropType;
  default: string | number | boolean;
  options?: string[];
  description?: string;
}

export type Category = "External" | "Groups" | "Compute" | "Data" | "Messaging" | "Networking" | "Security" | "DevOps" | "Other";

export interface CatalogEntry {
  kind: string;
  label: string;
  category: Category;
  description: string;
  /** Groups can contain other nodes. */
  container?: boolean;
  /** Kinds allowed as a parent. Top level is always allowed. */
  parents: string[];
  icon: { abbr: string; color: string };
  props: PropSpec[];
}

const REGIONS = [
  "us-central1",
  "us-east1",
  "us-west1",
  "europe-west1",
  "europe-west2",
  "asia-south1",
  "asia-southeast1",
  "asia-northeast1",
  "australia-southeast1",
];

const IN_PROJECT = ["gcp.project", "gcp.region"];
const IN_NETWORK = ["gcp.project", "gcp.region", "gcp.vpc", "gcp.subnet"];

const C = {
  external: "#5f6368",
  group: "#80868b",
  compute: "#4285f4",
  data: "#1e8e3e",
  messaging: "#f29900",
  network: "#a142f4",
  security: "#d93025",
  devops: "#12b5cb",
};

/** How a group's box is drawn: border pattern, thickness, colours and its title. */
export const BORDER_STYLES = ["solid", "dashed", "dotted", "none"] as const;
export const BORDER_WIDTHS = ["1", "1.5", "2", "3", "4"] as const;
/** tab: icon in a coloured corner tab (AWS style) · icon: icon and title · label: title only · center: centred title. */
export const GROUP_HEADERS = ["tab", "icon", "label", "center"] as const;
export type GroupStyle = { color: string; border: (typeof BORDER_STYLES)[number]; borderWidth: (typeof BORDER_WIDTHS)[number]; fill: string; header: (typeof GROUP_HEADERS)[number] };
export const GROUP_STYLE_KEYS = ["color", "border", "borderWidth", "fill", "header"] as const;

function groupStyleProps(d: Partial<GroupStyle> & { color: string }): PropSpec[] {
  return [
    { key: "color", label: "Colour", type: "color", default: d.color, description: "Border and title colour" },
    { key: "border", label: "Border", type: "enum", default: d.border ?? "dashed", options: [...BORDER_STYLES] },
    { key: "borderWidth", label: "Thickness", type: "enum", default: d.borderWidth ?? "1.5", options: [...BORDER_WIDTHS] },
    { key: "fill", label: "Fill", type: "color", default: d.fill ?? "none", description: "Background colour, or none" },
    { key: "header", label: "Title", type: "enum", default: d.header ?? "icon", options: [...GROUP_HEADERS] },
  ];
}

/** Fonts for shape and text labels (the web app maps them to font stacks). */
export const FONTS = ["Sans", "Helvetica", "Arial", "Verdana", "Georgia", "Times New Roman", "Courier New", "Comic Sans MS", "Handwritten"] as const;
export const FONT_SIZES = ["10", "11", "12", "13", "14", "16", "18", "20", "24", "28", "32", "40", "48"] as const;

/** Shapes for flowcharts and general diagrams (generic.shape's `shape` property). */
export const SHAPES = [
  "rectangle",
  "rounded",
  "terminator",
  "ellipse",
  "circle",
  "diamond",
  "parallelogram",
  "hexagon",
  "document",
  "cylinder",
  "predefined",
  "manual-input",
  "triangle",
  "cloud",
  "text",
  // Arrows and lines (draw.io's "Arrows" palette)
  "arrow-right",
  "arrow-left",
  "arrow-up",
  "arrow-down",
  "arrow-left-right",
  "arrow-up-down",
  "chevron",
  "thin-arrow-right",
  "thin-arrow-left",
  "thin-arrow-up",
  "thin-arrow-down",
  "line",
  "vline",
  "square",
  "heading",
  "internal-storage",
  "cube",
  "trapezoid",
  "tape",
  "page",
  "card",
  "callout",
  "callout-round",
  "actor",
  "delay",
  "data-storage",
  "container",
  "list",
  "curve-arrow",
  "diag-arrow-block",
  "diag-double-block",
  "diag-line",
  "diag-arrow",
  "diag-double-arrow",
  "entity",
  "weak-entity",
  "class",
  "package",
  "component",
  "lifeline",
  "activation",
  "frame",
  "initial",
  "final",
  "fork",
] as const;
/** The arrow and line shapes, listed in their own palette section. */
export const ARROW_SHAPES: ShapeName[] = ["curve-arrow", "diag-arrow", "diag-double-arrow", "diag-line", "diag-arrow-block", "diag-double-block", "arrow-right", "arrow-left", "arrow-up", "arrow-down", "arrow-left-right", "arrow-up-down", "chevron", "thin-arrow-right", "thin-arrow-left", "thin-arrow-up", "thin-arrow-down", "line", "vline"];
export type ShapeName = (typeof SHAPES)[number];

/** Flowchart meaning of each shape, for the palette and tooltips. */
export const SHAPE_LABELS: Record<ShapeName, { title: string; label: string; size: [number, number] }> = {
  rectangle: { title: "Process", label: "Process", size: [160, 70] },
  rounded: { title: "Rounded rectangle", label: "Step", size: [160, 70] },
  terminator: { title: "Start / end", label: "Start", size: [150, 56] },
  ellipse: { title: "Ellipse", label: "Event", size: [150, 80] },
  circle: { title: "Connector", label: "A", size: [64, 64] },
  diamond: { title: "Decision", label: "Decision?", size: [150, 100] },
  parallelogram: { title: "Input / output", label: "Input", size: [170, 70] },
  hexagon: { title: "Preparation", label: "Prepare", size: [160, 70] },
  document: { title: "Document", label: "Report", size: [150, 80] },
  cylinder: { title: "Database", label: "Data store", size: [120, 90] },
  predefined: { title: "Predefined process", label: "Subroutine", size: [170, 70] },
  "manual-input": { title: "Manual input", label: "Enter data", size: [160, 70] },
  triangle: { title: "Triangle", label: "", size: [100, 90] },
  cloud: { title: "Cloud", label: "Cloud", size: [170, 100] },
  text: { title: "Text", label: "Text", size: [160, 40] },
  "arrow-right": { title: "Arrow right", label: "", size: [140, 70] },
  "arrow-left": { title: "Arrow left", label: "", size: [140, 70] },
  "arrow-up": { title: "Arrow up", label: "", size: [70, 140] },
  "arrow-down": { title: "Arrow down", label: "", size: [70, 140] },
  "arrow-left-right": { title: "Two-way arrow", label: "", size: [160, 70] },
  "arrow-up-down": { title: "Two-way arrow (vertical)", label: "", size: [70, 160] },
  chevron: { title: "Chevron / step", label: "Step", size: [150, 70] },
  "thin-arrow-right": { title: "Thin arrow right", label: "", size: [160, 24] },
  "thin-arrow-left": { title: "Thin arrow left", label: "", size: [160, 24] },
  "thin-arrow-up": { title: "Thin arrow up", label: "", size: [24, 160] },
  "thin-arrow-down": { title: "Thin arrow down", label: "", size: [24, 160] },
  line: { title: "Line", label: "", size: [160, 12] },
  vline: { title: "Vertical line", label: "", size: [12, 160] },
  "square": { title: "Square", label: "", size: [80, 80] },
  "heading": { title: "Heading and text", label: "Heading\nWrite a paragraph of text here. It wraps to the box.", size: [200, 110] },
  "internal-storage": { title: "Internal storage", label: "", size: [100, 100] },
  "cube": { title: "Cube", label: "", size: [120, 90] },
  "trapezoid": { title: "Trapezoid", label: "", size: [140, 70] },
  "tape": { title: "Tape", label: "", size: [140, 80] },
  "page": { title: "Page / note", label: "", size: [90, 110] },
  "card": { title: "Card", label: "", size: [90, 110] },
  "callout": { title: "Callout", label: "", size: [150, 90] },
  "callout-round": { title: "Speech bubble", label: "", size: [150, 90] },
  "actor": { title: "Actor", label: "Actor", size: [40, 70] },
  "delay": { title: "Delay", label: "", size: [90, 80] },
  "data-storage": { title: "Stored data", label: "", size: [120, 80] },
  "container": { title: "Container", label: "Container", size: [200, 150] },
  "list": { title: "List", label: "List\nItem 1\nItem 2\nItem 3", size: [150, 120] },
  "curve-arrow": { title: "Curved arrow", label: "", size: [100, 90] },
  "diag-arrow-block": { title: "Diagonal block arrow", label: "", size: [90, 90] },
  "diag-double-block": { title: "Diagonal two-way block arrow", label: "", size: [90, 90] },
  "diag-line": { title: "Diagonal line", label: "", size: [90, 90] },
  "diag-arrow": { title: "Diagonal arrow", label: "", size: [90, 90] },
  "diag-double-arrow": { title: "Diagonal two-way arrow", label: "", size: [90, 90] },
  "entity": { title: "Entity (table)", label: "Customer\nid: uuid PK\nname: text\nemail: text", size: [170, 120] },
  "weak-entity": { title: "Weak entity", label: "Order line", size: [150, 60] },
  "class": { title: "Class", label: "Order\n+ id: string\n+ total: number\n--\n+ place(): void\n+ cancel(): void", size: [180, 140] },
  "package": { title: "Package", label: "package", size: [160, 110] },
  "component": { title: "Component", label: "Component", size: [160, 80] },
  "lifeline": { title: "Lifeline", label: "Object", size: [100, 260] },
  "activation": { title: "Activation bar", label: "", size: [14, 110] },
  "frame": { title: "Frame (fragment)", label: "alt", size: [260, 170] },
  "initial": { title: "Initial state", label: "", size: [30, 30] },
  "final": { title: "Final state", label: "", size: [34, 34] },
  "fork": { title: "Fork / join bar", label: "", size: [150, 10] },
};

/** Palette sections, as in draw.io (a shape may appear in several). */
export const SHAPE_SECTIONS: Record<"general" | "flowchart" | "er" | "uml", ShapeName[]> = {
  general: ["rectangle", "rounded", "text", "heading", "ellipse", "square", "circle", "predefined", "diamond", "parallelogram", "hexagon", "triangle", "cylinder", "cloud", "document", "internal-storage", "cube", "chevron", "trapezoid", "tape", "page", "card", "callout", "callout-round", "actor", "delay", "data-storage", "container", "list"],
  flowchart: ["rectangle", "rounded", "terminator", "diamond", "parallelogram", "predefined", "document", "cylinder", "manual-input", "hexagon", "circle", "delay", "data-storage", "internal-storage", "card", "triangle", "ellipse"],
  er: ["entity", "weak-entity"],
  uml: ["class", "package", "component", "actor", "lifeline", "activation", "frame", "page", "initial", "final", "fork"],
};
/** Shapes whose text is laid out in rows (a title, then lines or compartments). */
export const ROW_SHAPES = new Set<string>(["class", "entity", "list", "container", "heading"]);
export const LINE_STYLES = ["solid", "dashed", "dotted"] as const;

const ALL_GROUPS = ["gcp.project", "gcp.region", "gcp.vpc", "gcp.subnet", "generic.group"];

export const CATALOG: CatalogEntry[] = [
  {
    kind: "generic.client",
    label: "Users / Internet",
    category: "External",
    description: "External users, browsers, mobile apps or third-party callers. Not provisioned.",
    parents: [],
    icon: { abbr: "USR", color: C.external },
    props: [],
  },
  {
    kind: "gcp.project",
    label: "GCP project",
    category: "Groups",
    description: "Google Cloud project boundary. The project id comes from the project_id Terraform variable.",
    container: true,
    parents: [],
    icon: { abbr: "PRJ", color: C.group },
    props: groupStyleProps({ color: C.group }),
  },
  {
    kind: "gcp.region",
    label: "Region",
    category: "Groups",
    description: "Regional grouping. Regional resources inside it are deployed to this region.",
    container: true,
    parents: ["gcp.project"],
    icon: { abbr: "RGN", color: C.group },
    props: [{ key: "region", label: "Region", type: "enum", default: "us-central1", options: REGIONS }, ...groupStyleProps({ color: C.group })],
  },
  {
    kind: "gcp.vpc",
    label: "VPC network",
    category: "Groups",
    description: "Custom-mode VPC network. Put subnets inside it; Memorystore and private Cloud SQL attach to it.",
    container: true,
    parents: IN_PROJECT,
    icon: { abbr: "VPC", color: C.network },
    props: groupStyleProps({ color: C.network }),
  },
  {
    kind: "gcp.subnet",
    label: "Subnet",
    category: "Groups",
    description: "Regional subnet inside a VPC. Cloud Run services inside it get direct VPC egress through it.",
    container: true,
    parents: ["gcp.vpc"],
    icon: { abbr: "SUB", color: C.network },
    props: [{ key: "cidr", label: "CIDR range", type: "string", default: "10.10.0.0/24" }, ...groupStyleProps({ color: C.network })],
  },
  {
    kind: "gcp.cloud_run",
    label: "Cloud Run service",
    category: "Compute",
    description:
      "Serverless container service. Gets its own service account; edges to data stores grant it least-privilege access.",
    parents: IN_NETWORK,
    icon: { abbr: "RUN", color: C.compute },
    props: [
      { key: "image", label: "Container image", type: "string", default: "us-docker.pkg.dev/cloudrun/container/hello" },
      { key: "cpu", label: "CPU", type: "enum", default: "1", options: ["1", "2", "4", "8"] },
      { key: "memory", label: "Memory", type: "enum", default: "512Mi", options: ["256Mi", "512Mi", "1Gi", "2Gi", "4Gi", "8Gi"] },
      { key: "min_instances", label: "Min instances", type: "number", default: 0 },
      { key: "max_instances", label: "Max instances", type: "number", default: 10 },
      {
        key: "public",
        label: "Allow unauthenticated",
        type: "boolean",
        default: false,
        description: "Grants roles/run.invoker to allUsers. Leave off when a load balancer or another service fronts it.",
      },
    ],
  },
  {
    kind: "gcp.cloud_sql",
    label: "Cloud SQL",
    category: "Data",
    description:
      "Managed PostgreSQL or MySQL. Inside a VPC it gets a private IP via private service access; otherwise public IP with SSL only.",
    parents: IN_NETWORK,
    icon: { abbr: "SQL", color: C.data },
    props: [
      {
        key: "database_version",
        label: "Engine",
        type: "enum",
        default: "POSTGRES_16",
        options: ["POSTGRES_16", "POSTGRES_15", "MYSQL_8_0"],
      },
      { key: "tier", label: "Machine tier", type: "string", default: "db-custom-1-3840" },
      { key: "high_availability", label: "High availability", type: "boolean", default: false },
      { key: "database_name", label: "Database name", type: "string", default: "app" },
      { key: "deletion_protection", label: "Deletion protection", type: "boolean", default: true },
    ],
  },
  {
    kind: "gcp.gcs_bucket",
    label: "Cloud Storage bucket",
    category: "Data",
    description: "Object storage with uniform bucket-level access and public access prevention.",
    parents: IN_NETWORK,
    icon: { abbr: "GCS", color: C.data },
    props: [
      {
        key: "storage_class",
        label: "Storage class",
        type: "enum",
        default: "STANDARD",
        options: ["STANDARD", "NEARLINE", "COLDLINE", "ARCHIVE"],
      },
      { key: "versioning", label: "Object versioning", type: "boolean", default: true },
    ],
  },
  {
    kind: "gcp.memorystore_redis",
    label: "Memorystore (Redis)",
    category: "Data",
    description: "Managed Redis. Must be inside a VPC; Cloud Run reaches it through a subnet (direct VPC egress).",
    parents: IN_NETWORK,
    icon: { abbr: "RDS", color: C.data },
    props: [
      { key: "tier", label: "Tier", type: "enum", default: "BASIC", options: ["BASIC", "STANDARD_HA"] },
      { key: "memory_size_gb", label: "Memory (GB)", type: "number", default: 1 },
    ],
  },
  {
    kind: "gcp.pubsub_topic",
    label: "Pub/Sub topic",
    category: "Messaging",
    description:
      "Message topic. An edge service → topic grants publish; an edge topic → Cloud Run creates an authenticated push subscription.",
    parents: IN_PROJECT,
    icon: { abbr: "PUB", color: C.messaging },
    props: [],
  },
  {
    kind: "gcp.load_balancer",
    label: "HTTPS load balancer",
    category: "Networking",
    description:
      "Global external Application Load Balancer. Edges to Cloud Run create serverless NEG backends. Set a domain for a Google-managed certificate.",
    parents: IN_PROJECT,
    icon: { abbr: "LB", color: C.network },
    props: [
      { key: "domain", label: "Domain (for HTTPS)", type: "string", default: "", description: "Leave empty for HTTP only." },
      { key: "cloud_armor", label: "Cloud Armor policy", type: "boolean", default: true },
    ],
  },
  {
    kind: "gcp.secret",
    label: "Secret Manager secret",
    category: "Security",
    description: "A secret. An edge service → secret grants secretAccessor to that service only.",
    parents: IN_PROJECT,
    icon: { abbr: "SEC", color: C.security },
    props: [],
  },
  {
    kind: "gcp.artifact_registry",
    label: "Artifact Registry",
    category: "DevOps",
    description: "Docker repository for service images. An edge repository → service grants the service read access.",
    parents: IN_PROJECT,
    icon: { abbr: "AR", color: C.devops },
    props: [],
  },
  {
    kind: "generic.group",
    label: "Group",
    category: "Other",
    description:
      "A documentation-only boundary: a team, an environment, an AWS VPC or account, an on-prem data center. Can hold anything; not deployed by Terraform.",
    container: true,
    parents: ALL_GROUPS,
    icon: { abbr: "GRP", color: "#71717a" },
    props: groupStyleProps({ color: "#71717a" }),
  },
  {
    kind: "generic.shape",
    label: "Shape",
    category: "Other",
    description: "A flowchart or basic shape (process, decision, start/end, input/output, document, database…). Documentation only.",
    parents: ALL_GROUPS,
    icon: { abbr: "SHP", color: "#475569" },
    props: [
      { key: "shape", label: "Shape", type: "enum", default: "rectangle", options: [...SHAPES] },
      { key: "fill", label: "Fill", type: "color", default: "#ffffff" },
      { key: "stroke", label: "Border", type: "color", default: "#000000" },
      { key: "textColor", label: "Text", type: "color", default: "#18181b" },
      { key: "font", label: "Font", type: "enum", default: "Sans", options: [...FONTS] },
      { key: "fontSize", label: "Font size", type: "enum", default: "13", options: [...FONT_SIZES] },
      { key: "bold", label: "Bold", type: "boolean", default: false },
      { key: "italic", label: "Italic", type: "boolean", default: false },
      { key: "lineStyle", label: "Line", type: "enum", default: "solid", options: ["solid", "dashed", "dotted"] },
      { key: "strokeWidth", label: "Line thickness", type: "enum", default: "1.5", options: ["1", "1.5", "2", "3", "4", "6"] },
      { key: "shadow", label: "Shadow", type: "boolean", default: false },
    ],
  },
  {
    kind: "generic.note",
    label: "Note",
    category: "Other",
    description: "A text note on the canvas. Not part of workflows or Terraform.",
    parents: ALL_GROUPS,
    icon: { abbr: "TXT", color: "#ca8a04" },
    props: [],
  },
  {
    kind: "generic.component",
    label: "Component",
    category: "Other",
    description:
      "Any other system: an AWS or Azure service, a SaaS API, an on-prem system, or a tool shown by its icon. Documentation only: it appears in workflows and presentations but isn't deployed by Terraform.",
    parents: ALL_GROUPS,
    icon: { abbr: "CMP", color: "#71717a" },
    props: [],
  },
];

/** Kinds that exist only on the diagram and are never deployed. */
export const DOC_ONLY_KINDS = new Set(["generic.client", "generic.component", "generic.group", "generic.note", "generic.shape"]);

// Documentation-only groups may wrap anything (an "Org" boundary around projects, a team
// around services), so every kind accepts one as a parent.
for (const e of CATALOG) if (!e.parents.includes("generic.group")) e.parents.push("generic.group");

const BY_KIND = new Map(CATALOG.map((e) => [e.kind, e]));

export function catalogEntry(kind: string): CatalogEntry | undefined {
  return BY_KIND.get(kind);
}

/** Props with catalog defaults applied. Unknown keys are dropped. */
export function resolvedProps(kind: string, props: Record<string, unknown> = {}): Record<string, string | number | boolean> {
  const entry = catalogEntry(kind);
  const out: Record<string, string | number | boolean> = {};
  for (const spec of entry?.props ?? []) {
    const v = props[spec.key];
    out[spec.key] = coerce(spec, v) ?? spec.default;
  }
  return out;
}

export function coerce(spec: PropSpec, v: unknown): string | number | boolean | undefined {
  if (v === undefined || v === null || v === "") return spec.type === "string" && v === "" ? "" : undefined;
  switch (spec.type) {
    case "number": {
      const n = typeof v === "number" ? v : Number(v);
      return Number.isFinite(n) ? n : undefined;
    }
    case "boolean":
      return typeof v === "boolean" ? v : v === "true" ? true : v === "false" ? false : undefined;
    case "enum":
      return spec.options?.includes(String(v)) ? String(v) : undefined;
    case "color":
      // "none" = transparent (no fill / no border).
      return /^#[0-9a-fA-F]{6}$/.test(String(v)) || String(v).toLowerCase() === "none" ? String(v).toLowerCase() : undefined;
    default:
      return String(v);
  }
}

export function propError(spec: PropSpec, v: unknown): string | undefined {
  if (v === undefined) return undefined;
  if (coerce(spec, v) === undefined)
    return spec.type === "enum"
      ? `${spec.key} must be one of ${spec.options?.join(", ")}`
      : `${spec.key} must be a ${spec.type}`;
  return undefined;
}
