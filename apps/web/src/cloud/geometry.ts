import { applyOps, catalogEntry, type DiagramModel, type DiagramNode, NODE_ID, type Op } from "@archcanvas/shared";
import { NODE_H, NODE_W } from "./layout";

/**
 * Canvas geometry on the model. layout[id] is relative to the node's parent group, which is
 * also how React Flow sub-flows and draw.io containers work.
 */
export type Box = { x: number; y: number; w: number; h: number };
type Layout = DiagramModel["layout"];

export const NOTE_W = 200;
export const NOTE_H = 90;
const GROUP_W = 260;
const GROUP_H = 140;
const PAD = 24;
const HEADER = 44;

export const isContainer = (kind: string) => Boolean(catalogEntry(kind)?.container);

export function defaultSize(kind: string): { w: number; h: number } {
  if (kind === "generic.note") return { w: NOTE_W, h: NOTE_H };
  return isContainer(kind) ? { w: GROUP_W, h: GROUP_H } : { w: NODE_W, h: NODE_H };
}

export function sizeOf(m: DiagramModel, n: DiagramNode): { w: number; h: number } {
  const l = m.layout[n.id];
  const d = defaultSize(n.kind);
  return { w: l?.w ?? d.w, h: l?.h ?? d.h };
}

/** Absolute box of a node (sum of positions up the parent chain). */
export function absBox(m: DiagramModel, id: string): Box {
  const n = m.nodes.find((x) => x.id === id);
  if (!n) return { x: 0, y: 0, w: 0, h: 0 };
  const own = m.layout[id] ?? { x: 0, y: 0 };
  const base = n.parentId ? absBox(m, n.parentId) : { x: 0, y: 0 };
  const { w, h } = sizeOf(m, n);
  return { x: base.x + own.x, y: base.y + own.y, w, h };
}

function depth(m: DiagramModel, id: string): number {
  let d = 0;
  for (let n = m.nodes.find((x) => x.id === id); n?.parentId; n = m.nodes.find((x) => x.id === n!.parentId)) d++;
  return d;
}

/** Descendants of a node (children, grandchildren, …). */
export function descendants(m: DiagramModel, id: string): string[] {
  const out: string[] = [];
  const walk = (pid: string) => m.nodes.filter((n) => n.parentId === pid).forEach((n) => (out.push(n.id), walk(n.id)));
  walk(id);
  return out;
}

/**
 * The deepest group under an absolute point that may hold a node of `kind`, ignoring the
 * node itself and its descendants (you can't drop a group into itself).
 */
export function containerAt(m: DiagramModel, p: { x: number; y: number }, kind: string, exclude: string[] = []): DiagramNode | undefined {
  const entry = catalogEntry(kind);
  const skip = new Set(exclude.flatMap((id) => [id, ...descendants(m, id)]));
  return m.nodes
    .filter((n) => isContainer(n.kind) && !skip.has(n.id) && entry?.parents.includes(n.kind))
    .filter((n) => {
      const b = absBox(m, n.id);
      return p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h;
    })
    .sort((a, b) => depth(m, b.id) - depth(m, a.id))[0];
}

/** Grows groups (deepest first) so they contain their children with some padding. */
export function growGroups(m: DiagramModel): Layout {
  const layout: Layout = { ...m.layout };
  const mm = { ...m, layout };
  const groups = m.nodes.filter((n) => isContainer(n.kind)).sort((a, b) => depth(m, b.id) - depth(m, a.id));
  for (const g of groups) {
    const kids = m.nodes.filter((n) => n.parentId === g.id && layout[n.id]);
    if (!kids.length || !layout[g.id]) continue;
    const own = sizeOf(mm, g);
    let w = own.w;
    let h = own.h;
    for (const k of kids) {
      const l = layout[k.id];
      const s = sizeOf(mm, k);
      w = Math.max(w, l.x + s.w + PAD);
      h = Math.max(h, l.y + s.h + PAD);
    }
    if (w !== own.w || h !== own.h) layout[g.id] = { ...layout[g.id], w, h };
  }
  return layout;
}

/** Gives every node without a position one: below its siblings inside its parent. */
export function placeMissing(m: DiagramModel): Layout {
  const layout: Layout = { ...m.layout };
  const mm = { ...m, layout };
  const ordered = [...m.nodes].sort((a, b) => depth(m, a.id) - depth(m, b.id));
  for (const n of ordered) {
    if (layout[n.id]) continue;
    const siblings = m.nodes.filter((s) => s.parentId === n.parentId && s.id !== n.id && layout[s.id]);
    const top = n.parentId ? HEADER : 0;
    const bottom = siblings.reduce((y, s) => Math.max(y, layout[s.id].y + sizeOf(mm, s).h), top - PAD);
    const d = defaultSize(n.kind);
    layout[n.id] = { x: n.parentId ? PAD : 0, y: bottom + PAD, ...(isContainer(n.kind) || n.kind === "generic.note" ? d : {}) };
  }
  return growGroups({ ...m, layout });
}

/** Position for a new node at an absolute point (centred), relative to its parent. */
export function relativeAt(m: DiagramModel, parentId: string | undefined, abs: { x: number; y: number }, kind: string) {
  const d = defaultSize(kind);
  const base = parentId ? absBox(m, parentId) : { x: 0, y: 0 };
  return { x: Math.round(abs.x - base.x - d.w / 2), y: Math.round(abs.y - base.y - d.h / 2) };
}

/** Moves a node into another group (or to the top level) without moving it on screen. */
export function reparentOps(m: DiagramModel, id: string, parentId: string | undefined): { ops: Op[]; layout: (after: DiagramModel) => Layout } {
  const before = absBox(m, id);
  return {
    ops: [{ op: "update_node", id, parentId: parentId ?? null }],
    layout: (after) => {
      const base = parentId ? absBox(after, parentId) : { x: 0, y: 0 };
      const l = { ...after.layout, [id]: { ...m.layout[id], x: Math.round(before.x - base.x), y: Math.round(before.y - base.y) } };
      return growGroups({ ...after, layout: l });
    },
  };
}

export type AlignMode = "left" | "center" | "right" | "top" | "middle" | "bottom" | "hspace" | "vspace";

/** Aligns or spaces nodes using absolute positions, then writes back relative ones. */
export function align(m: DiagramModel, ids: string[], mode: AlignMode): Layout {
  const boxes = ids.map((id) => ({ id, b: absBox(m, id) }));
  if (boxes.length < 2) return m.layout;
  const minX = Math.min(...boxes.map((x) => x.b.x));
  const maxX = Math.max(...boxes.map((x) => x.b.x + x.b.w));
  const minY = Math.min(...boxes.map((x) => x.b.y));
  const maxY = Math.max(...boxes.map((x) => x.b.y + x.b.h));
  const target = new Map<string, { x: number; y: number }>();
  if (mode === "hspace" || mode === "vspace") {
    const horiz = mode === "hspace";
    const sorted = [...boxes].sort((a, b) => (horiz ? a.b.x - b.b.x : a.b.y - b.b.y));
    const total = sorted.reduce((s, x) => s + (horiz ? x.b.w : x.b.h), 0);
    const gap = ((horiz ? maxX - minX : maxY - minY) - total) / (sorted.length - 1);
    let cur = horiz ? minX : minY;
    for (const x of sorted) {
      target.set(x.id, horiz ? { x: cur, y: x.b.y } : { x: x.b.x, y: cur });
      cur += (horiz ? x.b.w : x.b.h) + gap;
    }
  } else
    for (const { id, b } of boxes) {
      const x = mode === "left" ? minX : mode === "right" ? maxX - b.w : mode === "center" ? (minX + maxX) / 2 - b.w / 2 : b.x;
      const y = mode === "top" ? minY : mode === "bottom" ? maxY - b.h : mode === "middle" ? (minY + maxY) / 2 - b.h / 2 : b.y;
      target.set(id, { x, y });
    }
  const layout: Layout = { ...m.layout };
  for (const [id, p] of target) {
    const n = m.nodes.find((x) => x.id === id)!;
    const base = n.parentId ? absBox(m, n.parentId) : { x: 0, y: 0 };
    layout[id] = { ...layout[id], x: Math.round(p.x - base.x), y: Math.round(p.y - base.y) };
  }
  return growGroups({ ...m, layout });
}

// ------------------------------------------------------------------ copy / paste

export interface Clip {
  nodes: DiagramNode[];
  edges: DiagramModel["edges"];
  layout: Layout;
}

/** The selected nodes, everything inside selected groups, and the connections among them. */
export function copySelection(m: DiagramModel, ids: string[]): Clip | null {
  const set = new Set(ids.flatMap((id) => [id, ...descendants(m, id)]));
  const nodes = m.nodes.filter((n) => set.has(n.id));
  if (!nodes.length) return null;
  return {
    nodes: structuredClone(nodes),
    edges: m.edges.filter((e) => set.has(e.from) && set.has(e.to)),
    layout: Object.fromEntries(nodes.map((n) => [n.id, m.layout[n.id] ?? { x: 0, y: 0 }])),
  };
}

/**
 * Pastes a clip with fresh ids, moved by `offset`; top-level pasted nodes land in `parentId`
 * when allowed. With `keepIds`, ids are only changed when they're already taken (imports).
 */
export function pasteOps(
  m: DiagramModel,
  clip: Clip,
  offset: number | { x: number; y: number } = 32,
  parentId?: string,
  keepIds = false,
): { model: DiagramModel; ids: string[] } | { error: string } {
  const dx = typeof offset === "number" ? offset : offset.x;
  const dy = typeof offset === "number" ? offset : offset.y;
  const used = new Set(m.nodes.map((n) => n.id));
  const rename = new Map<string, string>();
  for (const n of clip.nodes) {
    const base = n.id.replace(/(_copy)?(_\d+)?$/, "").slice(0, 34) || "node";
    let id = keepIds ? (used.has(n.id) ? `${base}_2` : n.id) : `${base}_copy`;
    for (let i = 2; used.has(id) || !NODE_ID.test(id); i++) id = keepIds ? `${base}_${i}` : `${base}_copy_${i}`;
    used.add(id);
    rename.set(n.id, id);
  }
  const inClip = new Set(clip.nodes.map((n) => n.id));
  const ops: Op[] = [];
  const order = [...clip.nodes].sort((a, b) => Number(inClip.has(a.parentId ?? "")) - Number(inClip.has(b.parentId ?? "")));
  // Parents first: nodes whose parent is in the clip come after it.
  const placed = new Set<string>();
  const pending = [...order];
  const topLevel: string[] = [];
  while (pending.length) {
    const i = pending.findIndex((n) => !n.parentId || !inClip.has(n.parentId) || placed.has(n.parentId));
    if (i < 0) break;
    const n = pending.splice(i, 1)[0];
    placed.add(n.id);
    const own = n.parentId && inClip.has(n.parentId) ? rename.get(n.parentId) : undefined;
    const fallback = parentId && catalogEntry(n.kind)?.parents.includes(m.nodes.find((x) => x.id === parentId)?.kind ?? "") ? parentId : undefined;
    const parent = own ?? fallback ?? (n.parentId && m.nodes.some((x) => x.id === n.parentId) ? n.parentId : undefined);
    if (!own) topLevel.push(n.id);
    ops.push({ op: "add_node", id: rename.get(n.id)!, kind: n.kind, label: n.label, parentId: parent, props: n.props, ...(n.icon ? { icon: n.icon } : {}) });
  }
  for (const e of clip.edges)
    ops.push({ op: "connect", from: rename.get(e.from)!, to: rename.get(e.to)!, label: e.label, protocol: e.protocol, routing: e.routing });
  const r = applyOps(m, ops);
  if (!r.ok) return { error: r.error };
  const layout: Layout = { ...r.model.layout };
  for (const n of clip.nodes) {
    const l = clip.layout[n.id] ?? { x: 0, y: 0 };
    const isTop = topLevel.includes(n.id);
    layout[rename.get(n.id)!] = { ...l, x: l.x + (isTop ? dx : 0), y: l.y + (isTop ? dy : 0) };
  }
  return { model: { ...r.model, layout: growGroups({ ...r.model, layout }) }, ids: topLevel.map((id) => rename.get(id)!) };
}
