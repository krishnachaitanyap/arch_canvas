import ELK, { type ElkNode } from "elkjs/lib/elk.bundled.js";
import { catalogEntry, childrenOf, type DiagramModel, type DiagramNode, SHAPE_LABELS, type ShapeName } from "@archcanvas/shared";

/** An icon item's box (its name is drawn underneath, outside the box, as in draw.io). */
export const NODE_W = 100;
export const NODE_H = 64;
/** Room kept under icon items for their name. */
export const CAPTION_H = 36;
const CAPTION_W = 150;
/** Items drawn as an icon with the name below (not groups, shapes or notes). */
export const isIconItem = (kind: string) => kind !== "generic.shape" && kind !== "generic.note" && !catalogEntry(kind)?.container;
const EMPTY_GROUP_W = 240;
const EMPTY_GROUP_H = 120;

const elk = new ELK();

/** True when every node already has a position (so no auto-layout is needed). */
export function hasLayout(m: DiagramModel): boolean {
  return m.nodes.every((n) => m.layout[n.id]);
}

/** A node's size: what the user gave it, else its default (shapes and notes have their own). */
function ownSize(n: DiagramNode): { width: number; height: number } {
  const l = layoutOf.get(n.id);
  const def: [number, number] =
    n.kind === "generic.shape"
      ? (SHAPE_LABELS[String(n.props.shape ?? "rectangle") as ShapeName]?.size ?? [160, 70])
      : n.kind === "generic.note"
        ? [200, 90]
        : [NODE_W, NODE_H];
  return { width: l?.w ?? def[0], height: l?.h ?? def[1] };
}
let layoutOf = new Map<string, { w?: number; h?: number }>();

/**
 * Layered left-to-right layout over nested groups. ELK returns child positions relative to
 * their parent, which is exactly what React Flow sub-flows and draw.io containers expect.
 */
export async function autoLayout(m: DiagramModel): Promise<DiagramModel["layout"]> {
  layoutOf = new Map(Object.entries(m.layout));
  const build = (parentId: string | undefined): ElkNode[] =>
    childrenOf(m, parentId).map((n) => {
      const container = catalogEntry(n.kind)?.container;
      if (!container) {
        const own = ownSize(n);
        // Icon items get room for the name underneath.
        return isIconItem(n.kind) ? { id: n.id, width: Math.max(own.width, CAPTION_W), height: own.height + CAPTION_H } : { id: n.id, ...own };
      }
      const children = build(n.id);
      return children.length
        ? { id: n.id, children, layoutOptions: { "elk.padding": "[top=48,left=24,bottom=24,right=24]" } }
        : { id: n.id, width: EMPTY_GROUP_W, height: EMPTY_GROUP_H };
    });

  const ids = new Set(m.nodes.map((n) => n.id));
  // Top-level items with no lines to them (or to anything inside them) are packed in rows
  // afterwards; ELK would stack them in one long column.
  const linked = new Set(m.edges.flatMap((e) => [e.from, e.to]));
  const touches = (id: string): boolean => linked.has(id) || m.nodes.some((c) => c.parentId === id && touches(c.id));
  const loose = new Set(childrenOf(m, undefined).filter((n) => !touches(n.id)).map((n) => n.id));
  const graph: ElkNode = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.hierarchyHandling": "INCLUDE_CHILDREN",
      "elk.layered.spacing.nodeNodeBetweenLayers": "72",
      "elk.spacing.nodeNode": "36",
      "elk.spacing.componentComponent": "60",
      "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
      "elk.edgeRouting": "ORTHOGONAL",
    },
    children: build(undefined).filter((c) => !loose.has(c.id)),
    edges: m.edges
      .filter((e) => ids.has(e.from) && ids.has(e.to))
      .map((e) => ({ id: e.id, sources: [e.from], targets: [e.to] })),
  };
  const res = await elk.layout(graph);
  const layout: DiagramModel["layout"] = {};
  const walk = (nodes: ElkNode[] | undefined) => {
    for (const n of nodes ?? []) {
      const node = m.nodes.find((x) => x.id === n.id);
      if (node && isIconItem(node.kind)) {
        // Centre the icon in the slot that also holds its name.
        const own = ownSize(node);
        layout[n.id] = { x: (n.x ?? 0) + ((n.width ?? own.width) - own.width) / 2, y: n.y ?? 0, w: own.width, h: own.height };
      } else layout[n.id] = { x: n.x ?? 0, y: n.y ?? 0, w: n.width ?? NODE_W, h: n.height ?? NODE_H };
      walk(n.children);
    }
  };
  walk(res.children);
  packLoose(m, [...loose], layout);
  return layout;
}

/** Signature of everything that affects auto-layout. */
export function structureKey(m: DiagramModel): string {
  return JSON.stringify([m.nodes.map((n) => [n.id, n.parentId ?? ""]), m.edges.map((e) => e.id)]);
}

/** Rows of unconnected items under the connected part, wrapping at a sensible width. */
function packLoose(m: DiagramModel, ids: string[], layout: DiagramModel["layout"]) {
  if (!ids.length) return;
  const placed = Object.values(layout);
  const top = placed.length ? Math.max(...placed.map((l) => l.y + (l.h ?? NODE_H))) + 60 : 0;
  const sizes = ids.map((id) => {
    const n = m.nodes.find((x) => x.id === id)!;
    if (catalogEntry(n.kind)?.container) {
      // Its children keep ELK-free positions relative to it; size it to them or its own size.
      const own = layoutOf.get(id);
      return { id, width: own?.w ?? EMPTY_GROUP_W, height: own?.h ?? EMPTY_GROUP_H };
    }
    const own = ownSize(n);
    return isIconItem(n.kind)
      ? { id, width: Math.max(own.width, CAPTION_W), height: own.height + CAPTION_H, own }
      : { id, ...own };
  });
  const total = sizes.reduce((a, s) => a + s.width * s.height, 0);
  const rowW = Math.max(900, Math.min(2400, Math.sqrt(total) * 1.8), placed.length ? Math.max(...placed.map((l) => l.x + (l.w ?? NODE_W))) : 0);
  let x = 0;
  let y = top;
  let rowH = 0;
  for (const s of sizes) {
    if (x > 0 && x + s.width > rowW) {
      x = 0;
      y += rowH + 40;
      rowH = 0;
    }
    const own = "own" in s && s.own ? s.own : undefined;
    layout[s.id] = own ? { x: x + (s.width - own.width) / 2, y, w: own.width, h: own.height } : { x, y, w: s.width, h: s.height };
    for (const c of m.nodes.filter((n) => n.parentId === s.id)) if (!layout[c.id] && m.layout[c.id]) layout[c.id] = m.layout[c.id];
    x += s.width + 40;
    rowH = Math.max(rowH, s.height);
  }
}
