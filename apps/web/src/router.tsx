import { type MouseEvent, type ReactNode, useSyncExternalStore } from "react";

/**
 * Minimal URL routing on the History API (react-router's current major needs React 19).
 * Paths are app paths ("/d/123"); the deploy base (e.g. "/arch_canvas" on GitHub Pages) is
 * added and stripped here.
 *
 *   /                                 → last workspace
 *   /w/:ws                            → its first (or last used) project
 *   /w/:ws/p/:project                 → project page
 *   /w/:ws/p/:project/new/:kind       → new diagram (cloud | sample | whiteboard | import)
 *   /d/:id                            → editor          (?tab=flows|terraform|…)
 *   /d/:id/history                    → version history and compare
 *   /d/:id/present                    → presentation    (?wf=<workflow index>)
 */
export type NewKind = "cloud" | "sample" | "whiteboard" | "import";
export type Route =
  | { name: "root" }
  | { name: "workspace"; ws: string }
  | { name: "project"; ws: string; project: string }
  | { name: "new"; ws: string; project: string; kind: NewKind }
  | { name: "diagram"; id: string; view: "edit" | "history" | "present" }
  | { name: "notfound" };

export function parseRoute(path: string): Route {
  const s = path.split("/").filter(Boolean).map(decodeURIComponent);
  if (!s.length) return { name: "root" };
  if (s[0] === "w" && s[1]) {
    if (s.length === 2) return { name: "workspace", ws: s[1] };
    if (s[2] === "p" && s[3]) {
      if (s.length === 4) return { name: "project", ws: s[1], project: s[3] };
      if (s[4] === "new" && ["cloud", "sample", "whiteboard", "import"].includes(s[5])) return { name: "new", ws: s[1], project: s[3], kind: s[5] as NewKind };
    }
  }
  if (s[0] === "d" && s[1] && s.length <= 3) {
    const view = (s[2] ?? "edit") as "edit" | "history" | "present";
    if (["edit", "history", "present"].includes(view)) return { name: "diagram", id: s[1], view };
  }
  return { name: "notfound" };
}

export const paths = {
  workspace: (ws: string) => `/w/${ws}`,
  project: (ws: string, project: string) => `/w/${ws}/p/${project}`,
  newDiagram: (ws: string, project: string, kind: NewKind) => `/w/${ws}/p/${project}/new/${kind}`,
  diagram: (id: string, view: "edit" | "history" | "present" = "edit", query = "") => `/d/${id}${view === "edit" ? "" : `/${view}`}${query}`,
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

/** Return false to keep the user where they are (e.g. unsaved changes they didn't want to drop). */
let blocker: ((toPath: string) => boolean) | null = null;
export function setNavigationBlocker(fn: ((toPath: string) => boolean) | null): void {
  blocker = fn;
}

window.addEventListener("popstate", () => {
  const next = read();
  if (blocker && !blocker(next.path)) {
    // Undo the browser's back/forward.
    window.history.pushState(snapshot.state, "", href(snapshot.full));
    return;
  }
  snapshot = next;
  emit();
});

export function navigate(to: string, opts: { replace?: boolean; state?: unknown; force?: boolean } = {}): boolean {
  const toPath = to.split("?")[0];
  if (!opts.force && blocker && toPath !== snapshot.path && !blocker(toPath)) return false;
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
