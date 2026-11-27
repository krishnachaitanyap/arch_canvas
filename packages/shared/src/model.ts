import { z } from "zod";

/**
 * The canonical, typed diagram model. The editor renders it, the agent edits it through
 * operations, and the Terraform compiler and exporters read it.
 *
 * Node ids double as Terraform resource names, so they are restricted to snake_case.
 */
export const NODE_ID = /^[a-z][a-z0-9_]{0,40}$/;

export const NodeSchema = z.object({
  id: z.string().regex(NODE_ID, "id must be snake_case: lowercase letters, digits, underscores"),
  kind: z.string().min(1),
  // Names are short in the UI; notes (generic.note) use this for their text.
  // May be empty (an icon with no text, as in draw.io); workflows and docs then use the type's name.
  label: z.string().max(500),
  parentId: z.string().optional(),
  props: z.record(z.unknown()).default({}),
  /**
   * Icon override, as "pack:name" (e.g. "aws:AWSLambda", "lucide:database", or an uploaded
   * pack's id). Purely visual: Terraform and workflows ignore it.
   */
  icon: z.string().max(240).optional(),
  /** The tab (page) a top-level item is on; the first page when unset. Items in a group follow the group. */
  page: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/).optional(),
  /** Locked on the canvas: can't be moved, resized or deleted until unlocked (as in draw.io). */
  locked: z.boolean().optional(),
});

export const PageSchema = z.object({ id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/), name: z.string().trim().min(1).max(60) });

/** Arrowheads: filled arrow, open arrow, hollow triangle (UML inheritance), filled / hollow diamond (composition / aggregation), circle, none. */
/** Line ends: arrows, UML diamonds, and entity-relationship crow's feet (er-*). */
export const ARROWHEADS = ["none", "arrow", "open", "triangle", "diamond", "odiamond", "circle", "er-one", "er-many", "er-one-many", "er-zero-many", "er-zero-one"] as const;
export type Arrowhead = (typeof ARROWHEADS)[number];
export const SIDES = ["t", "r", "b", "l"] as const;
export type Side = (typeof SIDES)[number];

export const PROTOCOLS = ["https", "http", "grpc", "tcp", "sql", "redis", "pubsub", "storage", "secret"] as const;

export const EdgeSchema = z.object({
  id: z.string().min(1),
  from: z.string(),
  to: z.string(),
  label: z.string().max(60).optional(),
  protocol: z.enum(PROTOCOLS).optional(),
  /** How the line is drawn; orthogonal when unset. */
  routing: z.enum(["orthogonal", "straight", "curved"]).optional(),
  /** Line pattern; solid when unset. */
  dash: z.enum(["solid", "dashed", "dotted"]).optional(),
  /** Arrowheads; the end gets a filled arrow and the start none when unset. */
  arrowStart: z.enum(ARROWHEADS).optional(),
  arrowEnd: z.enum(ARROWHEADS).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  /** Which side of each shape the line attaches to (t/r/b/l); automatic when unset. */
  fromHandle: z.enum(SIDES).optional(),
  toHandle: z.enum(SIDES).optional(),
  /** Where the label sits, relative to the middle of the line (dragged like in draw.io). */
  labelDx: z.number().int().min(-3000).max(3000).optional(),
  labelDy: z.number().int().min(-3000).max(3000).optional(),
});

export type Routing = "orthogonal" | "straight" | "curved";

export const LayoutSchema = z.object({
  x: z.number(),
  y: z.number(),
  w: z.number().optional(),
  h: z.number().optional(),
  /** Rotation in degrees, clockwise (shapes and icon items). */
  r: z.number().min(-360).max(360).optional(),
});

export const DiagramModelSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  nodes: z.array(NodeSchema).default([]),
  edges: z.array(EdgeSchema).default([]),
  /** Positions relative to the parent group, as produced by auto-layout or dragging. */
  layout: z.record(LayoutSchema).default({}),
  /**
   * Tabs (pages) of the canvas, in order, like draw.io pages: e.g. Architecture, HA / DR, CI/CD.
   * Unset means one page. Terraform, validation and workflows cover every page.
   */
  pages: z.array(PageSchema).max(50).optional(),
  /** Canvas settings. terraform: show cloud details (resource types, regions, warnings, Terraform). Off unless turned on. */
  settings: z.object({ terraform: z.boolean().optional() }).optional(),
});

export type DiagramNode = z.infer<typeof NodeSchema>;
export type DiagramEdge = z.infer<typeof EdgeSchema>;
export type DiagramModel = z.infer<typeof DiagramModelSchema>;
export type Protocol = (typeof PROTOCOLS)[number];

export const emptyModel = (): DiagramModel => ({ schemaVersion: 1, nodes: [], edges: [], layout: {} });

export function nodeById(m: DiagramModel, id: string): DiagramNode | undefined {
  return m.nodes.find((n) => n.id === id);
}

export function childrenOf(m: DiagramModel, id: string | undefined): DiagramNode[] {
  return m.nodes.filter((n) => n.parentId === id);
}

/** Ancestors from nearest to furthest. */
export function ancestorsOf(m: DiagramModel, id: string): DiagramNode[] {
  const out: DiagramNode[] = [];
  const seen = new Set<string>();
  let cur = nodeById(m, id);
  while (cur?.parentId && !seen.has(cur.parentId)) {
    seen.add(cur.parentId);
    const p = nodeById(m, cur.parentId);
    if (!p) break;
    out.push(p);
    cur = p;
  }
  return out;
}

export function nearestAncestor(m: DiagramModel, id: string, kind: string): DiagramNode | undefined {
  return ancestorsOf(m, id).find((a) => a.kind === kind);
}
