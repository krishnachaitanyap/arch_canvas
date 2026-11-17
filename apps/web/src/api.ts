export interface DiagramSummary {
  id: string;
  title: string;
  updated_at: string;
}

export interface Diagram extends DiagramSummary {
  source: string;
  scene: { elements?: readonly unknown[]; files?: Record<string, unknown> };
}

const BASE = import.meta.env.VITE_API_URL ?? "";

// Token provider is pluggable: wire it to your OIDC client (keycloak-js, oidc-client-ts) in phase 2.
let getToken: () => Promise<string | null> = async () => null;
export function setTokenProvider(fn: () => Promise<string | null>): void {
  getToken = fn;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = await getToken();
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(typeof body.error === "string" ? body.error : `Request failed (${res.status})`);
  }
  return res.status === 204 ? (undefined as T) : res.json();
}

export const api = {
  listDiagrams: () => request<DiagramSummary[]>("/api/diagrams"),
  getDiagram: (id: string) => request<Diagram>(`/api/diagrams/${id}`),
  createDiagram: (d: Partial<Diagram>) =>
    request<Diagram>("/api/diagrams", { method: "POST", body: JSON.stringify(d) }),
  updateDiagram: (id: string, d: Partial<Diagram>) =>
    request<Diagram>(`/api/diagrams/${id}`, { method: "PUT", body: JSON.stringify(d) }),
  generate: (prompt: string, currentSource?: string) =>
    request<{ source: string }>("/api/ai/generate", {
      method: "POST",
      body: JSON.stringify({ prompt, currentSource: currentSource || undefined }),
    }),
};
