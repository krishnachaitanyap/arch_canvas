import type { DiagramEdge, DiagramModel, DiagramNode } from "./model.js";

/**
 * Live collaboration: changes travel as patches of whole items (a node, a line, a position),
 * not whole diagrams. Two people editing different items never overwrite each other; when
 * both change the same item at once, the later change wins for that item.
 */
type Layout = DiagramModel["layout"][string];

export interface ModelPatch {
  nodes?: { set?: DiagramNode[]; del?: string[] };
  edges?: { set?: DiagramEdge[]; del?: string[] };
  layout?: { set?: Record<string, Layout>; del?: string[] };
  /** Tabs and canvas settings are small: sent whole when they change (null = removed). */
  pages?: DiagramModel["pages"] | null;
  settings?: DiagramModel["settings"] | null;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function diffList<T extends { id: string }>(a: T[], b: T[]): { set?: T[]; del?: string[] } | undefined {
  const before = new Map(a.map((x) => [x.id, x]));
  const after = new Set(b.map((x) => x.id));
  const set = b.filter((x) => !same(before.get(x.id), x));
  const del = a.filter((x) => !after.has(x.id)).map((x) => x.id);
  return set.length || del.length ? { ...(set.length ? { set } : {}), ...(del.length ? { del } : {}) } : undefined;
}

/** What changed from a to b, or null when nothing did. */
export function diffPatch(a: DiagramModel, b: DiagramModel): ModelPatch | null {
  const p: ModelPatch = {};
  const nodes = diffList(a.nodes, b.nodes);
  const edges = diffList(a.edges, b.edges);
  if (nodes) p.nodes = nodes;
  if (edges) p.edges = edges;
  const lset: Record<string, Layout> = {};
  for (const [id, l] of Object.entries(b.layout)) if (!same(a.layout[id], l)) lset[id] = l;
  const ldel = Object.keys(a.layout).filter((id) => !(id in b.layout));
  if (Object.keys(lset).length || ldel.length) p.layout = { ...(Object.keys(lset).length ? { set: lset } : {}), ...(ldel.length ? { del: ldel } : {}) };
  if (!same(a.pages ?? null, b.pages ?? null)) p.pages = b.pages ?? null;
  if (!same(a.settings ?? null, b.settings ?? null)) p.settings = b.settings ?? null;
  return Object.keys(p).length ? p : null;
}

function applyList<T extends { id: string }>(list: T[], change: { set?: T[]; del?: string[] } | undefined): T[] {
  if (!change) return list;
  const del = new Set(change.del ?? []);
  const set = new Map((change.set ?? []).map((x) => [x.id, x]));
  const out = list.filter((x) => !del.has(x.id)).map((x) => set.get(x.id) ?? x);
  const have = new Set(out.map((x) => x.id));
  for (const x of change.set ?? []) if (!have.has(x.id) && !del.has(x.id)) out.push(x);
  return out;
}

/**
 * Applies a patch, then repairs what concurrent edits can leave behind: items inside a group
 * someone else deleted move to the top level, lines to deleted items go, positions of deleted
 * items go.
 */
export function applyPatch(m: DiagramModel, p: ModelPatch): DiagramModel {
  let nodes = applyList(m.nodes, p.nodes);
  const ids = new Set(nodes.map((n) => n.id));
  nodes = nodes.map((n) => (n.parentId && !ids.has(n.parentId) ? (({ parentId: _p, ...rest }) => rest)(n) : n));
  const edges = applyList(m.edges, p.edges).filter((e) => ids.has(e.from) && ids.has(e.to));
  const layout = { ...m.layout };
  for (const id of p.layout?.del ?? []) delete layout[id];
  Object.assign(layout, p.layout?.set ?? {});
  for (const id of Object.keys(layout)) if (!ids.has(id)) delete layout[id];
  const out: DiagramModel = { ...m, nodes, edges, layout };
  if (p.pages !== undefined) {
    if (p.pages === null) delete out.pages;
    else out.pages = p.pages;
  }
  if (p.settings !== undefined) {
    if (p.settings === null) delete out.settings;
    else out.settings = p.settings;
  }
  return out;
}

/** Colours for people's cursors, by their id. */
const PEOPLE = ["#e11d48", "#2563eb", "#16a34a", "#d97706", "#7c3aed", "#0891b2", "#db2777", "#4f46e5"];
export function personColor(id: string): string {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return PEOPLE[h % PEOPLE.length];
}
