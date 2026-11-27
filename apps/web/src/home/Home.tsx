import { type FormEvent, lazy, type ReactNode, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { type DiagramModel, type DrawioPage, readDrawio, TEMPLATES, templateModel } from "@archcanvas/shared";
import {
  ArrowUpDown,
  ChevronDown,
  Copy,
  Ellipsis,
  FileUp,
  Folder,
  FolderInput,
  History,
  KeyRound,
  Layers,
  LayoutGrid,
  List,
  Network,
  Pencil,
  PenTool,
  Plus,
  Search,
  Settings,
  Shapes,
  Sparkles,
  Trash2,
  Upload,
  Users,
} from "lucide-react";
import { Link } from "../router";
import { api, type ApiToken, type DiagramKind, type DiagramSummary, type Member, type Project, type Role, type Workspace } from "../api";

// The review dialog shows a live canvas preview, so it brings React Flow with it.
const ImportDialog = lazy(() => import("./ImportDialog"));
const IconPacksDialog = lazy(() => import("./IconPacksDialog").then((m) => ({ default: m.IconPacksDialog })));
import { timeAgo } from "../util";
import { askConfirm } from "../dialogs";
import { DiagramThumb, WhiteboardThumb } from "./DiagramThumb";

type SetStatus = (s: { kind: "ok" | "error"; text: string } | null) => void;

export interface HomeProps {
  workspaces: Workspace[];
  workspace: Workspace | null;
  projects: Project[];
  project: Project | null;
  me: string;
  onWorkspace: (id: string) => void;
  projectHref: (id: string) => string;
  diagramHref: (id: string, title: string, history?: boolean) => string;
  /** Reload workspaces and projects (after create / rename / delete). */
  reload: (select?: { workspaceId?: string; projectId?: string }) => Promise<void>;
  reloadIconPacks: () => Promise<void>;
  onNew: (kind: DiagramKind | "sample") => void;
  onImport: (title: string, model: DiagramModel, fileName: string) => void;
  setStatus: SetStatus;
}

const canEdit = (r: Role | undefined) => r === "owner" || r === "editor";

export function Home(props: HomeProps) {
  const { workspaces, workspace, projects, project, onWorkspace, projectHref, reload, setStatus } = props;
  const [dialog, setDialog] = useState<null | "workspace" | "project" | "members" | "rename-ws" | "icons" | "tokens">(null);
  const role = workspace?.role;

  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    try {
      await fn();
      if (ok) setStatus({ kind: "ok", text: ok });
      return true;
    } catch (e) {
      setStatus({ kind: "error", text: (e as Error).message });
      return false;
    }
  };

  const initials = (s: string) =>
    s
      .split(/[\s@._-]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]!.toUpperCase())
      .join("") || "?";

  return (
    <div className="home dash">
      <aside className="dash-side">
        <div className="ws-switch">
          <span className="ws-avatar" style={{ background: tint(workspace?.name ?? "") }}>
            {initials(workspace?.name ?? "W")}
          </span>
          <div className="ws-meta">
            <select value={workspace?.id ?? ""} onChange={(e) => onWorkspace(e.target.value)} aria-label="Workspace">
              {workspaces.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
            <span className="ws-sub">
              {workspace ? `${workspace.role[0].toUpperCase()}${workspace.role.slice(1)} · ${workspace.member_count} member${workspace.member_count === 1 ? "" : "s"}` : ""}
            </span>
          </div>
          <button className="icon-btn" title="New workspace" aria-label="New workspace" onClick={() => setDialog("workspace")}>
            <Plus size={15} />
          </button>
        </div>

        <div className="side-section">
          <div className="side-head">
            <span>Projects</span>
            {canEdit(role) && (
              <button className="icon-btn" title="New project" aria-label="New project" onClick={() => setDialog("project")}>
                <Plus size={15} />
              </button>
            )}
          </div>
          <ul className="side-list">
            {projects.map((p) => (
              <li key={p.id}>
                <Link to={projectHref(p.id)} className={p.id === project?.id ? "active" : ""}>
                  <span className="proj-dot" style={{ background: tint(p.name) }} />
                  <span className="side-name">{p.name}</span>
                  <span className="count">{p.diagram_count}</span>
                </Link>
              </li>
            ))}
            {!projects.length && <li className="side-empty">No projects yet</li>}
          </ul>
        </div>

        {workspace && (
          <div className="side-section side-bottom">
            <div className="side-head">
              <span>Workspace</span>
            </div>
            <ul className="side-list tools">
              <li>
                <button onClick={() => setDialog("members")}>
                  <Users size={16} /> <span className="side-name">Members</span> <span className="count">{workspace.member_count}</span>
                </button>
              </li>
              <li>
                <button onClick={() => setDialog("icons")}>
                  <Shapes size={16} /> <span className="side-name">Icon packs</span>
                </button>
              </li>
              <li>
                <button onClick={() => setDialog("tokens")}>
                  <KeyRound size={16} /> <span className="side-name">API tokens</span>
                </button>
              </li>
              {role === "owner" && (
                <li>
                  <button onClick={() => setDialog("rename-ws")}>
                    <Settings size={16} /> <span className="side-name">Settings</span>
                  </button>
                </li>
              )}
            </ul>
          </div>
        )}
      </aside>

      <main className="home-main dash-main">
        {project && workspace ? (
          <ProjectView key={project.id} {...props} project={project} role={role!} run={run} />
        ) : (
          <div className="dash-empty">
            <h2>Welcome to ArchCanvas</h2>
            <p>Projects keep related diagrams together, like a team or a system. Create one to get started.</p>
            {canEdit(role) && (
              <button className="primary" onClick={() => setDialog("project")}>
                <Plus size={15} /> New project
              </button>
            )}
          </div>
        )}
      </main>

      {dialog === "workspace" && (
        <PromptDialog
          title="New workspace"
          label="Name"
          placeholder="e.g. Platform team"
          submit="Create"
          onClose={() => setDialog(null)}
          onSubmit={async (name) => {
            let id = "";
            const ok = await run(async () => (id = (await api.createWorkspace(name)).id), "Workspace created");
            if (ok) await reload({ workspaceId: id });
            return ok;
          }}
        />
      )}
      {dialog === "rename-ws" && workspace && (
        <WorkspaceSettings
          workspace={workspace}
          onClose={() => setDialog(null)}
          onRename={async (name) => {
            const ok = await run(() => api.renameWorkspace(workspace.id, name), "Workspace renamed");
            if (ok) await reload({ workspaceId: workspace.id });
            return ok;
          }}
          onDelete={async () => {
            const ok = await run(() => api.deleteWorkspace(workspace.id), "Workspace deleted");
            if (ok) await reload();
            return ok;
          }}
        />
      )}
      {dialog === "project" && workspace && (
        <PromptDialog
          title="New project"
          label="Name"
          placeholder="e.g. Payments platform"
          submit="Create"
          onClose={() => setDialog(null)}
          onSubmit={async (name) => {
            let id = "";
            const ok = await run(async () => (id = (await api.createProject(workspace.id, name)).id), "Project created");
            if (ok) await reload({ workspaceId: workspace.id, projectId: id });
            return ok;
          }}
        />
      )}
      {dialog === "icons" && workspace && (
        <Suspense fallback={null}>
          <IconPacksDialog workspace={workspace} onClose={() => setDialog(null)} onChanged={props.reloadIconPacks} setStatus={setStatus} />
        </Suspense>
      )}
      {dialog === "tokens" && <TokensDialog onClose={() => setDialog(null)} setStatus={setStatus} />}
      {dialog === "members" && workspace && (
        <MembersDialog workspace={workspace} me={props.me} onClose={() => setDialog(null)} onChanged={() => reload({ workspaceId: workspace.id })} setStatus={setStatus} />
      )}
    </div>
  );
}

// ------------------------------------------------------------------ project view

/** A stable colour for a name (project dots, workspace avatar). */
const TINTS = ["#6366f1", "#0ea5e9", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#14b8a6", "#ec4899", "#64748b", "#f97316"];
function tint(name: string): string {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return TINTS[h % TINTS.length];
}

type Sort = "edited" | "name" | "created";
type View = "grid" | "list";
type KindFilter = "all" | "cloud" | "whiteboard";

const pref = <T extends string>(key: string, fallback: T): T => (localStorage.getItem(`archcanvas.dash.${key}`) as T) || fallback;
const savePref = (key: string, v: string) => localStorage.setItem(`archcanvas.dash.${key}`, v);

function ProjectView({
  project,
  projects,
  role,
  reload,
  workspace,
  diagramHref,
  onNew,
  onImport,
  setStatus,
  run,
}: HomeProps & { project: Project; role: Role; run: (fn: () => Promise<unknown>, ok?: string) => Promise<boolean> }) {
  const [diagrams, setDiagrams] = useState<DiagramSummary[] | null>(null);
  const [models, setModels] = useState<Record<string, DiagramModel | null>>({});
  const [importing, setImporting] = useState<{ fileName: string; pages: DrawioPage[] } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [moving, setMoving] = useState<DiagramSummary | null>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [kind, setKind] = useState<KindFilter>("all");
  const [sort, setSort] = useState<Sort>(() => pref("sort", "edited"));
  const [view, setView] = useState<View>(() => pref("view", "grid"));
  const fileInput = useRef<HTMLInputElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const editable = canEdit(role);

  async function readFile(file: File) {
    if (!/\.(drawio|xml|svg)$/i.test(file.name)) {
      setStatus({ kind: "error", text: `${file.name} isn't a draw.io file. Use .drawio, .drawio.svg or .xml (other formats: open a diagram, then Import).` });
      return;
    }
    try {
      setImporting({ fileName: file.name, pages: await readDrawio(await file.text()) });
    } catch (e) {
      setStatus({ kind: "error", text: `Couldn't read ${file.name}: ${(e as Error).message}` });
    }
  }

  const load = useCallback(() => {
    api.listDiagrams(project.id).then(setDiagrams, () => setDiagrams([]));
  }, [project.id]);
  useEffect(load, [load]);

  // Thumbnails: each architecture diagram's model, fetched once per version.
  useEffect(() => {
    for (const d of diagrams ?? []) {
      const key = `${d.id}@${d.updated_at}`;
      if (d.kind !== "cloud" || key in models) continue;
      setModels((m) => ({ ...m, [key]: null }));
      api.getDiagram(d.id).then(
        (full) => setModels((m) => ({ ...m, [key]: full.model ?? null })),
        () => undefined,
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [diagrams]);

  // "/" focuses search, as in most file browsers.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "/" && !(e.target as HTMLElement).closest("input, textarea, select, [contenteditable]")) {
        e.preventDefault();
        search.current?.focus();
      }
      if (e.key === "Escape") {
        setMenu(null);
        setNewOpen(false);
      }
    };
    const onClick = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest(".card-menu, .new-menu")) {
        setMenu(null);
        setNewOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onClick);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onClick);
    };
  }, []);

  const after = async (ok: boolean) => {
    if (ok) {
      load();
      await reload({ workspaceId: workspace!.id, projectId: project.id });
    }
  };

  const all = diagrams ?? [];
  const shown = all
    .filter((d) => (kind === "all" || d.kind === kind) && d.title.toLowerCase().includes(filter.toLowerCase()))
    .sort((a, b) => (sort === "name" ? a.title.localeCompare(b.title) : sort === "created" ? (b.created_at ?? "").localeCompare(a.created_at ?? "") : b.updated_at.localeCompare(a.updated_at)));
  const totalResources = all.reduce((n, d) => n + (d.node_count ?? 0), 0);
  const lastEdit = all.reduce<string | null>((t, d) => (!t || d.updated_at > t ? d.updated_at : t), null);
  const startTemplate = (id: string) => {
    const t = TEMPLATES.find((x) => x.id === id)!;
    onImport(t.title, templateModel(id), `the "${t.title}" template`);
  };

  const actions = (d: DiagramSummary) => (
    <div className="card-menu">
      <button
        className="icon-btn"
        aria-label={`Actions for ${d.title}`}
        onClick={(e) => {
          e.preventDefault();
          setMenu(menu === d.id ? null : d.id);
        }}
      >
        <Ellipsis size={16} />
      </button>
      {menu === d.id && (
        <div className="menu-pop" role="menu">
          <Link to={diagramHref(d.id, d.title)} className="menu-item">
            <Pencil size={14} /> Open
          </Link>
          <Link to={diagramHref(d.id, d.title, true)} className="menu-item">
            <History size={14} /> Version history
          </Link>
          {editable && (
            <button className="menu-item" onClick={() => (setMenu(null), void run(() => api.duplicateDiagram(d.id), "Duplicated").then(after))}>
              <Copy size={14} /> Duplicate
            </button>
          )}
          {editable && projects.length > 1 && (
            <button className="menu-item" onClick={() => (setMenu(null), setMoving(d))}>
              <FolderInput size={14} /> Move to project…
            </button>
          )}
          {editable && (
            <button
              className="menu-item danger"
              onClick={async () => {
                setMenu(null);
                if (await askConfirm({ title: `Delete "${d.title}"?`, message: "The diagram and its whole version history are deleted. This cannot be undone.", confirm: "Delete", danger: true }))
                  void run(() => api.deleteDiagram(d.id), "Diagram deleted").then(after);
              }}
            >
              <Trash2 size={14} /> Delete
            </button>
          )}
        </div>
      )}
    </div>
  );

  const thumb = (d: DiagramSummary) => {
    if (d.kind !== "cloud") return <WhiteboardThumb />;
    const m = models[`${d.id}@${d.updated_at}`];
    return m ? <DiagramThumb model={m} /> : <div className="thumb-loading" />;
  };

  return (
    <div
      className={`dash-body ${dragging ? "dropping" : ""}`}
      onDragOver={(e) => {
        if (!editable || !e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => e.currentTarget === e.target && setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        const f = e.dataTransfer.files[0];
        if (f && editable) void readFile(f);
      }}
    >
      {dragging && (
        <div className="drop-overlay">
          <FileUp size={28} />
          <b>Drop a draw.io file to import it</b>
          <span>Google Cloud, AWS, Azure and on-prem shapes are recognised</span>
        </div>
      )}

      <header className="dash-header">
        <div className="dash-title">
          <span className="proj-badge" style={{ background: tint(project.name) }}>
            <Folder size={18} />
          </span>
          <div>
            <h1>{project.name}</h1>
            <p className="dash-sub">
              {project.description || "No description"}
              {editable && (
                <button className="link" onClick={() => setRenaming(true)}>
                  Edit
                </button>
              )}
            </p>
          </div>
        </div>
        <div className="dash-search">
          <Search size={15} />
          <input ref={search} placeholder="Search diagrams" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Search diagrams" />
          <kbd>/</kbd>
        </div>
        {editable && (
          <div className="new-menu">
            <button className="primary new-btn" onClick={() => setNewOpen(!newOpen)} aria-expanded={newOpen}>
              <Plus size={16} /> New <ChevronDown size={14} />
            </button>
            {newOpen && (
              <div className="menu-pop right" role="menu">
                <button className="menu-item" onClick={() => onNew("cloud")}>
                  <Network size={15} /> <span>Architecture diagram<small>Any cloud and on-prem; Terraform for GCP and AWS</small></span>
                </button>
                <button className="menu-item" onClick={() => onNew("whiteboard")}>
                  <PenTool size={15} /> <span>Whiteboard<small>Freeform sketch with Mermaid</small></span>
                </button>
                <button className="menu-item" onClick={() => (setNewOpen(false), fileInput.current?.click())}>
                  <Upload size={15} /> <span>Import draw.io file…<small>.drawio, .xml or .drawio.svg</small></span>
                </button>
                <div className="menu-sep">From a template</div>
                {TEMPLATES.map((t) => (
                  <button key={t.id} className="menu-item" onClick={() => startTemplate(t.id)}>
                    <Sparkles size={15} /> <span>{t.title}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        <input
          ref={fileInput}
          type="file"
          accept=".drawio,.xml,.svg"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void readFile(f);
            e.target.value = "";
          }}
        />
      </header>

      <div className="dash-stats">
        <div className="stat">
          <span className="stat-n">{all.length}</span>
          <span className="stat-l">diagram{all.length === 1 ? "" : "s"}</span>
        </div>
        <div className="stat">
          <span className="stat-n">{totalResources}</span>
          <span className="stat-l">items drawn</span>
        </div>
        <div className="stat">
          <span className="stat-n">{all.filter((d) => d.kind === "cloud").length}</span>
          <span className="stat-l">architecture</span>
        </div>
        <div className="stat">
          <span className="stat-n">{lastEdit ? timeAgo(lastEdit) : "—"}</span>
          <span className="stat-l">last edit</span>
        </div>
      </div>

      {editable && (
        <section className="dash-start">
          <h2>Start something new</h2>
          <div className="start-row">
            <button className="start-card blank" onClick={() => onNew("cloud")}>
              <div className="start-thumb">
                <Plus size={26} />
              </div>
              <b>Blank architecture</b>
              <span>Start from an empty canvas</span>
            </button>
            {TEMPLATES.map((t) => (
              <button key={t.id} className="start-card" onClick={() => startTemplate(t.id)} title={t.description}>
                <div className="start-thumb">
                  <TemplateThumb id={t.id} />
                </div>
                <b>{t.title}</b>
                <span>{t.description}</span>
              </button>
            ))}
            <button className="start-card import" onClick={() => fileInput.current?.click()}>
              <div className="start-thumb">
                <FileUp size={24} />
              </div>
              <b>Import draw.io</b>
              <span>Or drop a file anywhere on this page</span>
            </button>
          </div>
        </section>
      )}

      <section className="dash-files">
        <div className="files-bar">
          <h2>Diagrams</h2>
          <div className="seg" role="tablist" aria-label="Kind">
            {(
              [
                ["all", `All ${all.length}`],
                ["cloud", "Architecture"],
                ["whiteboard", "Whiteboards"],
              ] as [KindFilter, string][]
            ).map(([k, label]) => (
              <button key={k} role="tab" aria-selected={kind === k} className={kind === k ? "on" : ""} onClick={() => setKind(k)}>
                {label}
              </button>
            ))}
          </div>
          <div className="spacer" />
          <label className="sort">
            <ArrowUpDown size={14} />
            <select
              value={sort}
              onChange={(e) => {
                setSort(e.target.value as Sort);
                savePref("sort", e.target.value);
              }}
              aria-label="Sort"
            >
              <option value="edited">Last edited</option>
              <option value="name">Name</option>
              <option value="created">Date created</option>
            </select>
          </label>
          <div className="seg icons" aria-label="View">
            {(
              [
                ["grid", <LayoutGrid key="g" size={15} />],
                ["list", <List key="l" size={15} />],
              ] as [View, ReactNode][]
            ).map(([v, icon]) => (
              <button
                key={v}
                className={view === v ? "on" : ""}
                aria-label={v === "grid" ? "Grid view" : "List view"}
                aria-pressed={view === v}
                onClick={() => {
                  setView(v);
                  savePref("view", v);
                }}
              >
                {icon}
              </button>
            ))}
          </div>
        </div>

        {diagrams === null ? (
          <div className="file-grid">
            {[0, 1, 2].map((i) => (
              <div key={i} className="file-card skeleton" />
            ))}
          </div>
        ) : shown.length === 0 ? (
          <div className="files-empty">
            <Layers size={30} />
            <b>{all.length ? "No diagrams match" : "No diagrams yet"}</b>
            <span>{all.length ? "Try another search or filter." : editable ? "Start from a template above, or create a blank architecture." : "Nothing here yet."}</span>
          </div>
        ) : view === "grid" ? (
          <div className="file-grid">
            {shown.map((d) => (
              <div key={d.id} className={`file-card ${menu === d.id ? "menu-open" : ""}`}>
                <Link to={diagramHref(d.id, d.title)} className="file-thumb" title={`Open ${d.title}`}>
                  {thumb(d)}
                  <span className={`kind-chip ${d.kind}`}>{d.kind === "cloud" ? "Architecture" : "Whiteboard"}</span>
                </Link>
                <div className="file-info">
                  <span className="file-icon" style={{ background: d.kind === "cloud" ? "#eef2ff" : "#f5f3ff", color: d.kind === "cloud" ? "#4f46e5" : "#7c3aed" }}>
                    {d.kind === "cloud" ? <Network size={15} /> : <PenTool size={15} />}
                  </span>
                  <div className="file-text">
                    <Link to={diagramHref(d.id, d.title)} className="file-title">
                      {d.title}
                    </Link>
                    <span className="file-meta">
                      Edited {timeAgo(d.updated_at)} · v{d.version ?? 1}
                      {d.kind === "cloud" ? ` · ${d.node_count ?? 0} items` : ""}
                    </span>
                  </div>
                  {actions(d)}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="file-table" role="table">
            <div className="file-row head" role="row">
              <span>Name</span>
              <span>Type</span>
              <span>Items</span>
              <span>Version</span>
              <span>Last edited</span>
              <span />
            </div>
            {shown.map((d) => (
              <div key={d.id} className="file-row" role="row">
                <Link to={diagramHref(d.id, d.title)} className="file-name">
                  <span className="mini-thumb">{thumb(d)}</span>
                  {d.title}
                </Link>
                <span>{d.kind === "cloud" ? "Architecture" : "Whiteboard"}</span>
                <span>{d.kind === "cloud" ? (d.node_count ?? 0) : "—"}</span>
                <span>v{d.version ?? 1}</span>
                <span>{timeAgo(d.updated_at)}</span>
                {actions(d)}
              </div>
            ))}
          </div>
        )}
      </section>

      {importing && (
        <Suspense fallback={null}>
          <ImportDialog
            fileName={importing.fileName}
            pages={importing.pages}
            onClose={() => setImporting(null)}
            onImport={(title, model) => {
              setImporting(null);
              onImport(title, model, importing.fileName);
            }}
          />
        </Suspense>
      )}
      {renaming && (
        <ProjectSettings
          project={project}
          canDelete={role === "owner"}
          onClose={() => setRenaming(false)}
          onSave={async (name, description) => run(() => api.updateProject(project.id, { name, description }), "Project updated").then(async (ok) => (await after(ok), ok))}
          onDelete={async () => {
            const ok = await run(() => api.deleteProject(project.id), "Project deleted");
            if (ok) await reload({ workspaceId: workspace!.id });
            return ok;
          }}
        />
      )}
      {moving && (
        <Modal title={`Move "${moving.title}"`} onClose={() => setMoving(null)}>
          <p className="hint">Move to another project in this workspace. Its version history moves with it.</p>
          <div className="move-list">
            {projects
              .filter((p) => p.id !== project.id)
              .map((p) => (
                <button
                  key={p.id}
                  onClick={() =>
                    void run(() => api.updateDiagram(moving.id, { projectId: p.id }), `Moved to ${p.name}`).then(async (ok) => {
                      setMoving(null);
                      await after(ok);
                    })
                  }
                >
                  <span className="proj-dot" style={{ background: tint(p.name) }} /> {p.name}
                </button>
              ))}
          </div>
        </Modal>
      )}
    </div>
  );
}

/** Template previews are laid out once (they have no saved positions). */
const templateThumbs = new Map<string, DiagramModel>();
function TemplateThumb({ id }: { id: string }) {
  const [m, setM] = useState<DiagramModel | null>(() => templateThumbs.get(id) ?? null);
  useEffect(() => {
    if (m) return;
    let live = true;
    const model = templateModel(id);
    void import("../cloud/layout").then(({ autoLayout }) =>
      autoLayout(model).then((layout) => {
        const laid = { ...model, layout };
        templateThumbs.set(id, laid);
        if (live) setM(laid);
      }),
    );
    return () => {
      live = false;
    };
  }, [id, m]);
  return m ? <DiagramThumb model={m} /> : <div className="thumb-loading" />;
}

// ------------------------------------------------------------------ dialogs

export function Modal({ title, children, onClose, wide }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? "wide" : ""}`} role="dialog" aria-label={title}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="link" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function PromptDialog({
  title,
  label,
  placeholder,
  initial = "",
  submit,
  onSubmit,
  onClose,
}: {
  title: string;
  label: string;
  placeholder?: string;
  initial?: string;
  submit: string;
  onSubmit: (value: string) => Promise<boolean>;
  onClose: () => void;
}) {
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  async function go(e: FormEvent) {
    e.preventDefault();
    if (!value.trim()) return;
    setBusy(true);
    if (await onSubmit(value.trim())) onClose();
    setBusy(false);
  }
  return (
    <Modal title={title} onClose={onClose}>
      <form className="form" onSubmit={(e) => void go(e)}>
        <label>
          {label}
          <input autoFocus value={value} placeholder={placeholder} onChange={(e) => setValue(e.target.value)} />
        </label>
        <div className="row end">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" disabled={busy || !value.trim()}>
            {submit}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function ProjectSettings({
  project,
  canDelete,
  onSave,
  onDelete,
  onClose,
}: {
  project: Project;
  canDelete: boolean;
  onSave: (name: string, description: string) => Promise<boolean>;
  onDelete: () => Promise<boolean>;
  onClose: () => void;
}) {
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description);
  return (
    <Modal title="Project settings" onClose={onClose}>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          void onSave(name.trim(), description).then((ok) => ok && onClose());
        }}
      >
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          Description
          <textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <div className="row end">
          {canDelete && (
            <button
              type="button"
              className="danger"
              onClick={async () => {
                if (
                  await askConfirm({
                    title: `Delete project "${project.name}"?`,
                    message: `All ${project.diagram_count} diagram${project.diagram_count === 1 ? "" : "s"} in it and their history are deleted. This cannot be undone.`,
                    confirm: "Delete project",
                    danger: true,
                  })
                )
                  void onDelete().then((ok) => ok && onClose());
              }}
            >
              Delete project
            </button>
          )}
          <div className="spacer" />
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" disabled={!name.trim()}>
            Save
          </button>
        </div>
      </form>
    </Modal>
  );
}

function WorkspaceSettings({
  workspace,
  onRename,
  onDelete,
  onClose,
}: {
  workspace: Workspace;
  onRename: (name: string) => Promise<boolean>;
  onDelete: () => Promise<boolean>;
  onClose: () => void;
}) {
  const [name, setName] = useState(workspace.name);
  return (
    <Modal title="Workspace settings" onClose={onClose}>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          void onRename(name.trim()).then((ok) => ok && onClose());
        }}
      >
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <div className="row end">
          <button
            type="button"
            className="danger"
            onClick={async () => {
              if (
                await askConfirm({
                  title: `Delete workspace "${workspace.name}"?`,
                  message: "All its projects, diagrams and history are deleted. This cannot be undone.",
                  confirm: "Delete workspace",
                  danger: true,
                })
              )
                void onDelete().then((ok) => ok && onClose());
            }}
          >
            Delete workspace
          </button>
          <div className="spacer" />
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" disabled={!name.trim()}>
            Save
          </button>
        </div>
      </form>
    </Modal>
  );
}

function MembersDialog({
  workspace,
  me,
  onClose,
  onChanged,
  setStatus,
}: {
  workspace: Workspace;
  me: string;
  onClose: () => void;
  onChanged: () => Promise<void>;
  setStatus: SetStatus;
}) {
  const [members, setMembers] = useState<Member[] | null>(null);
  const [userId, setUserId] = useState("");
  const [role, setRole] = useState<Role>("editor");
  const owner = workspace.role === "owner";
  const load = useCallback(() => {
    api.members(workspace.id).then(setMembers, (e) => setStatus({ kind: "error", text: (e as Error).message }));
  }, [workspace.id, setStatus]);
  useEffect(load, [load]);

  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      load();
      await onChanged();
    } catch (e) {
      setStatus({ kind: "error", text: (e as Error).message });
    }
  };

  return (
    <Modal title={`Members of ${workspace.name}`} onClose={onClose}>
      <p className="hint">
        Owners manage members and settings. Editors create and change projects and diagrams. Viewers can open diagrams, history and comparisons.
      </p>
      <table className="members">
        <tbody>
          {(members ?? []).map((m) => (
            <tr key={m.user_id}>
              <td>
                {m.user_id}
                {m.user_id === me && <span className="hint"> (you)</span>}
              </td>
              <td>
                <select value={m.role} disabled={!owner} onChange={(e) => void act(() => api.setMember(workspace.id, m.user_id, e.target.value as Role))}>
                  <option value="owner">owner</option>
                  <option value="editor">editor</option>
                  <option value="viewer">viewer</option>
                </select>
              </td>
              <td>
                {(owner || m.user_id === me) && (
                  <button
                    className="link danger"
                    onClick={async () => {
                      if (
                        await askConfirm(
                          m.user_id === me
                            ? { title: "Leave this workspace?", message: "You lose access until someone adds you again.", confirm: "Leave", danger: true }
                            : { title: `Remove ${m.user_id}?`, message: "They lose access to this workspace.", confirm: "Remove", danger: true },
                        )
                      )
                        void act(() => api.removeMember(workspace.id, m.user_id));
                    }}
                  >
                    {m.user_id === me ? "Leave" : "Remove"}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {owner && (
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            if (userId.trim()) void act(() => api.setMember(workspace.id, userId.trim(), role)).then(() => setUserId(""));
          }}
        >
          <input placeholder="Email or user id" value={userId} onChange={(e) => setUserId(e.target.value)} aria-label="Member email or user id" />
          <select value={role} onChange={(e) => setRole(e.target.value as Role)} aria-label="Role">
            <option value="editor">editor</option>
            <option value="viewer">viewer</option>
            <option value="owner">owner</option>
          </select>
          <button className="primary" disabled={!userId.trim()}>
            Add
          </button>
        </form>
      )}
    </Modal>
  );
}

/** Personal API tokens for scripts, CI and AI agents (the MCP server). */
function TokensDialog({ onClose, setStatus }: { onClose: () => void; setStatus: (s: { kind: "ok" | "error"; text: string } | null) => void }) {
  const [tokens, setTokens] = useState<ApiToken[] | null>(null);
  const [name, setName] = useState("");
  const [days, setDays] = useState("90");
  const [created, setCreated] = useState<string | null>(null);
  const load = () => api.tokens().then(setTokens, (e) => setStatus({ kind: "error", text: (e as Error).message }));
  useEffect(() => void load(), []); // eslint-disable-line react-hooks/exhaustive-deps
  const date = (s?: string | null) => (s ? new Date(s).toLocaleDateString() : "never");
  return (
    <Modal title="API tokens" onClose={onClose}>
      <p className="hint">
        A token acts as you, with your roles, for scripts, CI (the GitHub action) and AI agents through the MCP server. See <code>docs/api-and-mcp.md</code>.
      </p>
      {created && (
        <div className="token-created">
          <b>Copy this token now: it won't be shown again.</b>
          <code>{created}</code>
          <button onClick={() => void navigator.clipboard.writeText(created).then(() => setStatus({ kind: "ok", text: "Token copied" }))}>Copy</button>
        </div>
      )}
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim()) return;
          api.createToken(name.trim(), days ? Number(days) : undefined).then(
            (t) => {
              setCreated(t.token);
              setName("");
              void load();
            },
            (err) => setStatus({ kind: "error", text: (err as Error).message }),
          );
        }}
      >
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name, e.g. GitHub CI or Claude" aria-label="Token name" style={{ flex: 1 }} />
        <select value={days} onChange={(e) => setDays(e.target.value)} aria-label="Expires">
          <option value="30">30 days</option>
          <option value="90">90 days</option>
          <option value="365">1 year</option>
          <option value="">No expiry</option>
        </select>
        <button className="primary" disabled={!name.trim()}>
          Create
        </button>
      </form>
      {tokens === null ? (
        <p className="hint">Loading…</p>
      ) : tokens.length === 0 ? (
        <p className="hint">No tokens yet.</p>
      ) : (
        <ul className="token-list">
          {tokens.map((t) => (
            <li key={t.id}>
              <div>
                <b>{t.name}</b> <code>{t.prefix}…</code>
                <div className="hint">
                  Created {date(t.created_at)} · last used {date(t.last_used_at)} · expires {date(t.expires_at)}
                </div>
              </div>
              <button
                className="danger"
                onClick={async () => {
                  if (!(await askConfirm({ title: `Revoke "${t.name}"?`, message: "Anything using this token stops working.", confirm: "Revoke", danger: true }))) return;
                  api.deleteToken(t.id).then(load, (e) => setStatus({ kind: "error", text: (e as Error).message }));
                }}
              >
                Revoke
              </button>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
