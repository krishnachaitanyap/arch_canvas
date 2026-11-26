import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { type DiagramModel, emptyModel, SAMPLE_MODEL } from "@archcanvas/shared";
import { api, type AppConfig, type Diagram, type DiagramKind, devUser, type Project, type Role, setDevUser, type Workspace } from "./api";
import { Home } from "./home/Home";
import type { CurrentState } from "./history/VersionHistory";

// Each editor is its own chunk: the whiteboard pulls in Excalidraw + Mermaid, the cloud editor React Flow + ELK.
const CloudEditor = lazy(() => import("./cloud/CloudEditor").then((m) => ({ default: m.CloudEditor })));
const WhiteboardEditor = lazy(() => import("./whiteboard/WhiteboardEditor").then((m) => ({ default: m.WhiteboardEditor })));
const VersionHistory = lazy(() => import("./history/VersionHistory").then((m) => ({ default: m.VersionHistory })));

interface Doc {
  /** Bumped to remount the editor when another diagram (or a restored version) is loaded. */
  key: number;
  id: string | null;
  projectId: string | null;
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

const LS_WS = "archcanvas.workspace";
const LS_PROJECT = "archcanvas.project";
let nextKey = 1;

export function App() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [wsId, setWsId] = useState<string | null>(() => localStorage.getItem(LS_WS));
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState<string | null>(() => localStorage.getItem(LS_PROJECT));
  const [doc, setDoc] = useState<Doc | null>(null);
  const [history, setHistory] = useState(false);
  const [status, setStatus] = useState<Status>(null);
  const [toolbar, setToolbar] = useState<HTMLElement | null>(null);
  const currentRef = useRef<(() => CurrentState) | null>(null);

  const workspace = workspaces.find((w) => w.id === wsId) ?? null;
  const project = projects.find((p) => p.id === projectId) ?? null;

  const registerCurrent = useCallback((fn: () => CurrentState) => {
    currentRef.current = fn;
  }, []);
  const getCurrent = useCallback(() => currentRef.current?.() ?? null, []);

  /** Loads workspaces and the selected workspace's projects, keeping (or applying) the selection. */
  const reload = useCallback(
    async (select: { workspaceId?: string; projectId?: string } = {}) => {
      try {
        const ws = await api.workspaces();
        setWorkspaces(ws);
        const w = ws.find((x) => x.id === (select.workspaceId ?? wsId)) ?? ws[0];
        if (!w) return;
        setWsId(w.id);
        localStorage.setItem(LS_WS, w.id);
        const ps = await api.projects(w.id);
        setProjects(ps);
        const p = ps.find((x) => x.id === (select.projectId ?? projectId)) ?? ps[0] ?? null;
        setProjectId(p?.id ?? null);
        if (p) localStorage.setItem(LS_PROJECT, p.id);
      } catch (e) {
        setStatus({ kind: "error", text: (e as Error).message });
      }
    },
    [wsId, projectId],
  );

  useEffect(() => {
    api.config().then(setConfig, () => setConfig(null));
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (status?.kind !== "ok") return;
    const t = setTimeout(() => setStatus(null), 3000);
    return () => clearTimeout(t);
  }, [status]);

  // Warn before closing the tab with unsaved changes.
  useEffect(() => {
    const onUnload = (e: BeforeUnloadEvent) => {
      if (doc && getCurrent()?.dirty) e.preventDefault();
    };
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, [doc, getCurrent]);

  const confirmLeave = () => !doc || !getCurrent()?.dirty || confirm("You have unsaved changes. Leave without saving?");

  async function open(id: string, opts: { history?: boolean } = {}) {
    if (doc?.id !== id && !confirmLeave()) return;
    try {
      const d = await api.getDiagram(id);
      setStatus(null);
      currentRef.current = null;
      setDoc({
        key: nextKey++,
        id: d.id,
        projectId: d.project_id,
        kind: d.kind,
        title: d.title,
        loaded: d,
        model: d.model ?? emptyModel(),
        role: d.role ?? "viewer",
        version: d.version,
      });
      setHistory(Boolean(opts.history));
    } catch (e) {
      setStatus({ kind: "error", text: (e as Error).message });
    }
  }

  function create(kind: DiagramKind | "sample") {
    if (!project || !workspace) return;
    currentRef.current = null;
    setStatus(null);
    setHistory(false);
    setDoc({
      key: nextKey++,
      id: null,
      projectId: project.id,
      kind: kind === "whiteboard" ? "whiteboard" : "cloud",
      title: kind === "whiteboard" ? "Untitled whiteboard" : kind === "sample" ? "GCP web app (sample)" : "Untitled architecture",
      loaded: null,
      model: kind === "sample" ? structuredClone(SAMPLE_MODEL) : emptyModel(),
      role: workspace.role,
      version: null,
    });
  }

  function importDiagram(title: string, model: DiagramModel, fileName: string) {
    if (!project || !workspace) return;
    currentRef.current = null;
    setHistory(false);
    setDoc({ key: nextKey++, id: null, projectId: project.id, kind: "cloud", title, loaded: null, model, role: workspace.role, version: null, imported: true });
    const n = model.nodes.length;
    setStatus({ kind: "ok", text: `Imported ${n} item${n === 1 ? "" : "s"} from ${fileName}. Check Flows, Terraform and Review, then Save.` });
  }

  function goHome() {
    if (!confirmLeave()) return;
    setDoc(null);
    setHistory(false);
    currentRef.current = null;
    void reload();
  }

  const onSaved = (d: Diagram) => {
    setDoc((cur) => (cur ? { ...cur, id: d.id, version: d.version } : cur));
  };

  const canEdit = doc?.role === "owner" || doc?.role === "editor";
  const editorProps = doc && {
    diagramId: doc.id,
    projectId: doc.projectId,
    canEdit,
    registerCurrent,
    title: doc.title,
    toolbar,
    setStatus,
    onSaved,
  };
  const docProject = doc ? projects.find((p) => p.id === doc.projectId) : undefined;

  return (
    <div className="app">
      <header className="topbar">
        <button className="logo" onClick={goHome} title="All projects">
          ArchCanvas
        </button>
        {doc ? (
          <>
            <nav className="crumbs">
              <button className="link" onClick={goHome}>
                {doc.loaded?.workspace_name ?? workspace?.name}
              </button>
              <span>/</span>
              <button className="link" onClick={goHome}>
                {doc.loaded?.project_name ?? docProject?.name}
              </button>
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
            <button className="version-badge" disabled={!doc.id} onClick={() => setHistory(true)} title="Version history and compare">
              {doc.version ? `v${doc.version}` : "unsaved"} · History
            </button>
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
                setDoc(null);
                setHistory(false);
                void reload();
              }}
              onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
              aria-label="Acting user (dev mode)"
            />
          </label>
        )}
      </header>

      {doc && editorProps ? (
        <Suspense fallback={<div className="loading">Loading editor…</div>}>
          {doc.kind === "cloud" ? (
            <CloudEditor key={doc.key} {...editorProps} initial={doc.model} config={config} initialTab={doc.imported && doc.model.edges.length ? "flows" : undefined} />
          ) : (
            <WhiteboardEditor key={doc.key} {...editorProps} initial={doc.loaded} />
          )}
          {history && doc.id && (
            <VersionHistory
              diagramId={doc.id}
              title={doc.title}
              canEdit={canEdit}
              getCurrent={getCurrent}
              onClose={() => setHistory(false)}
              onRestored={() => {
                currentRef.current = null;
                setHistory(false);
                setDoc((d) => d && { ...d, version: null });
                void api.getDiagram(doc.id!).then((d) =>
                  setDoc((cur) => cur && { ...cur, key: nextKey++, loaded: d, model: d.model ?? emptyModel(), version: d.version, kind: d.kind }),
                );
              }}
              onDuplicated={(id) => {
                currentRef.current = null;
                void open(id);
              }}
              setStatus={setStatus}
            />
          )}
        </Suspense>
      ) : (
        <Home
          workspaces={workspaces}
          workspace={workspace}
          projects={projects}
          project={project}
          me={devUser() ?? config?.devUser ?? ""}
          onWorkspace={(id) => void reload({ workspaceId: id })}
          onProject={(id) => {
            setProjectId(id);
            localStorage.setItem(LS_PROJECT, id);
          }}
          reload={reload}
          onOpen={(id, o) => void open(id, o)}
          onNew={create}
          onImport={importDiagram}
          setStatus={setStatus}
        />
      )}
    </div>
  );
}
