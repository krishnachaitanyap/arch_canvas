import ELK, { type ElkNode } from "elkjs/lib/elk.bundled.js";
import { catalogEntry, childrenOf, type DiagramModel } from "@archcanvas/shared";

export const NODE_W = 184;
export const NODE_H = 60;
const EMPTY_GROUP_W = 240;
const EMPTY_GROUP_H = 120;

const elk = new ELK();

/** True when every node already has a position (so no auto-layout is needed). */
export function hasLayout(m: DiagramModel): boolean {
  return m.nodes.every((n) => m.layout[n.id]);
}

/**
 * Layered left-to-right layout over nested groups. ELK returns child positions relative to
 * their parent, which is exactly what React Flow sub-flows and draw.io containers expect.
 */
export async function autoLayout(m: DiagramModel): Promise<DiagramModel["layout"]> {
  const build = (parentId: string | undefined): ElkNode[] =>
    childrenOf(m, parentId).map((n) => {
      const container = catalogEntry(n.kind)?.container;
      if (!container) return { id: n.id, width: NODE_W, height: NODE_H };
      const children = build(n.id);
      return children.length
        ? { id: n.id, children, layoutOptions: { "elk.padding": "[top=48,left=24,bottom=24,right=24]" } }
        : { id: n.id, width: EMPTY_GROUP_W, height: EMPTY_GROUP_H };
    });

  const ids = new Set(m.nodes.map((n) => n.id));
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
    children: build(undefined),
    edges: m.edges
      .filter((e) => ids.has(e.from) && ids.has(e.to))
      .map((e) => ({ id: e.id, sources: [e.from], targets: [e.to] })),
  };
  const res = await elk.layout(graph);
  const layout: DiagramModel["layout"] = {};
  const walk = (nodes: ElkNode[] | undefined) => {
    for (const n of nodes ?? []) {
      layout[n.id] = { x: n.x ?? 0, y: n.y ?? 0, w: n.width ?? NODE_W, h: n.height ?? NODE_H };
      walk(n.children);
    }
  };
  walk(res.children);
  return layout;
}

/** Signature of everything that affects auto-layout. */
export function structureKey(m: DiagramModel): string {
  return JSON.stringify([m.nodes.map((n) => [n.id, n.parentId ?? ""]), m.edges.map((e) => e.id)]);
}
