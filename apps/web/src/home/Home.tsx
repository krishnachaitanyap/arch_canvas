import { type FormEvent, lazy, type ReactNode, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { type DiagramModel, type DrawioPage, readDrawio } from "@archcanvas/shared";
import { Link, navigate, useLocation } from "../router";
import { api, type DiagramKind, type DiagramSummary, type Member, type Project, type ProjectTab, type Role, type Workspace } from "../api";

// The review dialog shows a live canvas preview, so it brings React Flow with it.
const ImportDialog = lazy(() => import("./ImportDialog"));
const IconPacksDialog = lazy(() => import("./IconPacksDialog").then((m) => ({ default: m.IconPacksDialog })));
import { timeAgo } from "../util";

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
  /** `section` is the project tab the new diagram goes into. */
  onNew: (kind: DiagramKind | "sample", section?: string) => void;
  onImport: (title: string, model: DiagramModel, fileName: string, section?: string) => void;
  setStatus: SetStatus;
}

const canEdit = (r: Role | undefined) => r === "owner" || r === "editor";

/** Common aspects people organise a project by; anything else can be typed in. */
const SUGGESTED_TABS = ["Architecture", "HA / DR", "CI/CD", "Security", "Networking", "Data", "Observability", "Cost", "Runbooks"];

function tabId(name: string, taken: string[]): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "tab";
  let id = base;
  for (let i = 2; taken.includes(id); i++) id = `${base}-${i}`;
  return id;
}

/**
 * The project's own tabs (HA / DR, CI/CD…): All, then each tab with its diagram count.
 * Drop a diagram card on a tab to file it there. Editors add, rename, reorder and delete tabs.
 */
function ProjectTabs({
  tabs,
  active,
  counts,
  editable,
  onSelect,
  onChange,
  onDropDiagram,
}: {
  tabs: ProjectTab[];
  active: string;
  counts: Record<string, number>;
  editable: boolean;
  onSelect: (id: string) => void;
  onChange: (tabs: ProjectTab[]) => void;
  onDropDiagram: (diagramId: string, tab: string | null) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const [menu, setMenu] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const add = (name: string) => {
    const n = name.trim().slice(0, 40);
    if (!n) return;
    const id = tabId(n, tabs.map((t) => t.id));
    onChange([...tabs, { id, name: n }]);
    onSelect(id);
    setDraft("");
    setAdding(false);
  };
  const move = (id: string, by: number) => {
    const i = tabs.findIndex((t) => t.id === id);
    const j = i + by;
    if (i < 0 || j < 0 || j >= tabs.length) return;
    const next = [...tabs];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };
  const dropProps = (id: string | null) => ({
    onDragOver: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes("application/x-archcanvas-diagram")) return;
      e.preventDefault();
      setOver(id ?? "all");
    },
    onDragLeave: () => setOver(null),
    onDrop: (e: React.DragEvent) => {
      const d = e.dataTransfer.getData("application/x-archcanvas-diagram");
      setOver(null);
      if (d) onDropDiagram(d, id);
    },
  });
  const unused = SUGGESTED_TABS.filter((n) => !tabs.some((t) => t.name.toLowerCase() === n.toLowerCase()));
  return (
    <div className="project-tabs" role="tablist" aria-label="Project tabs">
      <button role="tab" aria-selected={active === "all"} className={`ptab ${active === "all" ? "on" : ""} ${over === "all" ? "over" : ""}`} onClick={() => onSelect("all")} {...(editable ? dropProps(null) : {})}>
        All <span className="ptab-count">{counts.all ?? 0}</span>
      </button>
      {tabs.map((t, i) => (
        <div key={t.id} className="ptab-wrap">
          <button
            role="tab"
            aria-selected={active === t.id}
            className={`ptab ${active === t.id ? "on" : ""} ${over === t.id ? "over" : ""}`}
            onClick={() => onSelect(t.id)}
            onDoubleClick={() => {
              if (!editable) return;
              const name = prompt("Rename tab", t.name)?.trim();
              if (name) onChange(tabs.map((x) => (x.id === t.id ? { ...x, name: name.slice(0, 40) } : x)));
            }}
            {...(editable ? dropProps(t.id) : {})}
          >
            {t.name} <span className="ptab-count">{counts[t.id] ?? 0}</span>
          </button>
          {editable && active === t.id && (
            <button className="ptab-more" title="Tab options" aria-label={`Options for ${t.name}`} onClick={() => setMenu(menu === t.id ? null : t.id)}>
              ⋯
            </button>
          )}
          {menu === t.id && (
            <div className="ptab-menu" onMouseLeave={() => setMenu(null)}>
              <button
                onClick={() => {
                  setMenu(null);
                  const name = prompt("Rename tab", t.name)?.trim();
                  if (name) onChange(tabs.map((x) => (x.id === t.id ? { ...x, name: name.slice(0, 40) } : x)));
                }}
              >
                Rename
              </button>
              <button disabled={i === 0} onClick={() => (setMenu(null), move(t.id, -1))}>
                Move left
              </button>
              <button disabled={i === tabs.length - 1} onClick={() => (setMenu(null), move(t.id, 1))}>
                Move right
              </button>
              <button
                className="danger"
                onClick={() => {
                  setMenu(null);
                  if (confirm(`Delete the "${t.name}" tab? Its ${counts[t.id] ?? 0} diagram(s) stay in the project, under All.`)) {
                    onChange(tabs.filter((x) => x.id !== t.id));
                    onSelect("all");
                  }
                }}
              >
                Delete tab
              </button>
            </div>
          )}
        </div>
      ))}
      {editable && (
        <div className="ptab-wrap">
          <button className="ptab add" onClick={() => setAdding((a) => !a)} title="Add a tab (e.g. HA / DR, CI/CD)" aria-expanded={adding}>
            + Tab
          </button>
          {adding && (
            <div className="ptab-menu add-menu">
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  add(draft);
                }}
              >
                <input autoFocus placeholder="Tab name, e.g. HA / DR" value={draft} maxLength={40} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === "Escape" && setAdding(false)} />
                <button className="primary" disabled={!draft.trim()}>
                  Add
                </button>
              </form>
              {unused.length > 0 && (
                <div className="ptab-suggest">
                  {unused.map((n) => (
                    <button key={n} type="button" onClick={() => add(n)}>
                      {n}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function Home(props: HomeProps) {
  const { workspaces, workspace, projects, project, onWorkspace, projectHref, reload, setStatus } = props;
  const [dialog, setDialog] = useState<null | "workspace" | "project" | "members" | "rename-ws" | "icons">(null);
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

  return (
    <div className="home">
      <aside className="nav">
        <label className="nav-label">Workspace</label>
        <div className="row">
          <select value={workspace?.id ?? ""} onChange={(e) => onWorkspace(e.target.value)} aria-label="Workspace">
            {workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
          <button title="New workspace" onClick={() => setDialog("workspace")}>
            +
          </button>
        </div>
        {workspace && (
          <div className="nav-meta">
            <span className={`role-pill ${workspace.role}`}>{workspace.role}</span>
            <button className="link" onClick={() => setDialog("members")}>
              {workspace.member_count} member{workspace.member_count === 1 ? "" : "s"}
            </button>
            <button className="link" onClick={() => setDialog("icons")}>
              Icon packs
            </button>
            {role === "owner" && (
              <button className="link" onClick={() => setDialog("rename-ws")}>
                Settings
              </button>
            )}
          </div>
        )}

        <div className="nav-head">
          <span className="nav-label">Projects</span>
          {canEdit(role) && (
            <button className="link" onClick={() => setDialog("project")}>
              + New
            </button>
          )}
        </div>
        <ul className="project-list">
          {projects.map((p) => (
            <li key={p.id}>
              <Link to={projectHref(p.id)} className={p.id === project?.id ? "active" : ""}>
                <span>{p.name}</span>
                <span className="count">{p.diagram_count}</span>
              </Link>
            </li>
          ))}
        </ul>
      </aside>

      <main className="home-main">
        {project && workspace ? (
          <ProjectView key={project.id} {...props} project={project} role={role!} run={run} />
        ) : (
          <p className="hint pad">Create a project to get started.</p>
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
      {dialog === "members" && workspace && (
        <MembersDialog workspace={workspace} me={props.me} onClose={() => setDialog(null)} onChanged={() => reload({ workspaceId: workspace.id })} setStatus={setStatus} />
      )}
    </div>
  );
}

// ------------------------------------------------------------------ project view

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
  const [importing, setImporting] = useState<{ fileName: string; pages: DrawioPage[] } | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  async function readFile(file: File) {
    if (!/\.(drawio|xml|svg)$/i.test(file.name)) {
      setStatus({ kind: "error", text: `${file.name} isn't a draw.io file. Use .drawio, .drawio.svg or .xml.` });
      return;
    }
    try {
      const pages = await readDrawio(await file.text());
      setImporting({ fileName: file.name, pages });
    } catch (e) {
      setStatus({ kind: "error", text: `Couldn't read ${file.name}: ${(e as Error).message}` });
    }
  }
  const [renaming, setRenaming] = useState(false);
  const [moving, setMoving] = useState<DiagramSummary | null>(null);
  const [filter, setFilter] = useState("");
  const editable = canEdit(role);
  // The tab in view: ?section= in the URL, else the last one used in this project (a per-user preference).
  const loc = useLocation();
  const [tabs, setTabs] = useState<ProjectTab[]>(project.tabs ?? []);
  useEffect(() => setTabs(project.tabs ?? []), [project.id, project.tabs]);
  const [wanted, setWanted] = useState(() => loc.search.get("section") ?? localStorage.getItem(`archcanvas.projectTab.${project.id}`) ?? "all");
  useEffect(() => setWanted(loc.search.get("section") ?? localStorage.getItem(`archcanvas.projectTab.${project.id}`) ?? "all"), [project.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const active = wanted === "all" || tabs.some((t) => t.id === wanted) ? wanted : "all";
  const selectTab = (id: string) => {
    setWanted(id);
    localStorage.setItem(`archcanvas.projectTab.${project.id}`, id);
    navigate(id === "all" ? loc.path : `${loc.path}?section=${encodeURIComponent(id)}`, { replace: true });
  };
  const section = active === "all" ? undefined : active;
  const saveTabs = (next: ProjectTab[]) => {
    setTabs(next);
    void run(() => api.updateProject(project.id, { tabs: next })).then(async (ok) => {
      if (!ok) setTabs(project.tabs ?? []);
      await after(ok);
    });
  };
  const fileUnder = (diagramId: string, tab: string | null) => {
    setDiagrams((ds) => ds && ds.map((d) => (d.id === diagramId ? { ...d, tab } : d)));
    void run(() => api.updateDiagram(diagramId, { tab }), tab ? `Moved to ${tabs.find((t) => t.id === tab)?.name}` : "Removed from its tab").then((ok) => !ok && load());
  };

  const load = useCallback(() => {
    api.listDiagrams(project.id).then(setDiagrams, () => setDiagrams([]));
  }, [project.id]);
  useEffect(load, [load]);

  const after = async (ok: boolean) => {
    if (ok) {
      load();
      await reload({ workspaceId: workspace!.id, projectId: project.id });
    }
  };

  const inTab = (diagrams ?? []).filter((d) => active === "all" || d.tab === active);
  const shown = inTab.filter((d) => d.title.toLowerCase().includes(filter.toLowerCase()));
  const counts: Record<string, number> = { all: diagrams?.length ?? 0 };
  for (const d of diagrams ?? []) if (d.tab) counts[d.tab] = (counts[d.tab] ?? 0) + 1;
  const tabName = tabs.find((t) => t.id === active)?.name;

  return (
    <>
      <div className="project-head">
        <div>
          <h1>{project.name}</h1>
          {project.description && <p className="hint">{project.description}</p>}
        </div>
        <div className="spacer" />
        {editable && <button onClick={() => setRenaming(true)}>Edit project</button>}
        {editable && (
          <select
            value=""
            aria-label="New diagram"
            onChange={(e) => {
              if (e.target.value === "import") fileInput.current?.click();
              else onNew(e.target.value as DiagramKind | "sample", section);
              e.target.value = "";
            }}
          >
            <option value="" disabled>
              New diagram…
            </option>
            <option value="cloud">Blank architecture (any cloud, on-prem)</option>
            <option value="sample">Example: GCP web app</option>
            <option value="import">Import draw.io file…</option>
            <option value="whiteboard">Whiteboard (Mermaid)</option>
          </select>
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
      </div>
      {editable && (
        <div
          className={`dropzone ${dragging ? "over" : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            const f = e.dataTransfer.files[0];
            if (f) void readFile(f);
          }}
          onClick={() => fileInput.current?.click()}
        >
          <b>Import from draw.io:</b> drop a <code>.drawio</code>, <code>.xml</code> or <code>.drawio.svg</code> file here, or click to choose one. Google Cloud,
          AWS, Azure and on-prem shapes are recognised; you get workflows, documentation, a presentation, and Terraform for the Google Cloud parts.
        </div>
      )}

      {(tabs.length > 0 || editable) && (
        <ProjectTabs tabs={tabs} active={active} counts={counts} editable={editable} onSelect={selectTab} onChange={saveTabs} onDropDiagram={fileUnder} />
      )}

      <input className="filter" placeholder={tabName ? `Filter diagrams in ${tabName}` : "Filter diagrams"} value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter diagrams" />

      {diagrams === null ? (
        <p className="hint">Loading…</p>
      ) : shown.length === 0 ? (
        <div className="empty-card">
          <p>{inTab.length ? "No diagrams match." : tabName ? `No diagrams in ${tabName} yet. Create one here, or drag a diagram onto the tab.` : "No diagrams in this project yet."}</p>
          {editable && !inTab.length && (
            <div className="row">
              <button className="primary" onClick={() => onNew("cloud", section)}>
                Blank architecture
              </button>
              <button onClick={() => onNew("sample", section)}>Start from sample</button>
              <button onClick={() => onNew("whiteboard", section)}>New whiteboard</button>
            </div>
          )}
        </div>
      ) : (
        <div className="cards">
          {shown.map((d) => (
            <div
              key={d.id}
              className="card"
              draggable={editable && tabs.length > 0}
              onDragStart={(e) => {
                e.dataTransfer.setData("application/x-archcanvas-diagram", d.id);
                e.dataTransfer.effectAllowed = "move";
              }}
            >
              <Link to={diagramHref(d.id, d.title)} className="card-main">
                <span className="card-kind">{d.kind === "cloud" ? "Architecture" : "Whiteboard"}</span>
                <span className="card-title">{d.title}</span>
                <span className="hint">
                  v{d.version ?? 1} · {d.kind === "cloud" ? `${d.node_count ?? 0} resources · ` : ""}updated {timeAgo(d.updated_at)}
                </span>
              </Link>
              <div className="card-actions">
                <Link to={diagramHref(d.id, d.title, true)} className="card-link">
                  History
                </Link>
                {editable && tabs.length > 0 && (
                  <select className="card-tab" value={d.tab ?? ""} aria-label={`Tab for ${d.title}`} title="Which tab this diagram is in" onChange={(e) => fileUnder(d.id, e.target.value || null)}>
                    <option value="">No tab</option>
                    {tabs.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                )}
                {!editable && d.tab && <span className="card-tab-pill">{tabs.find((t) => t.id === d.tab)?.name}</span>}
                {editable && <button onClick={() => void run(() => api.duplicateDiagram(d.id), "Duplicated").then(after)}>Duplicate</button>}
                {editable && projects.length > 1 && <button onClick={() => setMoving(d)}>Move</button>}
                {editable && (
                  <button
                    className="danger"
                    onClick={() => {
                      if (confirm(`Delete "${d.title}" and its whole version history? This cannot be undone.`))
                        void run(() => api.deleteDiagram(d.id), "Diagram deleted").then(after);
                    }}
                  >
                    Delete
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {importing && (
        <Suspense fallback={null}>
          <ImportDialog
            fileName={importing.fileName}
            pages={importing.pages}
            onClose={() => setImporting(null)}
            onImport={(title, model) => {
              setImporting(null);
              onImport(title, model, importing.fileName, section);
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
                  {p.name}
                </button>
              ))}
          </div>
        </Modal>
      )}
    </>
  );
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
              onClick={() => {
                if (confirm(`Delete project "${project.name}" with all ${project.diagram_count} diagrams and their history? This cannot be undone.`))
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
            onClick={() => {
              if (confirm(`Delete workspace "${workspace.name}" with all its projects, diagrams and history? This cannot be undone.`))
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
                    onClick={() => {
                      if (confirm(m.user_id === me ? "Leave this workspace?" : `Remove ${m.user_id}?`))
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
