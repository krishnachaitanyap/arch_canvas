import type { DiagramModel } from "@archcanvas/shared";

export type DiagramKind = "whiteboard" | "cloud";

export interface DiagramSummary {
  id: string;
  title: string;
  kind: DiagramKind;
  updated_at: string;
}

export interface Diagram extends DiagramSummary {
  source: string;
  scene: { elements?: readonly unknown[]; files?: Record<string, unknown> };
  model: DiagramModel | null;
}

export interface AppConfig {
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

async function headers(body: boolean): Promise<Record<string, string>> {
  const token = await getToken();
  return {
    ...(body ? { "content-type": "application/json" } : {}),
    ...(token ? { authorization: `Bearer ${token}` } : {}),
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

export const api = {
  config: () => request<AppConfig>("/api/config"),
  listDiagrams: () => request<DiagramSummary[]>("/api/diagrams"),
  getDiagram: (id: string) => request<Diagram>(`/api/diagrams/${id}`),
  createDiagram: (d: Partial<Diagram>) => request<Diagram>("/api/diagrams", { method: "POST", body: JSON.stringify(d) }),
  updateDiagram: (id: string, d: Partial<Diagram>) =>
    request<Diagram>(`/api/diagrams/${id}`, { method: "PUT", body: JSON.stringify(d) }),
  generate: (prompt: string, currentSource?: string) =>
    request<{ source: string }>("/api/ai/generate", {
      method: "POST",
      body: JSON.stringify({ prompt, currentSource: currentSource || undefined }),
    }),
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
