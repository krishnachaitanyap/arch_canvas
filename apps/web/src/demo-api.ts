/**
 * Browser-only backend for the public demo (VITE_DEMO=1, e.g. GitHub Pages). It implements
 * the same calls as the API server on top of localStorage, with seeded example diagrams, so
 * the editor, import, Terraform, workflows, presentations, history and compare all work with
 * no server. AI features and `terraform validate` need the real server and say so.
 */
import {
  applyOps,
  type DiagramModel,
  drawioToModel,
  emptyModel,
  readDrawio,
  SAMPLE_MODEL,
  validateModel,
} from "@archcanvas/shared";
import awsExample from "../../../docs/examples/aws-orders.drawio?raw";
import { type IconEntry, type IconPackMeta, sanitizeIconData } from "@archcanvas/shared";
import type {
  AgentEvent,
  IconPackUpload,
  AppConfig,
  Diagram,
  DiagramKind,
  DiagramSummary,
  DiagramWrite,
  Member,
  Project,
  ProjectTab,
  Role,
  TerraformValidation,
  Version,
  VersionSummary,
  Workspace,
} from "./api";

const KEY = "archcanvas.demo.v1";
export const DEMO_USER = "demo@archcanvas.dev";

interface Row {
  id: string;
  tenant_id: string;
  project_id: string;
  tab?: string | null;
  title: string;
  kind: DiagramKind;
  source: string;
  scene: Diagram["scene"];
  model: DiagramModel | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}
interface VersionRow extends Omit<Version, "node_count" | "edge_count"> {
  diagram_id: string;
}
interface State {
  iconPacks?: (IconPackMeta & { workspace_id: string })[];
  workspaces: { id: string; name: string; created_at: string }[];
  members: { workspace_id: string; user_id: string; role: Role; added_by: string; created_at: string }[];
  projects: { id: string; workspace_id: string; name: string; description: string; tabs?: ProjectTab[]; created_at: string; updated_at: string }[];
  diagrams: Row[];
  versions: VersionRow[];
}

class DemoError extends Error {}
const fail = (msg: string): never => {
  throw new DemoError(msg);
};
const now = () => new Date().toISOString();
const uuid = () => crypto.randomUUID();
const me = () => localStorage.getItem("archcanvas.devUser") || DEMO_USER;
const RANK: Record<Role, number> = { viewer: 1, editor: 2, owner: 3 };

let cache: State | null = null;
let seeding: Promise<State> | null = null;

async function state(): Promise<State> {
  if (cache) return cache;
  const raw = localStorage.getItem(KEY);
  if (raw) return (cache = JSON.parse(raw) as State);
  seeding ??= seed().then((s) => {
    cache = s;
    save();
    return s;
  });
  return seeding;
}

function save() {
  localStorage.setItem(KEY, JSON.stringify(cache));
}

/** Clears the demo data; the next call reseeds the examples. */
export function resetDemo(): void {
  localStorage.removeItem(KEY);
  cache = null;
  seeding = null;
}

// ------------------------------------------------------------------ seed data

async function seed(): Promise<State> {
  const t0 = Date.now();
  const at = (minutesAgo: number) => new Date(t0 - minutesAgo * 60_000).toISOString();
  const ws = { id: uuid(), name: "Demo workspace", created_at: at(600) };
  const examples = { id: uuid(), workspace_id: ws.id, name: "Examples", description: "A GCP web app with version history to compare.", created_at: at(600), updated_at: at(5) };
  const imported = { id: uuid(), workspace_id: ws.id, name: "Imported from draw.io", description: "An AWS diagram imported from draw.io and translated to GCP.", created_at: at(300), updated_at: at(30) };
  const s: State = {
    workspaces: [ws],
    members: [
      { workspace_id: ws.id, user_id: DEMO_USER, role: "owner", added_by: DEMO_USER, created_at: at(600) },
      { workspace_id: ws.id, user_id: "reviewer@example.com", role: "viewer", added_by: DEMO_USER, created_at: at(500) },
    ],
    projects: [examples, imported],
    diagrams: [],
    versions: [],
  };

  // GCP web app with three versions: initial design, add a cache, production hardening.
  const step = (m: DiagramModel, ops: Parameters<typeof applyOps>[1]) => {
    const r = applyOps(m, ops);
    if (!r.ok) throw new Error(r.error);
    return r.model;
  };
  const v3 = structuredClone(SAMPLE_MODEL);
  const v2 = step(v3, [
    { op: "remove_node", id: "api_key" },
    { op: "update_node", id: "lb", props: { cloud_armor: false } },
  ]);
  const v1 = step(v2, [{ op: "remove_node", id: "cache" }]);
  const v3hardened = step(v3, [
    { op: "update_node", id: "db", props: { high_availability: true } },
    { op: "update_node", id: "cache", props: { tier: "STANDARD_HA" } },
  ]);
  const web = row(examples.id, "GCP web app", "cloud", v3hardened, at(5));
  s.diagrams.push(web);
  s.versions.push(
    ver(web, 1, "Initial design", v1, at(240)),
    ver(web, 2, "Add Redis cache", v2, at(120)),
    ver(web, 3, "Production hardening", v3hardened, at(5)),
  );

  // An AWS diagram imported from draw.io.
  const pages = await readDrawio(awsExample);
  const aws = drawioToModel(pages[0]).model;
  const awsRow = row(imported.id, "Orders platform (from AWS)", "cloud", aws, at(30));
  s.diagrams.push(awsRow);
  s.versions.push(ver(awsRow, 1, 'Imported from "aws-orders.drawio"', aws, at(30)));
  return s;

  function row(projectId: string, title: string, kind: DiagramKind, model: DiagramModel, when: string): Row {
    return { id: uuid(), tenant_id: "demo", project_id: projectId, title, kind, source: "", scene: {}, model, created_by: DEMO_USER, created_at: when, updated_at: when };
  }
  function ver(d: Row, version: number, name: string | null, model: DiagramModel, when: string): VersionRow {
    return { diagram_id: d.id, version, name, kind: d.kind, source: "", scene: {}, model, created_by: DEMO_USER, created_at: when, restored_from: null };
  }
}

// ------------------------------------------------------------------ access

function roleIn(s: State, workspaceId: string): Role | null {
  const ids = [me(), me().toLowerCase()];
  return s.members.filter((m) => m.workspace_id === workspaceId && ids.includes(m.user_id)).map((m) => m.role).sort((a, b) => RANK[b] - RANK[a])[0] ?? null;
}
function needWorkspace(s: State, id: string, min: Role): Role {
  const r = roleIn(s, id);
  if (!r) fail("workspace not found");
  if (RANK[r!] < RANK[min]) fail(`this needs the ${min} role in the workspace (you are ${r})`);
  return r!;
}
function needProject(s: State, id: string, min: Role) {
  const p = s.projects.find((x) => x.id === id) ?? fail("project not found");
  return { project: p, role: needWorkspace(s, p.workspace_id, min) };
}
function needDiagram(s: State, id: string, min: Role) {
  const d = s.diagrams.find((x) => x.id === id) ?? fail("diagram not found");
  const { project, role } = needProject(s, d.project_id, min);
  return { diagram: d, project, role };
}

const latest = (s: State, id: string) => Math.max(0, ...s.versions.filter((v) => v.diagram_id === id).map((v) => v.version));
const counts = (m: DiagramModel | null) => (m ? { node_count: m.nodes.length, edge_count: m.edges.length } : { node_count: null, edge_count: null });
const summary = (s: State, d: Row): DiagramSummary => ({
  id: d.id,
  title: d.title,
  kind: d.kind,
  project_id: d.project_id,
  tab: d.tab ?? null,
  created_by: d.created_by,
  updated_at: d.updated_at,
  version: latest(s, d.id) || null,
  node_count: d.kind === "cloud" ? (d.model?.nodes.length ?? 0) : null,
});
const full = (s: State, d: Row, extra: Partial<Diagram> = {}): Diagram => ({ ...summary(s, d), source: d.source, scene: d.scene, model: d.model, ...extra });

function addVersion(s: State, d: Row, name: string | null, restoredFrom: number | null = null): number {
  const version = latest(s, d.id) + 1;
  s.versions.push({ diagram_id: d.id, version, name, kind: d.kind, source: d.source, scene: d.scene, model: structuredClone(d.model), created_by: me(), created_at: now(), restored_from: restoredFrom });
  return version;
}
function assertValid(model: DiagramModel | null | undefined) {
  if (!model) return;
  const errors = validateModel(model).filter((i) => i.severity === "error");
  if (errors.length) fail(`invalid model: ${errors.map((e) => e.message).join("; ")}`);
}
const same = (a: Row, v: VersionRow) => a.kind === v.kind && a.source === v.source && JSON.stringify(a.scene) === JSON.stringify(v.scene) && JSON.stringify(a.model) === JSON.stringify(v.model);

async function tx<T>(fn: (s: State) => T): Promise<T> {
  const s = await state();
  const out = fn(s);
  save();
  return structuredClone(out);
}

// ------------------------------------------------------------------ the API

export const demoApi = {
  config: async (): Promise<AppConfig & { demo: true }> => ({ aiEnabled: false, aiProvider: "demo", aiModel: "none", authEnabled: false, devUser: DEMO_USER, demo: true }),

  workspaces: () =>
    tx((s): Workspace[] => {
      let mine = s.workspaces.filter((w) => roleIn(s, w.id));
      if (!mine.length) {
        const w = { id: uuid(), name: "My workspace", created_at: now() };
        s.workspaces.push(w);
        s.members.push({ workspace_id: w.id, user_id: me(), role: "owner", added_by: me(), created_at: now() });
        s.projects.push({ id: uuid(), workspace_id: w.id, name: "General", description: "", created_at: now(), updated_at: now() });
        mine = [w];
      }
      return mine
        .map((w) => ({
          id: w.id,
          name: w.name,
          role: roleIn(s, w.id)!,
          project_count: s.projects.filter((p) => p.workspace_id === w.id).length,
          member_count: s.members.filter((m) => m.workspace_id === w.id).length,
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
    }),
  createWorkspace: (name: string) =>
    tx((s): Workspace => {
      const w = { id: uuid(), name, created_at: now() };
      s.workspaces.push(w);
      s.members.push({ workspace_id: w.id, user_id: me(), role: "owner", added_by: me(), created_at: now() });
      s.projects.push({ id: uuid(), workspace_id: w.id, name: "General", description: "", created_at: now(), updated_at: now() });
      return { id: w.id, name, role: "owner", project_count: 1, member_count: 1 };
    }),
  renameWorkspace: (id: string, name: string) =>
    tx((s) => {
      needWorkspace(s, id, "owner");
      const w = s.workspaces.find((x) => x.id === id)!;
      w.name = name;
      return { id, name, role: "owner" as Role, project_count: 0, member_count: 0 };
    }),
  deleteWorkspace: (id: string) =>
    tx((s) => {
      needWorkspace(s, id, "owner");
      const projectIds = new Set(s.projects.filter((p) => p.workspace_id === id).map((p) => p.id));
      const diagramIds = new Set(s.diagrams.filter((d) => projectIds.has(d.project_id)).map((d) => d.id));
      s.workspaces = s.workspaces.filter((w) => w.id !== id);
      s.members = s.members.filter((m) => m.workspace_id !== id);
      s.projects = s.projects.filter((p) => !projectIds.has(p.id));
      s.diagrams = s.diagrams.filter((d) => !diagramIds.has(d.id));
      s.versions = s.versions.filter((v) => !diagramIds.has(v.diagram_id));
    }),
  members: (id: string) =>
    tx((s): Member[] => {
      needWorkspace(s, id, "viewer");
      return s.members.filter((m) => m.workspace_id === id).map(({ user_id, role, added_by, created_at }) => ({ user_id, role, added_by, created_at }));
    }),
  setMember: (id: string, userId: string, role: Role) =>
    tx((s): Member => {
      needWorkspace(s, id, "owner");
      const uid = userId.includes("@") ? userId.toLowerCase() : userId;
      const owners = s.members.filter((m) => m.workspace_id === id && m.role === "owner");
      if (role !== "owner" && owners.length === 1 && owners[0].user_id === uid) fail("a workspace needs at least one owner");
      const existing = s.members.find((m) => m.workspace_id === id && m.user_id === uid);
      if (existing) existing.role = role;
      else s.members.push({ workspace_id: id, user_id: uid, role, added_by: me(), created_at: now() });
      return { user_id: uid, role, added_by: me(), created_at: now() };
    }),
  removeMember: (id: string, userId: string) =>
    tx((s) => {
      needWorkspace(s, id, userId === me() ? "viewer" : "owner");
      const owners = s.members.filter((m) => m.workspace_id === id && m.role === "owner");
      if (owners.length === 1 && owners[0].user_id === userId) fail("a workspace needs at least one owner");
      s.members = s.members.filter((m) => !(m.workspace_id === id && m.user_id === userId));
    }),
  projects: (workspaceId: string) =>
    tx((s): Project[] => {
      needWorkspace(s, workspaceId, "viewer");
      return s.projects
        .filter((p) => p.workspace_id === workspaceId)
        .map((p) => {
          const ds = s.diagrams.filter((d) => d.project_id === p.id);
          const updated = [p.updated_at, ...ds.map((d) => d.updated_at)].sort().pop()!;
          return { id: p.id, name: p.name, description: p.description, tabs: p.tabs ?? [], diagram_count: ds.length, updated_at: updated };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
    }),
  createProject: (workspaceId: string, name: string, description = "") =>
    tx((s): Project => {
      needWorkspace(s, workspaceId, "editor");
      const p = { id: uuid(), workspace_id: workspaceId, name, description, created_at: now(), updated_at: now() };
      s.projects.push(p);
      return { id: p.id, name, description, tabs: [], diagram_count: 0, updated_at: p.updated_at };
    }),
  updateProject: (id: string, d: { name?: string; description?: string; tabs?: ProjectTab[] }) =>
    tx((s) => {
      const { project } = needProject(s, id, "editor");
      Object.assign(project, d, { updated_at: now() });
      if (d.tabs) {
        const ids = new Set(d.tabs.map((t) => t.id));
        for (const x of s.diagrams) if (x.project_id === id && x.tab && !ids.has(x.tab)) x.tab = null;
      }
      return { id, name: project.name, description: project.description, tabs: project.tabs ?? [], diagram_count: 0, updated_at: project.updated_at } as Project;
    }),
  deleteProject: (id: string) =>
    tx((s) => {
      needProject(s, id, "owner");
      const ids = new Set(s.diagrams.filter((d) => d.project_id === id).map((d) => d.id));
      s.projects = s.projects.filter((p) => p.id !== id);
      s.diagrams = s.diagrams.filter((d) => !ids.has(d.id));
      s.versions = s.versions.filter((v) => !ids.has(v.diagram_id));
    }),

  listDiagrams: (projectId?: string) =>
    tx((s) => {
      if (projectId) {
        needProject(s, projectId, "viewer");
        return s.diagrams.filter((d) => d.project_id === projectId).sort((a, b) => b.updated_at.localeCompare(a.updated_at)).map((d) => summary(s, d));
      }
      return s.diagrams
        .filter((d) => {
          const p = s.projects.find((x) => x.id === d.project_id);
          return p && roleIn(s, p.workspace_id);
        })
        .map((d) => ({ ...summary(s, d), project_name: s.projects.find((p) => p.id === d.project_id)?.name }));
    }),
  lookupDiagram: (short: string) =>
    tx((s) => {
      const hits = s.diagrams.filter((d) => d.id.startsWith(short.toLowerCase()) && roleIn(s, s.projects.find((p) => p.id === d.project_id)?.workspace_id ?? ""));
      if (!hits.length) fail("diagram not found");
      if (hits.length > 1) fail("that short id matches more than one diagram; use the full link");
      return { id: hits[0].id };
    }),
  getDiagram: (id: string) =>
    tx((s) => {
      const { diagram, project, role } = needDiagram(s, id, "viewer");
      const ws = s.workspaces.find((w) => w.id === project.workspace_id)!;
      return full(s, diagram, { role, workspace_id: ws.id, workspace_name: ws.name, project_name: project.name });
    }),
  createDiagram: (d: DiagramWrite & { projectId: string }) =>
    tx((s) => {
      needProject(s, d.projectId, "editor");
      assertValid(d.model);
      const r: Row = {
        id: uuid(),
        tenant_id: "demo",
        project_id: d.projectId,
        tab: d.tab ?? null,
        title: d.title ?? "Untitled diagram",
        kind: d.kind ?? "whiteboard",
        source: d.source ?? "",
        scene: d.scene ?? {},
        model: d.model ?? null,
        created_by: me(),
        created_at: now(),
        updated_at: now(),
      };
      s.diagrams.push(r);
      const version = addVersion(s, r, d.message ?? null);
      return { ...full(s, r), version };
    }),
  updateDiagram: (id: string, d: DiagramWrite) =>
    tx((s) => {
      const { diagram } = needDiagram(s, id, "editor");
      if (d.projectId && d.projectId !== diagram.project_id) needProject(s, d.projectId, "editor");
      assertValid(d.model);
      Object.assign(diagram, {
        ...(d.title !== undefined ? { title: d.title } : {}),
        ...(d.source !== undefined ? { source: d.source } : {}),
        ...(d.scene !== undefined ? { scene: d.scene } : {}),
        ...(d.model !== undefined ? { model: d.model } : {}),
        ...(d.projectId ? { project_id: d.projectId } : {}),
        ...(d.tab !== undefined ? { tab: d.tab } : d.projectId && d.projectId !== diagram.project_id ? { tab: null } : {}),
        updated_at: now(),
      });
      const last = s.versions.filter((v) => v.diagram_id === id).sort((a, b) => b.version - a.version)[0];
      const changed = !last || !same(diagram, last);
      const create = !last || ((changed || Boolean(d.message)) && !d.autosave);
      const version = create ? addVersion(s, diagram, d.message ?? null) : last.version;
      return { ...full(s, diagram), version, versionCreated: create };
    }),
  deleteDiagram: (id: string) =>
    tx((s) => {
      needDiagram(s, id, "editor");
      s.diagrams = s.diagrams.filter((d) => d.id !== id);
      s.versions = s.versions.filter((v) => v.diagram_id !== id);
    }),
  duplicateDiagram: (id: string, opts: { projectId?: string; title?: string; version?: number } = {}) =>
    tx((s) => {
      const { diagram } = needDiagram(s, id, "viewer");
      const target = opts.projectId ?? diagram.project_id;
      needProject(s, target, "editor");
      const src = opts.version ? (s.versions.find((v) => v.diagram_id === id && v.version === opts.version) ?? fail("version not found")) : diagram;
      const r: Row = {
        ...structuredClone(diagram),
        id: uuid(),
        project_id: target,
        tab: target === diagram.project_id ? (diagram.tab ?? null) : null,
        title: opts.title ?? `${diagram.title} (copy${opts.version ? ` of v${opts.version}` : ""})`,
        kind: src.kind,
        source: src.source,
        scene: structuredClone(src.scene),
        model: structuredClone(src.model),
        created_by: me(),
        created_at: now(),
        updated_at: now(),
      };
      s.diagrams.push(r);
      const version = addVersion(s, r, `Copied from "${diagram.title}"${opts.version ? ` v${opts.version}` : ""}`);
      return { ...full(s, r), version };
    }),

  versions: (id: string) =>
    tx((s): VersionSummary[] => {
      needDiagram(s, id, "viewer");
      return s.versions
        .filter((v) => v.diagram_id === id)
        .sort((a, b) => b.version - a.version)
        .map(({ version, name, kind, created_by, created_at, restored_from, model }) => ({ version, name, kind, created_by, created_at, restored_from, ...counts(model) }));
    }),
  version: (id: string, version: number) =>
    tx((s): Version => {
      needDiagram(s, id, "viewer");
      const v = s.versions.find((x) => x.diagram_id === id && x.version === version) ?? fail("version not found");
      return { ...v, ...counts(v.model) };
    }),
  nameVersion: (id: string, version: number, name: string) =>
    tx((s) => {
      needDiagram(s, id, "editor");
      const v = s.versions.find((x) => x.diagram_id === id && x.version === version) ?? fail("version not found");
      v.name = name.trim() || null;
      return { version, name: v.name };
    }),
  restoreVersion: (id: string, version: number) =>
    tx((s) => {
      const { diagram } = needDiagram(s, id, "editor");
      const v = s.versions.find((x) => x.diagram_id === id && x.version === version) ?? fail("version not found");
      Object.assign(diagram, { kind: v.kind, source: v.source, scene: structuredClone(v.scene), model: structuredClone(v.model), updated_at: now() });
      const created = addVersion(s, diagram, `Restored v${version}`, version);
      return { ...full(s, diagram), version: created };
    }),

  // Icon packs: metadata in the demo state, icons under their own key (they can be large).
  iconPacks: (workspaceId: string) =>
    tx((s): IconPackMeta[] => {
      needWorkspace(s, workspaceId, "viewer");
      return (s.iconPacks ?? []).filter((p) => p.workspace_id === workspaceId).map(({ workspace_id: _w, ...m }) => m);
    }),
  iconPack: async (id: string): Promise<{ icons: IconEntry[] }> => {
    const raw = localStorage.getItem(`archcanvas.demo.icons.${id}`) ?? fail("icon pack not found");
    return { icons: JSON.parse(raw) as IconEntry[] };
  },
  uploadIconPack: (workspaceId: string, pack: IconPackUpload) =>
    tx((s) => {
      needWorkspace(s, workspaceId, "editor");
      const icons = pack.icons.map((i) => ({ ...i, s: sanitizeIconData(i.s) })).filter((i): i is IconEntry => Boolean(i.s));
      if (!icons.length) fail("no valid SVG or PNG icons in the upload");
      const id = uuid();
      try {
        localStorage.setItem(`archcanvas.demo.icons.${id}`, JSON.stringify(icons));
      } catch {
        fail("This icon pack is too large for the demo's browser storage. Run ArchCanvas locally to use it.");
      }
      const meta = { id, name: pack.name, family: pack.family, license: pack.license ?? "", url: pack.url, count: icons.length, builtIn: false, created_by: me(), created_at: now() };
      (s.iconPacks ??= []).push({ ...meta, workspace_id: workspaceId });
      return { ...meta, rejected: pack.icons.length - icons.length };
    }),
  deleteIconPack: (id: string) =>
    tx((s) => {
      const p = (s.iconPacks ?? []).find((x) => x.id === id) ?? fail("icon pack not found");
      needWorkspace(s, p.workspace_id, "editor");
      s.iconPacks = (s.iconPacks ?? []).filter((x) => x.id !== id);
      localStorage.removeItem(`archcanvas.demo.icons.${id}`);
    }),

  // Server-only features
  generate: async (): Promise<{ source: string }> => fail(SERVER_ONLY),
  narrateWorkflows: async (): Promise<never> => fail(SERVER_ONLY),
  validateTerraform: async (): Promise<TerraformValidation> => ({
    available: false,
    message: "The live demo runs entirely in your browser, so it can't run terraform validate.",
  }),
  async agent(_req: unknown, onEvent: (e: AgentEvent) => void): Promise<void> {
    onEvent({ type: "error", message: SERVER_ONLY });
  },
};

const SERVER_ONLY =
  "The live demo runs entirely in your browser, so the AI features are off. Run ArchCanvas locally with a Gemini key to use them (see the README).";

export const isDemo = () => true;
export { emptyModel };
