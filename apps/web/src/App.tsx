import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type DiagramModel, emptyModel, SAMPLE_MODEL } from "@archcanvas/shared";
import { resetDemo } from "./demo-api";
import { api, type AppConfig, type Diagram, type DiagramKind, devUser, type Project, type Role, setDevUser, type Workspace } from "./api";
import { Home } from "./home/Home";
import { setWorkspacePacks } from "./icons/registry";
import type { CurrentState } from "./history/VersionHistory";
import { diagramRef, Link, navigate, type NewKind, parseRoute, paths, refId, setNavigationBlocker, slugMap, useLocation } from "./router";

// Each editor is its own chunk: the whiteboard pulls in Excalidraw + Mermaid, the cloud editor React Flow + ELK.
const CloudEditor = lazy(() => import("./cloud/CloudEditor").then((m) => ({ default: m.CloudEditor })));
const WhiteboardEditor = lazy(() => import("./whiteboard/WhiteboardEditor").then((m) => ({ default: m.WhiteboardEditor })));
const VersionHistory = lazy(() => import("./history/VersionHistory").then((m) => ({ default: m.VersionHistory })));

interface Doc {
  /** Bumped to remount the editor when another diagram (or a restored version) is loaded. */
  key: number;
  id: string | null;
  /** For unsaved new diagrams: the route that created it. */
  newRoute?: string;
  workspaceId: string;
  projectId: string;
  kind: DiagramKind;
  title: string;
  loaded: Diagram | null;
  model: DiagramModel;
  role: Role;
  version: number | null;
  /** Just imported from a file: open on the Flows tab. */
  imported?: boolean;
}

type Status = { kind: "ok" | "error"; text: string } | null;
interface PendingImport {
  title: string;
  model: DiagramModel;
  fileName: string;
}

const LS_WS = "archcanvas.workspace";
const LS_PROJECT = "archcanvas.project";
let nextKey = 1;

export function App() {
  const loc = useLocation();
  const route = parseRoute(loc.path);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[] | null>(null);
  const [projects, setProjects] = useState<{ ws: string; list: Project[] } | null>(null);
  const [doc, setDoc] = useState<Doc | null>(null);
  const [status, setStatus] = useState<Status>(null);
  const [toolbar, setToolbar] = useState<HTMLElement | null>(null);
  const currentRef = useRef<(() => CurrentState) | null>(null);
  const pendingImport = useRef<PendingImport | null>(null);

  const registerCurrent = useCallback((fn: () => CurrentState) => {
    currentRef.current = fn;
  }, []);
  const getCurrent = useCallback(() => currentRef.current?.() ?? null, []);

  // Which workspace / project is in view comes from the URL slugs (or from the open diagram);
  // /dashboard shows the one you used last.
  const wsSlugs = useMemo(() => slugMap((workspaces ?? []).map((w) => ({ id: w.id, name: w.name }))), [workspaces]);
  const lastWs = workspaces?.find((w) => w.id === localStorage.getItem(LS_WS))?.id ?? workspaces?.[0]?.id ?? null;
  const wsId =
    route.name === "workspace" || route.name === "project" || route.name === "new"
      ? (wsSlugs.idOf.get(route.ws) ?? null)
      : route.name === "diagram"
        ? (doc?.workspaceId ?? null)
        : route.name === "dashboard"
          ? lastWs
          : null;
  const workspace = workspaces?.find((w) => w.id === wsId) ?? null;
  const projectList = projects && projects.ws === wsId ? projects.list : [];
  const projSlugs = useMemo(() => slugMap(projectList.map((p) => ({ id: p.id, name: p.name }))), [projectList]);
  const defaultProject = projectList.find((p) => p.id === localStorage.getItem(LS_PROJECT))?.id ?? projectList[0]?.id ?? null;
  const projectId =
    route.name === "project" || route.name === "new"
      ? (projSlugs.idOf.get(route.project) ?? null)
      : route.name === "diagram"
        ? (doc?.projectId ?? null)
        : route.name === "dashboard" || route.name === "workspace"
          ? defaultProject
          : null;
  const project = projectList.find((p) => p.id === projectId) ?? null;
  const wsSlug = (id: string | null | undefined) => (id ? (wsSlugs.slugOf.get(id) ?? id) : "");
  const projSlug = (id: string | null | undefined) => (id ? (projSlugs.slugOf.get(id) ?? id) : "");
  const projectPath = (ws: string | null | undefined, p: string | null | undefined) => (ws && p ? paths.project(wsSlug(ws), projSlug(p)) : ws ? paths.workspace(wsSlug(ws)) : paths.dashboard());
  const docRef = doc?.id ? diagramRef(doc.loaded?.title ?? doc.title, doc.id) : null;

  const loadWorkspaces = useCallback(async () => {
    try {
      setWorkspaces(await api.workspaces());
    } catch (e) {
      setStatus({ kind: "error", text: (e as Error).message });
      setWorkspaces([]);
    }
  }, []);

  const loadProjects = useCallback(async (ws: string) => {
    try {
      setProjects({ ws, list: await api.projects(ws) });
    } catch (e) {
      setStatus({ kind: "error", text: (e as Error).message });
      setProjects({ ws, list: [] });
    }
  }, []);

  useEffect(() => {
    api.config().then(setConfig, () => setConfig(null));
    void loadWorkspaces();
  }, [loadWorkspaces]);

  useEffect(() => {
    if (wsId && projects?.ws !== wsId) void loadProjects(wsId);
    if (wsId) localStorage.setItem(LS_WS, wsId);
  }, [wsId, projects?.ws, loadProjects]);
  useEffect(() => {
    if (projectId) localStorage.setItem(LS_PROJECT, projectId);
  }, [projectId]);

  // "/" → /dashboard; old /w/:uuid/p/:uuid links → slug URLs; unknown slugs → /dashboard.
  useEffect(() => {
    if (!workspaces) return;
    if (route.name === "root") return void navigate(paths.dashboard(), { replace: true, force: true });
    if (route.name === "notfound") {
      setStatus({ kind: "error", text: `Nothing at ${loc.path}` });
      return void navigate(paths.dashboard(), { replace: true, force: true });
    }
    if (route.name === "legacy") {
      const ws = workspaces.find((w) => w.id === route.wsId);
      if (!ws) return void navigate(paths.dashboard(), { replace: true, force: true });
      if (!route.projectId) return void navigate(paths.workspace(wsSlug(ws.id)), { replace: true, force: true });
      if (projects?.ws !== ws.id) return void loadProjects(ws.id);
      const p = projects.list.find((x) => x.id === route.projectId);
      const pSlug = p ? slugMap(projects.list.map((x) => ({ id: x.id, name: x.name }))).slugOf.get(p.id) : undefined;
      return void navigate(pSlug ? paths.project(wsSlug(ws.id), pSlug) : paths.workspace(wsSlug(ws.id)), { replace: true, force: true });
    }
    if ((route.name === "workspace" || route.name === "project" || route.name === "new") && !wsSlugs.idOf.has(route.ws)) {
      setStatus({ kind: "error", text: "That workspace doesn't exist or you don't have access." });
      return void navigate(paths.dashboard(), { replace: true, force: true });
    }
    if ((route.name === "project" || route.name === "new") && projects?.ws === wsId && !projSlugs.idOf.has(route.project)) {
      setStatus({ kind: "error", text: "That project doesn't exist." });
      return void navigate(paths.workspace(route.ws), { replace: true, force: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loc.path, workspaces, projects]);

  // Load or create the document the URL points at.
  const routeKey = loc.path;
  useEffect(() => {
    if (route.name === "diagram") {
      const short = refId(route.ref);
      if (doc?.id?.startsWith(short)) return;
      let cancelled = false;
      const id = short.length === 36 ? Promise.resolve(short) : api.lookupDiagram(short).then((r) => r.id);
      void id.then(api.getDiagram).then(
        (d) => {
          if (cancelled) return;
          currentRef.current = null;
          setDoc(docFrom(d));
          // Canonical link: current title slug + short id (old or hand-typed links still work).
          const canonical = diagramRef(d.title, d.id);
          if (route.ref !== canonical) navigate(paths.diagram(canonical, route.view, window.location.search), { replace: true, force: true });
        },
        (e) => {
          if (cancelled) return;
          setStatus({ kind: "error", text: (e as Error).message });
          navigate("/", { replace: true, force: true });
        },
      );
      return () => {
        cancelled = true;
      };
    }
    if (route.name === "new") {
      if (doc && !doc.id && doc.newRoute === routeKey) return;
      if (!workspaces || !wsId || !projectId) return; // wait until the slugs resolve
      const role = workspaces.find((w) => w.id === wsId)?.role;
      if (!role) {
        setStatus({ kind: "error", text: "That workspace doesn't exist or you don't have access." });
        navigate("/", { replace: true, force: true });
        return;
      }
      if (role === "viewer") {
        setStatus({ kind: "error", text: "Viewers can't create diagrams in this workspace." });
        navigate(paths.project(route.ws, route.project), { replace: true, force: true });
        return;
      }
      const ws = wsId;
      const proj = projectId;
      currentRef.current = null;
      if (route.kind === "import") {
        const p = pendingImport.current;
        if (!p) {
          // Imports live in memory until saved; after a refresh there is nothing to show.
          navigate(paths.project(route.ws, route.project), { replace: true, force: true });
          return;
        }
        setDoc({ key: nextKey++, id: null, newRoute: routeKey, workspaceId: ws, projectId: proj, kind: "cloud", title: p.title, loaded: null, model: p.model, role, version: null, imported: true });
        const n = p.model.nodes.length;
        setStatus({ kind: "ok", text: `Imported ${n} item${n === 1 ? "" : "s"} from ${p.fileName}. Check Flows, Terraform and Review, then Save.` });
        return;
      }
      setDoc({
        key: nextKey++,
        id: null,
        newRoute: routeKey,
        workspaceId: ws,
        projectId: proj,
        kind: route.kind === "whiteboard" ? "whiteboard" : "cloud",
        title: route.kind === "whiteboard" ? "Untitled whiteboard" : route.kind === "sample" ? "GCP web app (sample)" : "Untitled architecture",
        loaded: null,
        model: route.kind === "sample" ? structuredClone(SAMPLE_MODEL) : emptyModel(),
        role,
        version: null,
      });
      return;
    }
    if (doc) {
      setDoc(null);
      currentRef.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeKey, workspaces, wsId, projectId]);

  useEffect(() => {
    if (status?.kind !== "ok") return;
    const t = setTimeout(() => setStatus(null), 3500);
    return () => clearTimeout(t);
  }, [status]);

  // Overlays (history, presentation) start below the top bar, whose height varies (demo banner).
  useEffect(() => {
    const bar = document.querySelector(".topbar");
    if (!bar) return;
    const set = () => document.documentElement.style.setProperty("--chrome-h", `${Math.round(bar.getBoundingClientRect().bottom)}px`);
    set();
    const ro = new ResizeObserver(set);
    ro.observe(document.body);
    return () => ro.disconnect();
  }, [config]);

  // Unsaved changes: warn on tab close, and on in-app navigation away from the diagram.
  useEffect(() => {
    const onUnload = (e: BeforeUnloadEvent) => {
      if (doc && getCurrent()?.dirty) e.preventDefault();
    };
    window.addEventListener("beforeunload", onUnload);
    const here = doc?.newRoute;
    setNavigationBlocker(
      doc
        ? (to) => {
            const seg = to.split("/");
            const staying = doc.id ? seg[1] === "d" && Boolean(seg[2]) && doc.id.startsWith(refId(seg[2])) : to === here;
            return staying || !getCurrent()?.dirty || confirm("You have unsaved changes. Leave without saving?");
          }
        : null,
    );
    return () => {
      window.removeEventListener("beforeunload", onUnload);
      setNavigationBlocker(null);
    };
  }, [doc, getCurrent]);

  // Icon packs uploaded to the workspace in view.
  const reloadIconPacks = useCallback(async () => {
    if (!wsId) return setWorkspacePacks([]);
    await api.iconPacks(wsId).then(setWorkspacePacks, () => setWorkspacePacks([]));
  }, [wsId]);
  useEffect(() => {
    void reloadIconPacks();
  }, [reloadIconPacks]);

  /** Refresh lists after changes; optionally go to a workspace / project. */
  const reload = useCallback(
    async (select: { workspaceId?: string; projectId?: string } = {}) => {
      const ws = await api.workspaces().catch(() => null);
      if (ws) setWorkspaces(ws);
      const target = select.workspaceId ?? wsId ?? ws?.[0]?.id;
      if (!target || (ws && !ws.some((w) => w.id === target))) return void navigate("/", { replace: true, force: true });
      const list = await api.projects(target).catch(() => [] as Project[]);
      setProjects({ ws: target, list });
      const wsS = slugMap((ws ?? workspaces ?? []).map((w) => ({ id: w.id, name: w.name }))).slugOf.get(target) ?? target;
      const pS = slugMap(list.map((p) => ({ id: p.id, name: p.name }))).slugOf;
      if (select.workspaceId || select.projectId) {
        const p = list.find((x) => x.id === select.projectId) ?? list.find((x) => x.id === projectId) ?? list[0];
        navigate(p ? paths.project(wsS, pS.get(p.id)!) : paths.workspace(wsS));
      } else if (route.name !== "dashboard" && route.name !== "workspace") {
        // Renamed or deleted: keep the URL in step with the new slugs.
        const p = list.find((x) => x.id === projectId) ?? list[0];
        navigate(p ? paths.project(wsS, pS.get(p.id)!) : paths.workspace(wsS), { replace: true, force: true });
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [wsId, projectId, workspaces, route.name],
  );

  const onSaved = (d: Diagram) => {
    setDoc((cur) => (cur ? { ...cur, id: d.id, version: d.version, newRoute: undefined } : cur));
    if (!doc?.id || d.title !== doc.loaded?.title) navigate(paths.diagram(diagramRef(d.title, d.id), view, window.location.search), { replace: true, force: true });
    if (wsId) void loadProjects(wsId);
  };

  const canEdit = doc?.role === "owner" || doc?.role === "editor";
  const view = route.name === "diagram" ? route.view : "edit";
  const tab = loc.search.get("tab") ?? undefined;
  const homePath = projectPath(wsId, projectId);

  return (
    <div className="app">
      {config?.demo && (
        <div className="demo-banner">
          <span>
            <b>Live demo</b> · runs entirely in your browser; your changes stay on this device. The AI assistant and terraform validate need the server:{" "}
            <a href="https://github.com/krishnachaitanyap/arch_canvas#run-locally" target="_blank" rel="noreferrer">
              run it locally
            </a>
            .
          </span>
          <button
            className="link"
            onClick={() => {
              if (confirm("Reset the demo? Your changes in this browser are deleted and the examples come back.")) {
                resetDemo();
                window.location.href = `${import.meta.env.BASE_URL}`;
              }
            }}
          >
            Reset demo data
          </button>
        </div>
      )}
      <header className="topbar">
        <Link to={homePath} className="logo" title="Project page">
          ArchCanvas
        </Link>
        {doc ? (
          <>
            <nav className="crumbs">
              <Link to={paths.workspace(wsSlug(doc.workspaceId))}>{doc.loaded?.workspace_name ?? workspace?.name ?? "Workspace"}</Link>
              <span>/</span>
              <Link to={projectPath(doc.workspaceId, doc.projectId)}>{doc.loaded?.project_name ?? project?.name ?? "Project"}</Link>
              <span>/</span>
            </nav>
            <input
              className="title"
              value={doc.title}
              disabled={!canEdit}
              onChange={(e) => setDoc((d) => d && { ...d, title: e.target.value })}
              aria-label="Diagram title"
            />
            <span className="kind-pill">{doc.kind === "cloud" ? "GCP architecture" : "Whiteboard"}</span>
            {doc.id ? (
              <Link to={paths.diagram(docRef!, "history")} className="version-badge" title="Version history and compare">
                {doc.version ? `v${doc.version}` : "v?"} · History
              </Link>
            ) : (
              <span className="version-badge disabled">unsaved</span>
            )}
          </>
        ) : (
          <span className="hint">{workspace ? `${workspace.name}${project ? ` / ${project.name}` : ""}` : ""}</span>
        )}
        <div className="spacer" />
        {status && (
          <div className={`status ${status.kind}`} role={status.kind === "error" ? "alert" : "status"}>
            <span>{status.text}</span>
            <button className="link" onClick={() => setStatus(null)} aria-label="Dismiss">
              ✕
            </button>
          </div>
        )}
        <div className="toolbar-slot" ref={setToolbar} />
        {config?.devUser && (
          <label className="dev-user" title="Dev mode (no OIDC): act as another user to try workspace roles">
            as
            <input
              defaultValue={devUser() ?? config.devUser}
              onBlur={(e) => {
                const v = e.target.value.trim();
                if (v === (devUser() ?? config.devUser)) return;
                setDevUser(v && v !== config.devUser ? v : null);
                setProjects(null);
                void loadWorkspaces().then(() => navigate("/", { force: true }));
              }}
              onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
              aria-label="Acting user (dev mode)"
            />
          </label>
        )}
      </header>

      {doc ? (
        <Suspense fallback={<div className="loading">Loading editor…</div>}>
          {doc.kind === "cloud" ? (
            <CloudEditor
              key={doc.key}
              diagramId={doc.id}
              projectId={doc.projectId}
              canEdit={canEdit}
              registerCurrent={registerCurrent}
              title={doc.title}
              toolbar={toolbar}
              setStatus={setStatus}
              onSaved={onSaved}
              initial={doc.model}
              config={config}
              initialTab={(tab as never) ?? (doc.imported && doc.model.edges.length ? "flows" : undefined)}
              onTabChange={(t) => {
                const base = docRef ? paths.diagram(docRef) : (doc.newRoute ?? loc.path);
                navigate(t === "assistant" ? base : `${base}?tab=${t}`, { replace: true, force: true });
              }}
              presenting={view === "present" ? { start: loc.search.get("wf") ? Number(loc.search.get("wf")) : undefined } : null}
              onPresent={(start) =>
                docRef ? navigate(paths.diagram(docRef, "present", start !== undefined ? `?wf=${start}` : "")) : setStatus({ kind: "error", text: "Save the diagram to present it." })
              }
              onExitPresent={() => docRef && navigate(paths.diagram(docRef))}
            />
          ) : (
            <WhiteboardEditor
              key={doc.key}
              diagramId={doc.id}
              projectId={doc.projectId}
              canEdit={canEdit}
              registerCurrent={registerCurrent}
              title={doc.title}
              toolbar={toolbar}
              setStatus={setStatus}
              onSaved={onSaved}
              initial={doc.loaded}
            />
          )}
          {view === "history" && doc.id && (
            <VersionHistory
              diagramId={doc.id}
              title={doc.title}
              canEdit={canEdit}
              getCurrent={getCurrent}
              onClose={() => navigate(paths.diagram(docRef!))}
              onRestored={() => {
                currentRef.current = null;
                void api.getDiagram(doc.id!).then((d) => {
                  setDoc({ ...docFrom(d), key: nextKey++ });
                  navigate(paths.diagram(diagramRef(d.title, d.id)), { force: true });
                });
              }}
              onDuplicated={(id) => navigate(paths.diagram(id))}
              setStatus={setStatus}
            />
          )}
        </Suspense>
      ) : route.name === "diagram" || route.name === "new" ? (
        <div className="loading">Loading…</div>
      ) : (
        <Home
          workspaces={workspaces ?? []}
          workspace={workspace}
          projects={projectList}
          project={project}
          me={devUser() ?? config?.devUser ?? ""}
          onWorkspace={(id) => navigate(paths.workspace(wsSlug(id)))}
          projectHref={(id) => projectPath(wsId, id)}
          diagramHref={(id, title, history) => paths.diagram(diagramRef(title, id), history ? "history" : "edit")}
          reload={reload}
          reloadIconPacks={reloadIconPacks}
          onNew={(kind) => wsId && projectId && navigate(paths.newDiagram(wsSlug(wsId), projSlug(projectId), kind as NewKind))}
          onImport={(title, model, fileName) => {
            if (!wsId || !projectId) return;
            pendingImport.current = { title, model, fileName };
            navigate(paths.newDiagram(wsSlug(wsId), projSlug(projectId), "import"));
          }}
          setStatus={setStatus}
        />
      )}
    </div>
  );
}

function docFrom(d: Diagram): Doc {
  return {
    key: nextKey++,
    id: d.id,
    workspaceId: d.workspace_id!,
    projectId: d.project_id,
    kind: d.kind,
    title: d.title,
    loaded: d,
    model: d.model ?? emptyModel(),
    role: d.role ?? "viewer",
    version: d.version,
  };
}
