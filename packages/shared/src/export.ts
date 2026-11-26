import { catalogEntry, resolvedProps } from "./catalog.js";
import { childrenOf, type DiagramModel, type DiagramNode } from "./model.js";

/**
 * Exporters to other tools' formats. They read positions from model.layout (relative to the
 * parent group, as the editor's auto-layout writes them) and fall back to a simple grid.
 */

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

const NODE_W = 160;
const NODE_H = 64;
const GAP = 40;
const PAD = 32;
const HEADER = 32;

/** Positions for every node, relative to its parent: stored layout first, a grid otherwise. */
export function resolveLayout(m: DiagramModel): Map<string, Box> {
  const out = new Map<string, Box>();
  const place = (parentId: string | undefined): { w: number; h: number } => {
    const kids = childrenOf(m, parentId);
    let x = parentId ? PAD : 0;
    const y = parentId ? HEADER + PAD / 2 : 0;
    let maxH = 0;
    for (const k of kids) {
      const inner = catalogEntry(k.kind)?.container ? place(k.id) : undefined;
      const stored = m.layout[k.id];
      const w = stored?.w ?? (inner ? Math.max(inner.w, NODE_W + 2 * PAD) : NODE_W);
      const h = stored?.h ?? (inner ? Math.max(inner.h, NODE_H + HEADER + PAD) : NODE_H);
      const box = stored ? { x: stored.x, y: stored.y, w, h } : { x, y, w, h };
      out.set(k.id, box);
      x = Math.max(x, box.x + box.w + GAP);
      maxH = Math.max(maxH, box.y + box.h);
    }
    return { w: x - GAP + (parentId ? PAD : 0), h: maxH + (parentId ? PAD : 0) };
  };
  place(undefined);
  return out;
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/\n/g, "&#xa;");

/** draw.io / diagrams.net file (.drawio). Groups become containers, so moving one in draw.io moves its contents. */
export function toDrawio(m: DiagramModel, title = "Architecture"): string {
  const boxes = resolveLayout(m);
  const cells: string[] = ['<mxCell id="0" />', '<mxCell id="1" parent="0" />'];
  const cellId = (id: string) => `n_${id}`;
  // Parents must precede children in the file; otherwise keep the model's order so a
  // re-import reproduces the same model (and the same Terraform).
  const ordered: DiagramNode[] = [];
  const placed = new Set<string>();
  const emit = (n: DiagramNode, guard = 0) => {
    if (placed.has(n.id) || guard > 50) return;
    const parent = n.parentId ? m.nodes.find((x) => x.id === n.parentId) : undefined;
    if (parent) emit(parent, guard + 1);
    placed.add(n.id);
    ordered.push(n);
  };
  m.nodes.forEach((n) => emit(n));
  for (const n of ordered) {
    const entry = catalogEntry(n.kind);
    const b = boxes.get(n.id)!;
    const color = entry?.icon.color ?? "#5f6368";
    const shapeProps = n.kind === "generic.shape" ? resolvedProps(n.kind, n.props) : undefined;
    const style = shapeProps
      ? `${DRAWIO_SHAPE[String(shapeProps.shape)] ?? "rounded=0;"}whiteSpace=wrap;html=1;fillColor=${shapeProps.fill};strokeColor=${shapeProps.stroke};fontColor=${shapeProps.textColor};`
      : n.kind === "generic.note"
        ? "shape=note;whiteSpace=wrap;html=1;fillColor=#fef9c3;strokeColor=#facc15;align=left;verticalAlign=top;spacing=8;"
        : entry?.container
          ? `rounded=1;arcSize=4;whiteSpace=wrap;html=1;container=1;collapsible=0;dashed=1;fillColor=none;strokeColor=${color};verticalAlign=top;align=left;spacingLeft=10;spacingTop=4;fontStyle=1;fontColor=${color};`
          : `rounded=1;whiteSpace=wrap;html=1;fillColor=#ffffff;strokeColor=${color};strokeWidth=2;fontColor=#202124;`;
    const value =
      shapeProps || n.kind === "generic.note"
        ? esc(n.label).replace(/&#xa;/g, "<br>")
        : entry?.container
          ? `${entry.label}: ${n.label}`
          : `<b>${esc(n.label)}</b><br><font color="${color}" style="font-size:10px">${esc(entry?.label ?? n.kind)}</font>`;
    // <object> carries ArchCanvas metadata as draw.io custom properties (Edit Data), so
    // re-importing is lossless and people can set types in draw.io itself.
    const props =
      (Object.keys(n.props).length ? ` archcanvas_props="${esc(JSON.stringify(n.props))}"` : "") +
      (n.icon ? ` archcanvas_icon="${esc(n.icon)}"` : "");
    cells.push(
      `<object id="${cellId(n.id)}" label="${esc(value)}" archcanvas_kind="${esc(n.kind)}" archcanvas_id="${esc(n.id)}"${props}>` +
        `<mxCell style="${style}" vertex="1" parent="${n.parentId ? cellId(n.parentId) : "1"}">` +
        `<mxGeometry x="${Math.round(b.x)}" y="${Math.round(b.y)}" width="${Math.round(b.w)}" height="${Math.round(b.h)}" as="geometry" />` +
        `</mxCell></object>`,
    );
  }
  for (const e of m.edges) {
    const label = e.label ?? e.protocol ?? "";
    cells.push(
      `<object id="e_${esc(e.id)}" label="${esc(label)}"${e.protocol ? ` archcanvas_protocol="${e.protocol}"` : ""}>` +
        `<mxCell style="${edgeStyle(e)}" edge="1" parent="1" source="${cellId(e.from)}" target="${cellId(e.to)}">` +
        `<mxGeometry relative="1" as="geometry" /></mxCell></object>`,
    );
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<mxfile host="ArchCanvas" type="device">
  <diagram id="archcanvas" name="${esc(title)}">
    <mxGraphModel grid="1" gridSize="10" guides="1" connect="1" arrows="1" page="0" math="0" shadow="0">
      <root>
        ${cells.join("\n        ")}
      </root>
    </mxGraphModel>
  </diagram>
</mxfile>
`;
}

/** draw.io style for each ArchCanvas shape. */
const DRAWIO_SHAPE: Record<string, string> = {
  rectangle: "rounded=0;",
  rounded: "rounded=1;",
  terminator: "rounded=1;arcSize=50;",
  ellipse: "ellipse;",
  circle: "ellipse;aspect=fixed;",
  diamond: "rhombus;",
  parallelogram: "shape=parallelogram;perimeter=parallelogramPerimeter;fixedSize=1;",
  hexagon: "shape=hexagon;perimeter=hexagonPerimeter2;fixedSize=1;",
  document: "shape=document;boundedLbl=1;",
  cylinder: "shape=cylinder3;boundedLbl=1;backgroundOutline=1;size=12;",
  predefined: "shape=process;backgroundOutline=1;",
  "manual-input": "shape=manualInput;",
  triangle: "triangle;direction=north;",
  cloud: "ellipse;shape=cloud;",
  text: "text;strokeColor=none;fillColor=none;align=center;verticalAlign=middle;",
};

const DRAWIO_ARROW: Record<string, string> = {
  none: "none;",
  arrow: "block;endFill=1;",
  open: "open;endFill=0;",
  triangle: "block;endFill=0;",
  diamond: "diamond;endFill=1;",
  odiamond: "diamond;endFill=0;",
  circle: "oval;endFill=1;",
};

function edgeStyle(e: DiagramModel["edges"][number]): string {
  const route = e.routing === "straight" ? "" : e.routing === "curved" ? "curved=1;" : "edgeStyle=orthogonalEdgeStyle;rounded=1;";
  const end = DRAWIO_ARROW[e.arrowEnd ?? "arrow"];
  // draw.io uses startFill for the start marker.
  const start = DRAWIO_ARROW[e.arrowStart ?? "none"].replace("endFill", "startFill");
  const dash = e.dash === "dashed" ? "dashed=1;" : e.dash === "dotted" ? "dashed=1;dashPattern=1 3;" : "";
  return `${route}html=1;endArrow=${end}startArrow=${start}${dash}strokeColor=${e.color ?? "#5f6368"};`;
}

/** Mermaid flowchart node syntax per shape. */
const MERMAID_SHAPE: Record<string, [string, string]> = {
  rectangle: ['["', '"]'],
  rounded: ['("', '")'],
  terminator: ['(["', '"])'],
  ellipse: ['(("', '"))'],
  circle: ['(("', '"))'],
  diamond: ['{"', '"}'],
  parallelogram: ['[/"', '"/]'],
  hexagon: ['{{"', '"}}'],
  document: ['["', '"]'],
  cylinder: ['[("', '")]'],
  predefined: ['[["', '"]]'],
  "manual-input": ['[/"', '"\\]'],
  triangle: ['["', '"]'],
  cloud: ['("', '")'],
  text: ['["', '"]'],
};

/** Mermaid flowchart: groups become subgraphs. Renders in GitHub, GitLab, Notion and Confluence. */
export function toMermaid(m: DiagramModel): string {
  const lines = ["flowchart LR"];
  const q = (s: string) => s.replace(/"/g, "#quot;");
  const emit = (pid: string | undefined, depth: number) => {
    for (const n of childrenOf(m, pid)) {
      const entry = catalogEntry(n.kind);
      const ind = "  ".repeat(depth);
      if (entry?.container) {
        lines.push(`${ind}subgraph ${n.id}["${q(`${entry.label}: ${n.label}`)}"]`);
        emit(n.id, depth + 1);
        lines.push(`${ind}end`);
      } else if (n.kind === "generic.shape" || n.kind === "generic.note") {
        // Plain shapes read like a flowchart: the text only.
        const shape = MERMAID_SHAPE[String(resolvedProps(n.kind, n.props).shape ?? "rectangle")] ?? MERMAID_SHAPE.rectangle;
        lines.push(`${ind}${n.id}${shape[0]}${q(n.label).replace(/\n/g, "<br/>")}${shape[1]}`);
      } else {
        const shape = n.kind === "gcp.cloud_sql" || n.kind === "gcp.memorystore_redis" ? [`[("`, `")]`] : n.kind === "generic.client" ? [`(["`, `"])`] : [`["`, `"]`];
        lines.push(`${ind}${n.id}${shape[0]}${q(n.label)}<br/><small>${q(entry?.label ?? n.kind)}</small>${shape[1]}`);
      }
    }
  };
  emit(undefined, 1);
  for (const e of m.edges) {
    const label = e.label ?? e.protocol;
    const noHead = (e.arrowEnd ?? "arrow") === "none";
    const both = e.arrowStart && e.arrowStart !== "none";
    const link = e.dash && e.dash !== "solid" ? (noHead ? "-.-" : both ? "<-.->" : "-.->") : noHead ? "---" : both ? "<-->" : "-->";
    lines.push(label ? `  ${e.from} ${link}|${q(label)}| ${e.to}` : `  ${e.from} ${link} ${e.to}`);
  }
  return lines.join("\n") + "\n";
}

/** PlantUML (component diagram). Imports into Confluence, IntelliJ, and anything that renders PlantUML. */
export function toPlantUml(m: DiagramModel): string {
  const lines = ["@startuml", "left to right direction", "skinparam componentStyle rectangle"];
  const q = (s: string) => s.replace(/"/g, "'");
  const emit = (pid: string | undefined, depth: number) => {
    for (const n of childrenOf(m, pid)) {
      const entry = catalogEntry(n.kind);
      const ind = "  ".repeat(depth);
      if (entry?.container) {
        lines.push(`${ind}rectangle "${q(`${entry.label}: ${n.label}`)}" as ${n.id} {`);
        emit(n.id, depth + 1);
        lines.push(`${ind}}`);
      } else {
        const kw = n.kind === "generic.client" ? "actor" : n.kind === "gcp.cloud_sql" || n.kind === "gcp.memorystore_redis" ? "database" : n.kind === "gcp.pubsub_topic" ? "queue" : "component";
        lines.push(`${ind}${kw} "${q(n.label)}" as ${n.id}`);
      }
    }
  };
  emit(undefined, 0);
  for (const e of m.edges) {
    const label = e.label ?? e.protocol;
    lines.push(`${e.from} --> ${e.to}${label ? ` : ${q(label)}` : ""}`);
  }
  lines.push("@enduml");
  return lines.join("\n") + "\n";
}
