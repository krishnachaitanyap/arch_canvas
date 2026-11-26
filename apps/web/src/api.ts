import type { DiagramModel, IconEntry, IconFamily, IconPackMeta, Workflow } from "@archcanvas/shared";
import { demoApi } from "./demo-api";

export type DiagramKind = "whiteboard" | "cloud";

export type Role = "owner" | "editor" | "viewer";

export interface Workspace {
  id: string;
  name: string;
  role: Role;
  project_count: number;
  member_count: number;
}

export interface Project {
  id: string;
  name: string;
  description: string;
  diagram_count: number;
  updated_at: string;
}

export interface Member {
  user_id: string;
  role: Role;
  added_by: string | null;
  created_at: string;
}

export interface DiagramSummary {
  id: string;
  title: string;
  kind: DiagramKind;
  project_id: string;
  created_by: string | null;
  updated_at: string;
  version: number | null;
  node_count: number | null;
}

export interface Diagram extends DiagramSummary {
  source: string;
  scene: { elements?: readonly unknown[]; files?: Record<string, unknown> };
  model: DiagramModel | null;
  role?: Role;
  workspace_id?: string;
  workspace_name?: string;
  project_name?: string;
  versionCreated?: boolean;
}

export interface VersionSummary {
  version: number;
  name: string | null;
  kind: DiagramKind;
  created_by: string | null;
  created_at: string;
  restored_from: number | null;
  node_count: number | null;
  edge_count: number | null;
}

export interface Version extends VersionSummary {
  source: string;
  scene: Diagram["scene"];
  model: DiagramModel | null;
}

export type DiagramWrite = Partial<Pick<Diagram, "title" | "kind" | "source" | "scene" | "model">> & { message?: string; projectId?: string };

export interface AppConfig {
  /** Browser-only demo build (no server). */
  demo?: boolean;
  devUser?: string;
  aiEnabled: boolean;
  aiProvider: string;
  aiModel: string;
  authEnabled: boolean;
}

export type AgentEvent =
  | { type: "text"; text: string }
  | { type: "tool"; name: string; summary: string; ok: boolean; error?: string }
  | { type: "model"; model: DiagramModel }
  | { type: "terraform" }
  | { type: "done"; model: DiagramModel; changed: boolean }
  | { type: "error"; message: string };

export interface TerraformValidation {
  available: boolean;
  message?: string;
  valid?: boolean;
  stage?: string;
  fmt?: string[];
  diagnostics?: { severity: string; summary: string; detail?: string; file?: string; line?: number }[];
}

const BASE = import.meta.env.VITE_API_URL ?? "";

// Token provider is pluggable: wire it to your OIDC client (keycloak-js, oidc-client-ts) in phase 2.
let getToken: () => Promise<string | null> = async () => null;
export function setTokenProvider(fn: () => Promise<string | null>): void {
  getToken = fn;
}

// Dev mode only (API without OIDC): act as another user to try out workspace roles.
const LS_DEV_USER = "archcanvas.devUser";
export const devUser = () => localStorage.getItem(LS_DEV_USER);
export function setDevUser(user: string | null): void {
  if (user) localStorage.setItem(LS_DEV_USER, user);
  else localStorage.removeItem(LS_DEV_USER);
}

async function headers(body: boolean): Promise<Record<string, string>> {
  const token = await getToken();
  const dev = devUser();
  return {
    ...(body ? { "content-type": "application/json" } : {}),
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(dev && !token ? { "x-dev-user": dev } : {}),
  };
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { ...(await headers(Boolean(init.body))), ...init.headers } });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const details = Array.isArray(body.details) ? `: ${body.details.join("; ")}` : "";
    throw new Error(typeof body.error === "string" ? body.error + details : `Request failed (${res.status})`);
  }
  return res.status === 204 ? (undefined as T) : res.json();
}

export interface IconPackUpload {
  name: string;
  family: IconFamily;
  license?: string;
  url?: string;
  icons: IconEntry[];
}

const serverApi = {
  config: () => request<AppConfig>("/api/config"),

  // icon packs uploaded to a workspace
  iconPacks: (workspaceId: string) => request<IconPackMeta[]>(`/api/workspaces/${workspaceId}/icon-packs`),
  iconPack: (id: string) => request<{ icons: IconEntry[] }>(`/api/icon-packs/${id}`),
  uploadIconPack: (workspaceId: string, pack: IconPackUpload) =>
    request<IconPackMeta & { rejected: number }>(`/api/workspaces/${workspaceId}/icon-packs`, { method: "POST", body: JSON.stringify(pack) }),
  deleteIconPack: (id: string) => request<void>(`/api/icon-packs/${id}`, { method: "DELETE" }),
  // workspaces, members, projects
  workspaces: () => request<Workspace[]>("/api/workspaces"),
  createWorkspace: (name: string) => request<Workspace>("/api/workspaces", { method: "POST", body: JSON.stringify({ name }) }),
  renameWorkspace: (id: string, name: string) => request<Workspace>(`/api/workspaces/${id}`, { method: "PATCH", body: JSON.stringify({ name }) }),
  deleteWorkspace: (id: string) => request<void>(`/api/workspaces/${id}`, { method: "DELETE" }),
  members: (id: string) => request<Member[]>(`/api/workspaces/${id}/members`),
  setMember: (id: string, userId: string, role: Role) =>
    request<Member>(`/api/workspaces/${id}/members`, { method: "PUT", body: JSON.stringify({ userId, role }) }),
  removeMember: (id: string, userId: string) =>
    request<void>(`/api/workspaces/${id}/members/${encodeURIComponent(userId)}`, { method: "DELETE" }),
  projects: (workspaceId: string) => request<Project[]>(`/api/workspaces/${workspaceId}/projects`),
  createProject: (workspaceId: string, name: string, description = "") =>
    request<Project>(`/api/workspaces/${workspaceId}/projects`, { method: "POST", body: JSON.stringify({ name, description }) }),
  updateProject: (id: string, d: { name?: string; description?: string }) =>
    request<Project>(`/api/projects/${id}`, { method: "PATCH", body: JSON.stringify(d) }),
  deleteProject: (id: string) => request<void>(`/api/projects/${id}`, { method: "DELETE" }),

  // diagrams
  listDiagrams: (projectId?: string) =>
    request<(DiagramSummary & { project_name?: string; workspace_id?: string })[]>(
      `/api/diagrams${projectId ? `?projectId=${projectId}` : ""}`,
    ),
  getDiagram: (id: string) => request<Diagram>(`/api/diagrams/${id}`),
  lookupDiagram: (short: string) => request<{ id: string }>(`/api/diagrams/lookup/${encodeURIComponent(short)}`),
  createDiagram: (d: DiagramWrite & { projectId: string }) =>
    request<Diagram>("/api/diagrams", { method: "POST", body: JSON.stringify(d) }),
  updateDiagram: (id: string, d: DiagramWrite) => request<Diagram>(`/api/diagrams/${id}`, { method: "PUT", body: JSON.stringify(d) }),
  deleteDiagram: (id: string) => request<void>(`/api/diagrams/${id}`, { method: "DELETE" }),
  duplicateDiagram: (id: string, d: { projectId?: string; title?: string; version?: number } = {}) =>
    request<Diagram>(`/api/diagrams/${id}/duplicate`, { method: "POST", body: JSON.stringify(d) }),

  // versions
  versions: (id: string) => request<VersionSummary[]>(`/api/diagrams/${id}/versions`),
  version: (id: string, version: number) => request<Version>(`/api/diagrams/${id}/versions/${version}`),
  nameVersion: (id: string, version: number, name: string) =>
    request<{ version: number; name: string | null }>(`/api/diagrams/${id}/versions/${version}`, {
      method: "PATCH",
      body: JSON.stringify({ name }),
    }),
  restoreVersion: (id: string, version: number) =>
    request<Diagram>(`/api/diagrams/${id}/versions/${version}/restore`, { method: "POST" }),
  generate: (prompt: string, currentSource?: string) =>
    request<{ source: string }>("/api/ai/generate", {
      method: "POST",
      body: JSON.stringify({ prompt, currentSource: currentSource || undefined }),
    }),
  narrateWorkflows: (model: DiagramModel, title?: string) =>
    request<{ workflows: Workflow[]; rewritten: number }>("/api/ai/workflows", { method: "POST", body: JSON.stringify({ model, title }) }),
  validateTerraform: (model: DiagramModel) =>
    request<TerraformValidation>("/api/terraform/validate", { method: "POST", body: JSON.stringify({ model }) }),

  /** Runs the diagram agent, calling onEvent for each streamed event. */
  async agent(
    req: { message: string; model: DiagramModel; history: { role: "user" | "assistant"; content: string }[]; diagramId?: string },
    onEvent: (e: AgentEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const res = await fetch(`${BASE}/api/agent`, {
      method: "POST",
      headers: await headers(true),
      body: JSON.stringify(req),
      signal,
    });
    if (!res.ok || !res.body) {
      const body = await res.json().catch(() => ({}));
      throw new Error(typeof body.error === "string" ? body.error : `Agent request failed (${res.status})`);
    }
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        for (const line of chunk.split("\n")) if (line.startsWith("data: ")) onEvent(JSON.parse(line.slice(6)) as AgentEvent);
      }
    }
  },
};

/** The demo build (VITE_DEMO=1) swaps in a browser-only backend with the same calls. */
export const api: typeof serverApi = import.meta.env.VITE_DEMO === "1" ? (demoApi as unknown as typeof serverApi) : serverApi;
