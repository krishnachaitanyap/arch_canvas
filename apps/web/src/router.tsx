import { type MouseEvent, type ReactNode, useSyncExternalStore } from "react";

/**
 * Minimal URL routing on the History API (react-router's current major needs React 19).
 * Paths are app paths ("/dashboard"); the deploy base (e.g. "/arch_canvas" on GitHub Pages) is
 * added and stripped here. URLs use readable slugs, never raw ids:
 *
 *   /dashboard                                  → the last project you used
 *   /dashboard/:workspace                       → its first (or last used) project
 *   /dashboard/:workspace/:project              → project page
 *   /dashboard/:workspace/:project/new/:kind    → new diagram (cloud | sample | whiteboard | import)
 *   /d/:title-slug-:shortid                     → editor          (?tab=flows|terraform|…)
 *   /d/:title-slug-:shortid/history             → version history and compare
 *   /d/:title-slug-:shortid/present             → presentation    (?wf=<workflow index>)
 *
 * Workspace and project slugs come from their names ("Default workspace" → default-workspace,
 * "-2" on clashes). A diagram's short id is the first 8 characters of its id, so its link
 * survives renames. Old /w/:uuid/p/:uuid links still work and are redirected.
 */
export type NewKind = "cloud" | "sample" | "whiteboard" | "import";
export type Route =
  | { name: "root" }
  | { name: "dashboard" }
  | { name: "workspace"; ws: string }
  | { name: "project"; ws: string; project: string }
  | { name: "new"; ws: string; project: string; kind: NewKind }
  | { name: "diagram"; ref: string; view: "edit" | "history" | "present" }
  | { name: "legacy"; wsId: string; projectId?: string; tail: string[] }
  | { name: "notfound" };

const KINDS = ["cloud", "sample", "whiteboard", "import"];
const VIEWS = ["edit", "history", "present"];

export function parseRoute(path: string): Route {
  const s = path.split("/").filter(Boolean).map(decodeURIComponent);
  if (!s.length) return { name: "root" };
  if (s[0] === "dashboard") {
    if (s.length === 1) return { name: "dashboard" };
    if (s.length === 2) return { name: "workspace", ws: s[1] };
    if (s.length === 3) return { name: "project", ws: s[1], project: s[2] };
    if (s.length === 5 && s[3] === "new" && KINDS.includes(s[4])) return { name: "new", ws: s[1], project: s[2], kind: s[4] as NewKind };
  }
  if (s[0] === "d" && s[1] && s.length <= 3) {
    const view = (s[2] ?? "edit") as "edit" | "history" | "present";
    if (VIEWS.includes(view)) return { name: "diagram", ref: s[1], view };
  }
  if (s[0] === "w" && s[1]) return { name: "legacy", wsId: s[1], projectId: s[2] === "p" ? s[3] : undefined, tail: s.slice(4) };
  return { name: "notfound" };
}

/** "Orders API (v2)" → "orders-api-v2". */
export function slugify(name: string): string {
  return (
    name
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "untitled"
  );
}

/** Stable slugs for a list of named things: name-based, "-2", "-3"… on clashes (ordered by id). */
export function slugMap(items: { id: string; name: string }[]): { slugOf: Map<string, string>; idOf: Map<string, string> } {
  const slugOf = new Map<string, string>();
  const idOf = new Map<string, string>();
  for (const it of [...items].sort((a, b) => a.id.localeCompare(b.id))) {
    const base = slugify(it.name);
    let slug = base;
    for (let i = 2; idOf.has(slug); i++) slug = `${base}-${i}`;
    slugOf.set(it.id, slug);
    idOf.set(slug, it.id);
  }
  return { slugOf, idOf };
}

/** "/d/gcp-web-app-612b054b": the title for people, the short id for lookups. */
export const diagramRef = (title: string, id: string) => `${slugify(title).slice(0, 48)}-${id.slice(0, 8)}`;

/** The id part of a diagram ref: a full UUID, or the 8+ hex characters after the last dash. */
export function refId(ref: string): string {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ref)) return ref.toLowerCase();
  return (ref.match(/([0-9a-f]{8,})$/i)?.[1] ?? ref).toLowerCase();
}

export const paths = {
  dashboard: () => "/dashboard",
  workspace: (ws: string) => `/dashboard/${ws}`,
  project: (ws: string, project: string) => `/dashboard/${ws}/${project}`,
  newDiagram: (ws: string, project: string, kind: NewKind) => `/dashboard/${ws}/${project}/new/${kind}`,
  diagram: (ref: string, view: "edit" | "history" | "present" = "edit", query = "") => `/d/${ref}${view === "edit" ? "" : `/${view}`}${query}`,
};

const BASE = import.meta.env.BASE_URL.replace(/\/+$/, "");
export const href = (to: string) => `${BASE}${to}`;

export interface Location {
  path: string;
  search: URLSearchParams;
  /** path + query, for comparisons and restoring. */
  full: string;
  state: unknown;
}

function read(): Location {
  let path = window.location.pathname;
  if (BASE && path.startsWith(BASE)) path = path.slice(BASE.length) || "/";
  return { path, search: new URLSearchParams(window.location.search), full: path + window.location.search, state: window.history.state };
}

let snapshot = read();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

/**
 * Return false to keep the user where they are (e.g. unsaved changes they didn't want to drop),
 * or a promise when it asks them first (an in-app dialog): navigation continues if it resolves true.
 */
type Blocker = (toPath: string) => boolean | Promise<boolean>;
let blocker: Blocker | null = null;
export function setNavigationBlocker(fn: Blocker | null): void {
  blocker = fn;
}

window.addEventListener("popstate", () => {
  const next = read();
  const ok = blocker ? blocker(next.path) : true;
  if (ok !== true) {
    // Undo the browser's back/forward; go there after all if they confirm.
    window.history.pushState(snapshot.state, "", href(snapshot.full));
    if (ok instanceof Promise) void ok.then((yes) => yes && navigate(next.full, { force: true }));
    return;
  }
  snapshot = next;
  emit();
});

export function navigate(to: string, opts: { replace?: boolean; state?: unknown; force?: boolean } = {}): boolean {
  const toPath = to.split("?")[0];
  if (!opts.force && blocker && toPath !== snapshot.path) {
    const ok = blocker(toPath);
    if (ok instanceof Promise) {
      void ok.then((yes) => yes && navigate(to, { ...opts, force: true }));
      return false;
    }
    if (!ok) return false;
  }
  if (to === snapshot.full && !opts.state) return true;
  window.history[opts.replace ? "replaceState" : "pushState"](opts.state ?? null, "", href(to));
  snapshot = read();
  emit();
  return true;
}

export function useLocation(): Location {
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => snapshot,
  );
}

/** A real link (open in new tab, copy address) that navigates in-app on a plain click. */
export function Link({ to, children, className, title, onNavigate }: { to: string; children: ReactNode; className?: string; title?: string; onNavigate?: () => void }) {
  return (
    <a
      href={href(to)}
      className={className}
      title={title}
      onClick={(e: MouseEvent) => {
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        if (navigate(to)) onNavigate?.();
      }}
    >
      {children}
    </a>
  );
}
