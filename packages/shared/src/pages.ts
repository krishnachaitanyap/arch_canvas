import type { DiagramModel, DiagramNode } from "./model.js";

/**
 * Canvas tabs (pages). A diagram without `pages` has one page, "Page 1". Top-level items say
 * which page they're on (`page`, first page when unset); items inside a group are on the
 * group's page. Lines only join items on the same page.
 */
export type Page = { id: string; name: string };
export const DEFAULT_PAGE: Page = { id: "page-1", name: "Page 1" };

export function pagesOf(m: DiagramModel): Page[] {
  return m.pages?.length ? m.pages : [DEFAULT_PAGE];
}

/** The page an item is on (its outermost group's page). */
export function pageOf(m: DiagramModel, id: string): string {
  const first = pagesOf(m)[0].id;
  let n: DiagramNode | undefined = m.nodes.find((x) => x.id === id);
  for (let guard = 0; n?.parentId && guard < 50; guard++) n = m.nodes.find((x) => x.id === n!.parentId);
  const p = n?.page;
  return p && pagesOf(m).some((x) => x.id === p) ? p : first;
}

/** Just one page: its items, the lines between them and their positions. */
export function pageModel(m: DiagramModel, page: string): DiagramModel {
  const ids = new Set(m.nodes.filter((n) => pageOf(m, n.id) === page).map((n) => n.id));
  return {
    ...m,
    nodes: m.nodes.filter((n) => ids.has(n.id)),
    edges: m.edges.filter((e) => ids.has(e.from) && ids.has(e.to)),
    layout: Object.fromEntries(Object.entries(m.layout).filter(([id]) => ids.has(id))),
  };
}

export function pageIdFor(name: string, taken: string[]): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "page";
  let id = /^[a-z0-9]/.test(base) ? base : `p-${base}`;
  for (let i = 2; taken.includes(id); i++) id = `${base}-${i}`;
  return id;
}

/** Adds a page (after the others) and returns the new model and its id. */
export function addPage(m: DiagramModel, name: string): { model: DiagramModel; id: string } {
  const pages = pagesOf(m);
  const id = pageIdFor(name, pages.map((p) => p.id));
  // Items on the implicit first page keep it when the list is written out.
  return { model: { ...m, pages: [...pages, { id, name: name.trim().slice(0, 60) || "Page" }] }, id };
}

export function renamePage(m: DiagramModel, id: string, name: string): DiagramModel {
  const n = name.trim().slice(0, 60);
  if (!n) return m;
  return { ...m, pages: pagesOf(m).map((p) => (p.id === id ? { ...p, name: n } : p)) };
}

export function movePage(m: DiagramModel, id: string, by: number): DiagramModel {
  const pages = [...pagesOf(m)];
  const i = pages.findIndex((p) => p.id === id);
  const j = i + by;
  if (i < 0 || j < 0 || j >= pages.length) return m;
  // The first page is also where items without a page live; pin them to it before reordering.
  const first = pages[0].id;
  const nodes = m.nodes.map((n) => (!n.parentId && !n.page ? { ...n, page: first } : n));
  [pages[i], pages[j]] = [pages[j], pages[i]];
  return { ...m, nodes, pages };
}

/** Removes a page and everything on it (the last page can't be removed). */
export function removePage(m: DiagramModel, id: string): DiagramModel {
  const pages = pagesOf(m);
  if (pages.length < 2) return m;
  const gone = new Set(m.nodes.filter((n) => pageOf(m, n.id) === id).map((n) => n.id));
  const first = pages[0].id;
  const rest = pages.filter((p) => p.id !== id);
  return {
    ...m,
    // Items on the old first page that had no page now need it spelled out.
    nodes: m.nodes.filter((n) => !gone.has(n.id)).map((n) => (!n.parentId && !n.page && first !== id ? { ...n, page: first } : n)),
    edges: m.edges.filter((e) => !gone.has(e.from) && !gone.has(e.to)),
    layout: Object.fromEntries(Object.entries(m.layout).filter(([k]) => !gone.has(k))),
    pages: rest,
  };
}
