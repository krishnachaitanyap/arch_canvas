import { BORDER_WIDTHS, CATALOG, catalogEntry, FONT_SIZES, FONTS, SHAPE_LABELS, type ShapeName } from "./catalog.js";
import { DRAWIO_AWS_GROUP } from "./groups.js";
import { type Arrowhead, type DiagramEdge, type DiagramModel, emptyModel, NODE_ID, type Protocol } from "./model.js";
import { applyOp, type Op } from "./ops.js";
import { findAll, htmlToText, parseXml, type XmlElement } from "./xml.js";

/**
 * draw.io / diagrams.net import. Reads .drawio and .xml files (plain or compressed, any
 * number of pages) and .drawio.svg, then maps shapes onto the GCP catalog:
 *
 *   exact   ArchCanvas metadata from our own export (lossless round trip)
 *   high    Google Cloud icons
 *   medium  AWS / Azure icons translated to the closest GCP service, or telling shapes
 *           (cylinder = database, actor = users)
 *   low     keywords in the label
 *
 * Every mapping is listed so people can review and override it before importing. Nodes and
 * edges are added through the same validated operations the editor uses.
 */

export interface DrawioCell {
  id: string;
  parent?: string;
  vertex: boolean;
  edge: boolean;
  label: string;
  style: string;
  attrs: Record<string, string>;
  geo?: { x: number; y: number; w: number; h: number };
  source?: string;
  target?: string;
}

export interface DrawioPage {
  id: string;
  name: string;
  cells: DrawioCell[];
}

export type Confidence = "exact" | "high" | "medium" | "low" | "none";

export interface ImportItem {
  cellId: string;
  label: string;
  /** Catalog kind, or null when the shape is skipped (containers: flattened). */
  kind: string | null;
  reason: string;
  confidence: Confidence;
  container: boolean;
  /** The node id it became, when imported. */
  nodeId?: string;
}

export interface ImportResult {
  model: DiagramModel;
  items: ImportItem[];
  warnings: string[];
  /** True when positions came from the file (ArchCanvas exports); otherwise auto-layout runs. */
  layoutKept: boolean;
}

// ------------------------------------------------------------------ reading files

/** Reads a draw.io file (XML, compressed XML, or an SVG with an embedded diagram) into pages. */
export async function readDrawio(text: string): Promise<DrawioPage[]> {
  const src = text.trim().replace(/^﻿/, "");
  if (!src.startsWith("<")) throw new Error("This doesn't look like a draw.io file (expected XML).");
  const doc = parseXml(src);
  const svg = doc.children.find((c) => c.name === "svg");
  if (svg) {
    if (!svg.attrs.content) throw new Error("This SVG has no embedded draw.io diagram. Export it from draw.io with \"Include a copy of my diagram\".");
    return readDrawio(svg.attrs.content);
  }
  const mxfile = doc.children.find((c) => c.name === "mxfile");
  if (mxfile) {
    const diagrams = mxfile.children.filter((c) => c.name === "diagram");
    if (!diagrams.length) throw new Error("The draw.io file has no pages.");
    return Promise.all(
      diagrams.map(async (d, i) => {
        let model = d.children.find((c) => c.name === "mxGraphModel");
        if (!model && d.text.trim()) model = parseXml(await inflate(d.text.trim())).children.find((c) => c.name === "mxGraphModel");
        return { id: d.attrs.id ?? `page-${i + 1}`, name: d.attrs.name ?? `Page ${i + 1}`, cells: model ? readCells(model) : [] };
      }),
    );
  }
  const model = doc.children.find((c) => c.name === "mxGraphModel");
  if (model) return [{ id: "page-1", name: "Page 1", cells: readCells(model) }];
  throw new Error("No draw.io diagram found in this file.");
}

/** draw.io's compressed format: base64 of raw-deflated, URI-encoded XML. */
async function inflate(b64: string): Promise<string> {
  const bin = atob(b64.replace(/\s+/g, ""));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  const xml = await new Response(stream).text();
  try {
    return decodeURIComponent(xml);
  } catch {
    return xml;
  }
}

function readCells(model: XmlElement): DrawioCell[] {
  const root = model.children.find((c) => c.name === "root");
  if (!root) return [];
  const cells: DrawioCell[] = [];
  for (const el of root.children) {
    // Shapes with custom data are wrapped: <object id label ...><mxCell .../></object>
    const wrapped = el.name === "object" || el.name === "UserObject";
    const cell = wrapped ? el.children.find((c) => c.name === "mxCell") : el.name === "mxCell" ? el : undefined;
    if (!cell) continue;
    const attrs = wrapped ? { ...el.attrs } : {};
    const id = (wrapped ? el.attrs.id : cell.attrs.id) ?? "";
    const raw = wrapped ? (el.attrs.label ?? "") : (cell.attrs.value ?? "");
    const g = findAll(cell, "mxGeometry").find((x) => x.attrs.as === "geometry");
    cells.push({
      id,
      parent: cell.attrs.parent,
      vertex: cell.attrs.vertex === "1",
      edge: cell.attrs.edge === "1",
      label: htmlToText(raw),
      style: cell.attrs.style ?? "",
      attrs,
      geo:
        g && g.attrs.relative !== "1"
          ? { x: num(g.attrs.x), y: num(g.attrs.y), w: num(g.attrs.width), h: num(g.attrs.height) }
          : undefined,
      source: cell.attrs.source,
      target: cell.attrs.target,
    });
  }
  return cells;
}

const num = (v: string | undefined) => (v ? Number(v) || 0 : 0);

// ------------------------------------------------------------------ classification

type Rule = [RegExp, string];

/** Keywords in icon style names (draw.io GCP, AWS and Azure libraries). Order matters. */
const ICON_RULES: Rule[] = [
  [/artifact_?registry|container_?registr|\becr\b|elastic_?container_?registry|\bacr\b/, "gcp.artifact_registry"],
  [/secret|key_?management|\bkms\b|key_?vault/, "gcp.secret"],
  [/memorystore|redis|elasticache|cache/, "gcp.memorystore_redis"],
  [/cloud_?sql|spanner|alloydb|\brds\b|aurora|sql_?database|database|cosmos|postgres|mysql|dynamodb|firestore|datastore/, "gcp.cloud_sql"],
  [/cloud_?storage|bucket|\bs3\b|simple_?storage|blob|storage_?account|filestore|storage/, "gcp.gcs_bucket"],
  [/pub_?sub|pubsub|\bsqs\b|\bsns\b|simple_?queue|simple_?notification|eventbridge|event_?hub|service_?bus|kinesis|eventarc|queue|topic/, "gcp.pubsub_topic"],
  [/load_?balanc|\belb\b|\balb\b|\bnlb\b|application_?gateway|front_?door|api_?gateway|apigee|cloud_?cdn|cloudfront|cloud_?armor/, "gcp.load_balancer"],
  [/cloud_?run|app_?engine|cloud_?functions?|lambda|fargate|\becs\b|\beks\b|\bgke\b|kubernetes|compute_?engine|\bec2\b|virtual_?machine|app_?services?|container_?apps?|function_?apps?|elastic_?beanstalk/, "gcp.cloud_run"],
  [/\busers?\b|actor|client|mobile|browser|internet|person|people|customer/, "generic.client"],
];

/** Exact GCP icon names that are the catalog item itself (anything else is "closest supported"). */
const GCP_EXACT = /cloud ?run|cloud ?sql|cloud ?storage|pub ?sub|memorystore|load ?balanc|secret ?manager|artifact ?registry/;

const LABEL_RULES: Rule[] = [
  [/\b(secrets?|vault|kms)\b/, "gcp.secret"],
  [/\b(registry|ecr|container images?)\b/, "gcp.artifact_registry"],
  [/\b(redis|cache|memcached?|memorystore)\b/, "gcp.memorystore_redis"],
  [/\b(db|database|postgres(ql)?|mysql|sql|rds|aurora|spanner|datastore)\b/, "gcp.cloud_sql"],
  [/\b(buckets?|storage|s3|blobs?|files?|uploads?|assets|media|objects?)\b/, "gcp.gcs_bucket"],
  [/\b(queues?|topics?|pub ?\/? ?sub|kafka|sqs|sns|events?|streams?|event bus|message bus)\b/, "gcp.pubsub_topic"],
  [/\b(load ?balancers?|lb|alb|elb|api gateway|gateway|ingress|cdn|nginx|reverse proxy|waf)\b/, "gcp.load_balancer"],
  [/\b(users?|clients?|customers?|browsers?|mobile|internet|people|partners?|end users?)\b/, "generic.client"],
  [/\b(api|apis|services?|server|app|application|web|website|worker|workers|backend|frontend|functions?|lambda|microservices?|jobs?|cron|handler|bff|ui|portal|scheduler|processor)\b/, "gcp.cloud_run"],
];

const GROUP_RULES: Rule[] = [
  [/subnet/, "gcp.subnet"],
  [/\bvpc\b|virtual_?network|\bvnet\b|virtual private cloud|group_vpc|\bnetwork\b/, "gcp.vpc"],
  [/region/, "gcp.region"],
  [/project|account|subscription|google_?cloud|gcp|aws_?cloud|group_aws_cloud|azure|\bcloud\b|production|staging|environment/, "gcp.project"],
];

const ICON_SPACED = spaced(ICON_RULES);
const GROUP_SPACED = spaced(GROUP_RULES);

export const REGION_RE = /\b(us|europe|asia|australia|northamerica|southamerica|me|africa)-[a-z]+\d\b/;
const CIDR_RE = /\b\d{1,3}(?:\.\d{1,3}){3}\/\d{1,2}\b/;

interface Classified {
  kind: string | null;
  reason: string;
  confidence: Confidence;
  /** Properties to set (shape, colours) for general shapes. */
  props?: Record<string, unknown>;
  /** Icon reference to show, e.g. "aws~sagemaker" (best match in the AWS pack). */
  icon?: string;
}

function provider(style: string): string | null {
  if (/mxgraph\.gcp|google_cloud|img\/lib\/gcp|gcp2/.test(style)) return "Google Cloud";
  if (/mxgraph\.aws|img\/lib\/aws/.test(style)) return "AWS";
  if (/mxgraph\.azure|mscae|img\/lib\/azure/.test(style)) return "Azure";
  return null;
}

/** The icon-ish part of a style: shape, prIcon, resIcon, grIcon and image values. */
function iconTokens(style: string): string {
  return style
    .split(";")
    .filter((p) => /^(shape|pricon|resicon|gricon|image)=/i.test(p))
    .map((p) => p.split("=").slice(1).join("=").toLowerCase().replace(/[._\-/]+/g, " "))
    .join(" ");
}

/** Icon names arrive with separators turned into spaces, so "cloud_?run" must also match "cloud run". */
function spaced(rules: Rule[]): Rule[] {
  return rules.map(([re, kind]) => [new RegExp(re.source.replace(/_\?/g, " ?").replace(/_/g, " ")), kind]);
}

/** Parses "a=1;b=2;rhombus;" into { a: "1", b: "2", rhombus: "" }. */
function styleMap(style: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of style.split(";")) {
    if (!part) continue;
    const i = part.indexOf("=");
    if (i < 0) out[part.trim().toLowerCase()] = "";
    else out[part.slice(0, i).trim().toLowerCase()] = part.slice(i + 1).trim();
  }
  return out;
}

/** Which ArchCanvas shape a draw.io style draws, if it's a flowchart/basic shape. */
function shapeOf(c: DrawioCell, plainToo: boolean): ShapeName | undefined {
  const s = c.style.toLowerCase();
  const m = styleMap(c.style);
  if (/shape=singlearrow/.test(s)) {
    const thin = Number(m.arrowwidth ?? 0.3) < 0.2;
    const dir = m.direction === "west" ? "left" : m.direction === "north" ? "up" : m.direction === "south" ? "down" : "right";
    return `${thin ? "thin-" : ""}arrow-${dir}` as ShapeName;
  }
  if (/shape=doublearrow/.test(s)) return m.direction === "south" || m.direction === "north" ? "arrow-up-down" : "arrow-left-right";
  if (/shape=step/.test(s)) return "chevron";
  if (/(^|;)line(;|$)/.test(s)) return m.direction === "south" || m.direction === "north" ? "vline" : "line";
  if (/rhombus|flowchart\.decision/.test(s)) return "diamond";
  if (/flowchart\.terminator|flowchart\.start/.test(s) || (m.rounded === "1" && Number(m.arcsize) >= 40)) return "terminator";
  if (/parallelogram|flowchart\.data\b/.test(s)) return "parallelogram";
  if (/hexagon|flowchart\.preparation/.test(s)) return "hexagon";
  if (/shape=document|flowchart\.document/.test(s)) return "document";
  if (/shape=process|flowchart\.predefined/.test(s)) return "predefined";
  if (/manualinput|flowchart\.manual_input/.test(s)) return "manual-input";
  if (/shape=cloud/.test(s)) return "cloud";
  if (/(^|;)triangle(;|$)/.test(s)) return "triangle";
  if (/(^|;)ellipse(;|$)/.test(s) || /flowchart\.on-page_reference|flowchart\.or/.test(s))
    return m.aspect === "fixed" || (c.geo && Math.abs(c.geo.w - c.geo.h) < 4) ? "circle" : "ellipse";
  if (!plainToo) return undefined;
  if (/cylinder|flowchart\.database|datastore/.test(s)) return "cylinder";
  if (/^text;|(^|;)text(;|$)/.test(s)) return "text";
  if (m.rounded === "1") return "rounded";
  return "rectangle";
}

function shapeProps(c: DrawioCell, shape: ShapeName): Record<string, unknown> {
  const m = styleMap(c.style);
  const hex = (v: string | undefined) => (v && /^#[0-9a-fA-F]{6}$/.test(v) ? v.toLowerCase() : undefined);
  return {
    shape,
    ...(hex(m.fillcolor) ? { fill: hex(m.fillcolor) } : {}),
    ...(hex(m.strokecolor) ? { stroke: hex(m.strokecolor) } : {}),
    ...(hex(m.fontcolor) ? { textColor: hex(m.fontcolor) } : {}),
    ...fontProps(m),
  };
}

/** Font, size, bold and italic from a draw.io style (sizes snap to the nearest offered size). */
function fontProps(m: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const family = FONTS.find((f) => f.toLowerCase() === (m.fontfamily ?? "").toLowerCase());
  if (family) out.font = family;
  if (m.fontsize && Number(m.fontsize) > 0) {
    const n = Number(m.fontsize);
    out.fontSize = [...FONT_SIZES].reduce((best, x) => (Math.abs(Number(x) - n) < Math.abs(Number(best) - n) ? x : best));
  }
  const style = Number(m.fontstyle ?? 0);
  if (style & 1) out.bold = true;
  if (style & 2) out.italic = true;
  return out;
}

const ARROWS: Record<string, Arrowhead> = { none: "none", block: "arrow", classic: "arrow", open: "open", diamond: "diamond", oval: "circle" };

/** Line pattern, arrowheads, routing and colour from a draw.io edge style. */
function edgeStyleOf(style: string): Partial<Pick<DiagramEdge, "dash" | "arrowStart" | "arrowEnd" | "color" | "routing">> {
  const m = styleMap(style);
  const head = (name: string | undefined, fill: string | undefined, fallback: Arrowhead): Arrowhead => {
    if (name === undefined) return fallback;
    const a = ARROWS[name.toLowerCase()] ?? fallback;
    if (fill === "0" && a === "arrow") return "triangle";
    if (fill === "0" && a === "diamond") return "odiamond";
    return a;
  };
  const out: ReturnType<typeof edgeStyleOf> = {};
  if (m.dashed === "1") out.dash = m.dashpattern && /^1\s/.test(m.dashpattern) ? "dotted" : "dashed";
  const end = head(m.endarrow, m.endfill, "arrow");
  const start = head(m.startarrow, m.startfill, "none");
  if (end !== "arrow") out.arrowEnd = end;
  if (start !== "none") out.arrowStart = start;
  if (m.strokecolor && /^#[0-9a-fA-F]{6}$/.test(m.strokecolor) && m.strokecolor.toLowerCase() !== "#5f6368" && m.strokecolor.toLowerCase() !== "#000000")
    out.color = m.strokecolor.toLowerCase();
  if (m.curved === "1") out.routing = "curved";
  else if (m.edgestyle === "none" || (!m.edgestyle && !("orthogonal" in m))) out.routing = "straight";
  return out;
}

function classifyResource(c: DrawioCell, flowchart = false): Classified {
  const style = c.style.toLowerCase();
  const label = c.label.toLowerCase();
  const prov = provider(style);
  const icon = iconTokens(c.style);
  // Flowchart and basic shapes (a diamond is never a cloud resource). On a flowchart page
  // every plain shape is a shape, so "Process order" doesn't turn into Cloud Run.
  const shape = prov ? undefined : shapeOf(c, flowchart);
  if (shape) return { kind: "generic.shape", reason: `${SHAPE_LABELS[shape].title} shape`, confidence: "high", props: shapeProps(c, shape) };
  if (prov && icon) {
    for (const [re, kind] of ICON_SPACED)
      if (re.test(icon)) {
        const name = catalogEntry(kind)!.label;
        if (prov === "Google Cloud")
          return GCP_EXACT.test(icon)
            ? { kind, reason: `Google Cloud icon (${name})`, confidence: "high" }
            : { kind, reason: `Google Cloud icon → ${name} (closest supported)`, confidence: "medium" };
        return { kind, reason: `${prov} icon → ${name}`, confidence: "medium" };
      }
  }
  if (/shape=(cylinder3?|datastore|mxgraph\.flowchart\.database|mxgraph\.basic\.cylinder)|\bdatabase\b/.test(style)) {
    const kind = /\b(redis|cache|memcached?)\b/.test(label) ? "gcp.memorystore_redis" : "gcp.cloud_sql";
    return { kind, reason: `Database shape → ${catalogEntry(kind)!.label}`, confidence: "medium" };
  }
  if (/shape=(actor|umlactor|mxgraph\.basic\.person|mxgraph\.cisco\.people)/.test(style))
    return { kind: "generic.client", reason: "Person shape → Users", confidence: "medium" };
  if (/shape=(mxgraph\.flowchart\.(delay|data)|queue)/.test(style) || /\bqueue\b/.test(style))
    return { kind: "gcp.pubsub_topic", reason: "Queue shape → Pub/Sub topic", confidence: "medium" };
  for (const [re, kind] of LABEL_RULES)
    if (re.test(label)) return { kind, reason: `Label "${c.label.split("\n")[0]}" → ${catalogEntry(kind)!.label}`, confidence: "low" };
  // Nothing GCP-shaped: keep it as a documentation-only component rather than dropping it.
  if (prov) {
    const name = icon.split(" ").filter((t) => !/^(mxgraph|aws4|aws3|gcp2?|azure|resourceicon|hexicon|img|lib)$/.test(t)).pop();
    const family = prov === "AWS" ? "aws" : prov === "Google Cloud" ? "gcp" : "azure";
    return { kind: "generic.component", reason: `${prov} icon with no GCP equivalent → component (documentation only)`, confidence: "low", icon: name ? `${family}~${name}` : undefined };
  }
  if (c.label.trim()) return { kind: "generic.component", reason: "Not recognised → component (documentation only)", confidence: "low" };
  return { kind: null, reason: "Not recognised", confidence: "none" };
}

function classifyGroup(c: DrawioCell): Classified {
  const text = `${iconTokens(c.style)} ${c.label.toLowerCase()}`;
  if (REGION_RE.test(c.label.toLowerCase()) && !/subnet|vpc/.test(text))
    return { kind: "gcp.region", reason: "Group named after a GCP region", confidence: "high" };
  for (const [re, kind] of GROUP_SPACED)
    if (re.test(text)) return { kind, reason: `Group "${c.label.split("\n")[0] || "unnamed"}" → ${catalogEntry(kind)!.label}`, confidence: "medium" };
  // A named box with no GCP meaning (a team, an environment) stays as a documentation-only group.
  if (c.label.trim()) return { kind: "generic.group", reason: `Group "${c.label.split("\n")[0]}" → documentation-only group`, confidence: "low" };
  return { kind: null, reason: "Unnamed group; its contents are kept", confidence: "none" };
}

/** A group box's look (border, thickness, colours, title) and its AWS group icon, if any. */
function groupLook(c: DrawioCell): { props: Record<string, unknown>; icon?: string } {
  const m = styleMap(c.style);
  const hex = (v: string | undefined) => (v && /^#[0-9a-fA-F]{6}$/.test(v) ? v.toLowerCase() : undefined);
  const gr = /mxgraph\.aws4\.(group_[a-z0-9_]+)/.exec(m.gricon ?? "")?.[1];
  let name = gr ? DRAWIO_AWS_GROUP[gr] : undefined;
  if (gr === "group_security_group") {
    // draw.io draws AWS subnets with this icon; the fill tells public (green) from private (blue).
    const fill = hex(m.fillcolor) ?? "";
    name = /public/i.test(c.label) || /^#e9f3e6|^#f2f6e8/.test(fill) ? "Publicsubnet" : "Privatesubnet";
  }
  const props: Record<string, unknown> = {};
  const color = hex(m.strokecolor) ?? hex(m.fontcolor);
  if (color) props.color = color;
  if (m.strokecolor === "none") props.border = "none";
  else props.border = m.dashed === "1" ? (/^\s*[01](\.\d+)?\s+[1-9]/.test(m.dashpattern ?? "") && Number((m.dashpattern ?? "").trim().split(/\s+/)[0]) <= 1 ? "dotted" : "dashed") : "solid";
  const w = Number(m.strokewidth ?? 1);
  props.borderWidth = [...BORDER_WIDTHS].reduce((best, x) => (Math.abs(Number(x) - w) < Math.abs(Number(best) - w) ? x : best), "1");
  const fill = hex(m.fillcolor);
  props.fill = fill && fill !== "#ffffff" ? fill : "none";
  props.header = name ? "tab" : m.align === "center" ? "center" : "label";
  return { props, icon: name ? `aws:${name}` : undefined };
}

// ------------------------------------------------------------------ page → model

export function drawioToModel(page: DrawioPage, overrides: Record<string, string | null> = {}): ImportResult {
  const warnings: string[] = [];
  const byId = new Map(page.cells.map((c) => [c.id, c]));
  const layers = new Set(page.cells.filter((c) => !c.vertex && !c.edge && c.parent !== undefined && !byId.get(c.parent)?.parent).map((c) => c.id));
  const isTop = (c: DrawioCell) => !c.parent || layers.has(c.parent) || !byId.has(c.parent);
  const edgeIds = new Set(page.cells.filter((c) => c.edge).map((c) => c.id));
  const vertices = page.cells.filter((c) => c.vertex && !(c.parent && edgeIds.has(c.parent)) && !/edgeLabel/.test(c.style));

  // Absolute boxes (draw.io child geometry is relative to the parent shape).
  const abs = new Map<string, { x: number; y: number; w: number; h: number }>();
  const absOf = (c: DrawioCell): { x: number; y: number; w: number; h: number } => {
    const cached = abs.get(c.id);
    if (cached) return cached;
    const g = c.geo ?? { x: 0, y: 0, w: 0, h: 0 };
    const p = !isTop(c) ? byId.get(c.parent!) : undefined;
    const base = p && p.vertex ? absOf(p) : { x: 0, y: 0 };
    const box = { x: g.x + base.x, y: g.y + base.y, w: g.w, h: g.h };
    abs.set(c.id, box);
    return box;
  };
  vertices.forEach(absOf);

  const hasExplicitChildren = new Set(vertices.filter((v) => !isTop(v)).map((v) => v.parent!));
  const looksLikeIcon = (c: DrawioCell) => Boolean(provider(c.style.toLowerCase())) && !/group|container=1|swimlane/.test(c.style.toLowerCase());
  const isText = (c: DrawioCell) => /^text;|(^|;)text(;|$)/.test(c.style) || (/strokecolor=none/i.test(c.style) && /fillcolor=none/i.test(c.style) && !hasExplicitChildren.has(c.id));
  const contains = (a: DrawioCell, b: DrawioCell) => {
    const A = abs.get(a.id)!;
    const B = abs.get(b.id)!;
    return a.id !== b.id && A.w * A.h > B.w * B.h && B.x >= A.x - 1 && B.y >= A.y - 1 && B.x + B.w <= A.x + A.w + 1 && B.y + B.h <= A.y + A.h + 1;
  };
  const explicitContainer = (c: DrawioCell) =>
    c.attrs.archcanvas_kind
      ? Boolean(catalogEntry(c.attrs.archcanvas_kind)?.container)
      : hasExplicitChildren.has(c.id) || /container=1|swimlane|(^|;)group(;|$)|mxgraph\.(aws4|gcp2?|azure)\.group/i.test(c.style);
  // Plain rectangles that visually enclose other shapes are groups too.
  const containers = new Set(
    vertices
      .filter((c) => !isText(c) && (explicitContainer(c) || (!looksLikeIcon(c) && !/cylinder|actor|ellipse/i.test(c.style) && vertices.some((o) => !isText(o) && contains(c, o)))))
      .map((c) => c.id),
  );

  // Effective parent: explicit container parent, else the smallest container that encloses it.
  const parentOf = new Map<string, string | undefined>();
  for (const v of vertices) {
    let p: string | undefined = !isTop(v) && containers.has(v.parent!) ? v.parent : undefined;
    if (!p && isTop(v)) {
      const enclosing = vertices.filter((c) => containers.has(c.id) && contains(c, v) && !isAncestor(c.id, v.id));
      enclosing.sort((a, b) => abs.get(a.id)!.w * abs.get(a.id)!.h - abs.get(b.id)!.w * abs.get(b.id)!.h);
      p = enclosing[0]?.id;
    }
    // A non-container parent (e.g. a label inside an icon) means "part of that shape".
    if (!p && !isTop(v) && !containers.has(v.parent!)) p = parentOf.get(v.parent!) ?? undefined;
    parentOf.set(v.id, p);
  }
  function isAncestor(maybeAncestor: string, id: string): boolean {
    let cur = byId.get(maybeAncestor);
    while (cur && !isTop(cur)) {
      if (cur.parent === id) return true;
      cur = byId.get(cur.parent!);
    }
    return false;
  }

  // Classify
  // A page of flowchart shapes with no cloud icons is read as a flowchart.
  const flowchart =
    !vertices.some((v) => provider(v.style.toLowerCase())) &&
    vertices.some((v) => /rhombus|mxgraph\.flowchart|parallelogram|shape=process|shape=document|shape=manualinput/.test(v.style.toLowerCase()));
  const items: ImportItem[] = [];
  const kindOf = new Map<string, string | null>();
  const propsOf = new Map<string, Record<string, unknown> | undefined>();
  const iconOf = new Map<string, string | undefined>();
  for (const v of vertices) {
    const container = containers.has(v.id);
    const partOfShape = !isTop(v) && !containers.has(v.parent!) && byId.get(v.parent!)?.vertex;
    if (partOfShape) continue; // labels and badges inside another shape
    if (!container && isText(v)) continue; // free-floating annotations
    if (!v.label && !container && !provider(v.style.toLowerCase()) && !v.attrs.archcanvas_kind) continue; // decoration
    let c: Classified;
    if (v.attrs.archcanvas_kind && catalogEntry(v.attrs.archcanvas_kind))
      c = { kind: v.attrs.archcanvas_kind, reason: "ArchCanvas export", confidence: "exact" };
    else c = container ? classifyGroup(v) : classifyResource(v, flowchart);
    if (v.id in overrides) {
      const o = overrides[v.id];
      c = { kind: o && catalogEntry(o) ? o : null, reason: o ? "Chosen by you" : container ? "Flattened by you" : "Skipped by you", confidence: o ? "exact" : "none" };
    }
    if (c.kind && Boolean(catalogEntry(c.kind)?.container) !== container) {
      // e.g. a resource kind chosen for a group, or vice versa
      if (container) c = { kind: null, reason: `${catalogEntry(c.kind)?.label} is not a group; contents kept`, confidence: "none" };
    }
    kindOf.set(v.id, c.kind);
    if (container && c.kind && !v.attrs.archcanvas_props && !v.attrs.archcanvas_kind) {
      const look = groupLook(v);
      c = { ...c, props: { ...c.props, ...look.props }, icon: c.icon ?? look.icon };
    }
    iconOf.set(v.id, v.attrs.archcanvas_icon || c.icon);
    propsOf.set(v.id, c.props);
    // Our export labels groups "VPC network: main"; drop the type prefix again.
    let label = v.label.split("\n")[0];
    const prefix = c.kind ? `${catalogEntry(c.kind)?.label}: ` : "";
    if (prefix && container && label.startsWith(prefix)) label = label.slice(prefix.length);
    items.push({ cellId: v.id, label: label || (container ? "(unnamed group)" : "(no label)"), kind: c.kind, reason: c.reason, confidence: c.confidence, container });
  }

  // Build the model through validated operations: groups outside-in, then resources, then connections.
  let model = emptyModel();
  const nodeIdOf = new Map<string, string>();
  const used = new Set<string>();
  let nestingChanged = false;
  const mappedAncestors = (cellId: string): string[] => {
    const out: string[] = [];
    let p = parentOf.get(cellId);
    while (p) {
      if (kindOf.get(p)) out.push(p);
      else if (containers.has(p) && kindOf.has(p)) nestingChanged = true; // flattened group in between
      p = parentOf.get(p);
    }
    return out;
  };
  const depth = (id: string) => {
    let d = 0;
    for (let p = parentOf.get(id); p; p = parentOf.get(p)) d++;
    return d;
  };
  const ordered = items.filter((i) => i.kind).sort((a, b) => Number(b.container) - Number(a.container) || depth(a.cellId) - depth(b.cellId));

  for (const item of ordered) {
    const cell = byId.get(item.cellId)!;
    const entry = catalogEntry(item.kind!)!;
    const id = uniqueId(cell.attrs.archcanvas_id || item.label, item.kind!, used);
    const props = { ...propsOf.get(item.cellId), ...propsFor(cell, item.kind!) };
    if (item.kind === "generic.shape" && !cell.attrs.archcanvas_props) Object.assign(props, propsOf.get(item.cellId));
    let parentId: string | undefined;
    const ancestors = mappedAncestors(item.cellId);
    for (const [i, a] of ancestors.entries()) {
      const pn = nodeIdOf.get(a);
      const pk = kindOf.get(a);
      if (pn && pk && entry.parents.includes(pk)) {
        parentId = pn;
        if (i > 0) {
          nestingChanged = true;
          warnings.push(
            `"${item.label}" can't go inside "${byId.get(ancestors[0])!.label.split("\n")[0]}" (${catalogEntry(kindOf.get(ancestors[0])!)?.label}) on GCP, so it was placed in "${byId.get(a)!.label.split("\n")[0]}".`,
          );
        }
        break;
      }
    }
    if (!parentId && ancestors.length) {
      nestingChanged = true;
      warnings.push(`"${item.label}" can't go inside "${byId.get(ancestors[0])!.label.split("\n")[0]}" (${catalogEntry(kindOf.get(ancestors[0])!)?.label}), so it was moved up.`);
    }
    const icon = iconOf.get(item.cellId);
    const text = item.kind === "generic.shape" || item.kind === "generic.note" ? cell.label.slice(0, 500) : item.label.slice(0, 80);
    const r = applyOp(model, { op: "add_node", id, kind: item.kind!, label: text || entry.label, parentId, props, ...(icon ? { icon } : {}) });
    if (!r.ok) {
      warnings.push(`Skipped "${item.label}": ${r.error}`);
      item.kind = null;
      continue;
    }
    model = r.model;
    used.add(id);
    nodeIdOf.set(item.cellId, id);
    item.nodeId = id;
  }

  // Keep the file's shape order (it was changed above to add groups before their contents).
  const fileOrder = new Map(page.cells.map((c, i) => [nodeIdOf.get(c.id), i]));
  model = { ...model, nodes: [...model.nodes].sort((a, b) => (fileOrder.get(a.id) ?? 0) - (fileOrder.get(b.id) ?? 0)) };

  // Connections
  const resolve = (cellId: string | undefined): { id?: string; why?: string } => {
    let cur = cellId ? byId.get(cellId) : undefined;
    while (cur) {
      const n = nodeIdOf.get(cur.id);
      if (n) return catalogEntry(kindOf.get(cur.id)!)?.container ? { why: "a group" } : { id: n };
      if (containers.has(cur.id)) return { why: "a group" };
      cur = !isTop(cur) ? byId.get(cur.parent!) : undefined;
    }
    return { why: cellId ? "a skipped shape" : "nothing" };
  };
  let skippedEdges = 0;
  for (const e of page.cells.filter((c) => c.edge)) {
    const a = resolve(e.source);
    const b = resolve(e.target);
    const childLabel = page.cells
      .filter((c) => c.parent === e.id && c.label)
      .map((c) => c.label)
      .join(" ");
    const label = (e.label || childLabel).split("\n")[0].slice(0, 60);
    if (!a.id || !b.id) {
      skippedEdges++;
      if (a.why === "a group" || b.why === "a group")
        warnings.push(`Connection${label ? ` "${label}"` : ""} is attached to a group, not a resource; connect the resources instead.`);
      continue;
    }
    if (a.id === b.id) continue;
    const protocol = (e.attrs.archcanvas_protocol as Protocol | undefined) || inferProtocol(label);
    const op: Op = { op: "connect", from: a.id, to: b.id, ...(label && label !== protocol ? { label } : {}), ...(protocol ? { protocol } : {}), ...edgeStyleOf(e.style) };
    const r = applyOp(model, op);
    if (r.ok) model = r.model;
  }
  if (skippedEdges) warnings.push(`${skippedEdges} connection${skippedEdges === 1 ? " was" : "s were"} not imported because an end isn't attached to an imported resource.`);

  const unmatched = items.filter((i) => !i.kind && !i.container).length;
  const components = items.filter((i) => i.kind === "generic.component").length;
  if (components)
    warnings.push(`${components} shape${components === 1 ? " has" : "s have"} no GCP equivalent and became documentation-only components (not deployed by Terraform).`);
  if (unmatched) warnings.push(`${unmatched} shape${unmatched === 1 ? " was" : "s were"} not recognised. Pick a type for ${unmatched === 1 ? "it" : "them"} below, or leave skipped.`);

  // Keep positions only for exact ArchCanvas round trips; anything else is auto-laid out
  // because draw.io icons and our nodes have different sizes.
  const exact = items.filter((i) => i.kind).every((i) => i.confidence === "exact") && !nestingChanged;
  if (exact) {
    for (const [cellId, nodeId] of nodeIdOf) {
      const cell = byId.get(cellId)!;
      const node = model.nodes.find((n) => n.id === nodeId)!;
      const own = abs.get(cellId)!;
      const parentCell = node.parentId ? [...nodeIdOf].find(([, n]) => n === node.parentId)?.[0] : undefined;
      const base = parentCell ? abs.get(parentCell)! : { x: 0, y: 0 };
      const container = catalogEntry(node.kind)?.container;
      model.layout[nodeId] = { x: own.x - base.x, y: own.y - base.y, ...(container ? { w: own.w, h: own.h } : {}) };
      void cell;
    }
  }
  return { model, items, warnings, layoutKept: exact };
}

function propsFor(cell: DrawioCell, kind: string): Record<string, unknown> {
  if (cell.attrs.archcanvas_props) {
    try {
      const p = JSON.parse(cell.attrs.archcanvas_props) as Record<string, unknown>;
      const keys = new Set(catalogEntry(kind)?.props.map((s) => s.key));
      return Object.fromEntries(Object.entries(p).filter(([k]) => keys.has(k)));
    } catch {
      /* ignore malformed metadata */
    }
  }
  const text = cell.label.toLowerCase();
  if (kind === "gcp.region") {
    const r = text.match(REGION_RE)?.[0];
    const options = CATALOG.find((c) => c.kind === "gcp.region")!.props[0].options!;
    return r && options.includes(r) ? { region: r } : {};
  }
  if (kind === "gcp.subnet") {
    const cidr = cell.label.match(CIDR_RE)?.[0];
    return cidr ? { cidr } : {};
  }
  return {};
}

function uniqueId(label: string, kind: string, used: Set<string>): string {
  let base = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 34);
  if (!base) base = kind.split(".").pop()!;
  if (!/^[a-z]/.test(base)) base = `n_${base}`.slice(0, 34);
  let id = base;
  for (let i = 2; used.has(id) || !NODE_ID.test(id); i++) id = `${base}_${i}`;
  return id;
}

function inferProtocol(label: string): Protocol | undefined {
  const l = label.toLowerCase();
  if (/\bgrpc\b/.test(l)) return "grpc";
  if (/\bhttps\b|\btls\b/.test(l)) return "https";
  if (/\bhttp\b|\brest\b/.test(l)) return "http";
  if (/\b(sql|jdbc|postgres|mysql)\b/.test(l)) return "sql";
  if (/\bredis\b/.test(l)) return "redis";
  if (/\btcp\b/.test(l)) return "tcp";
  return undefined;
}
