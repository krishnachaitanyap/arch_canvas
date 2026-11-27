/**
 * Keelrail MCP server: lets AI agents (Claude Code, Claude Desktop, Cursor, VS Code…) read and
 * change diagrams as code, generate Terraform, compare versions and review designs.
 *
 *   KEELRAIL_URL    the Keelrail API (default http://localhost:8082)
 *   KEELRAIL_TOKEN  an API token (your avatar → API tokens); optional when the server has no sign-in
 *
 * Run it with `npm run mcp` (stdio). Speaks the Model Context Protocol over stdio with
 * newline-delimited JSON-RPC 2.0; no SDK needed. See docs/api-and-mcp.md.
 */
import { createInterface } from "node:readline";
import {
  CATALOG,
  compileTerraform,
  type DiagramModel,
  describeChanges,
  detectSource,
  importSource,
  lineDiff,
  parseCode,
  PROTOCOLS,
  SOURCE_NAMES,
  type SourceKind,
  toCode,
  validateModel,
} from "../packages/shared/src/index.ts";

const BASE = (process.env.KEELRAIL_URL ?? process.env.ARCHCANVAS_URL ?? "http://localhost:8082").replace(/\/$/, "");
const TOKEN = process.env.KEELRAIL_TOKEN ?? process.env.ARCHCANVAS_TOKEN ?? "";
const PROTOCOL_VERSION = "2025-06-18";

// ---------------------------------------------------------------- API client

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(BASE + path, {
    ...init,
    headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}), ...(init.headers ?? {}) },
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const body = text ? JSON.parse(text) : undefined;
  if (!res.ok) throw new Error(`${res.status} ${body?.error ?? res.statusText}`);
  return body as T;
}

interface DiagramRow {
  id: string;
  title: string;
  kind: string;
  project_id: string;
  project_name?: string;
  updated_at: string;
  version?: number;
  model?: DiagramModel;
}

/** A diagram by full id, short id (the end of its URL), URL, or exact title. */
async function resolveDiagram(ref: string): Promise<DiagramRow> {
  const r = ref.trim();
  const fromUrl = /\/d\/(?:[^/?#]*-)?([0-9a-f]{8,36})(?:[/?#]|$)/i.exec(r)?.[1];
  const id = fromUrl ?? (/^[0-9a-f-]{8,36}$/i.test(r) ? r : null);
  if (id) {
    const full = id.length === 36 ? id : (await call<{ id: string }>(`/api/diagrams/lookup/${id}`)).id;
    return call<DiagramRow>(`/api/diagrams/${full}`);
  }
  const all = await call<DiagramRow[]>("/api/diagrams");
  const hits = all.filter((d) => d.title.toLowerCase() === r.toLowerCase());
  if (hits.length === 1) return call<DiagramRow>(`/api/diagrams/${hits[0].id}`);
  if (hits.length > 1) throw new Error(`several diagrams are called "${r}": use the id (${hits.map((d) => d.id.slice(0, 8)).join(", ")})`);
  throw new Error(`no diagram "${r}"; use list_diagrams to see them`);
}

function cloudModel(d: DiagramRow): DiagramModel {
  if (d.kind !== "cloud" || !d.model) throw new Error(`"${d.title}" is a whiteboard, not an architecture diagram`);
  return d.model;
}

function parseOrThrow(code: string, base?: DiagramModel): DiagramModel {
  const r = parseCode(code, base);
  if (!r.ok) throw new Error(`The code has problems:\n${r.errors.map((e) => `line ${e.line}:${e.col} ${e.message}`).join("\n")}`);
  return r.model;
}

const changesText = (a: DiagramModel, b: DiagramModel) => {
  const ch = describeChanges(a, b);
  if (!ch.length) return "No changes.";
  return ch
    .map((c) => `${c.change === "added" ? "+" : c.change === "removed" ? "-" : "~"} ${c.target} ${c.target === "connection" ? c.detail : `${c.label || c.id} (${c.detail})`}${c.fields.map((f) => `\n    ${f.field}: ${f.from} → ${f.to}`).join("")}`)
    .join("\n");
};

const codeDiff = (a: DiagramModel, b: DiagramModel) =>
  lineDiff(toCode(a), toCode(b))
    .filter((l) => l.op !== "eq")
    .map((l) => `${l.op === "add" ? "+" : "-"} ${l.text}`)
    .join("\n");

const REFERENCE = `Keelrail diagram code (.arch)

// comments start with //
terraform on                       // show cloud details; Google Cloud and AWS items generate Terraform
id "Name" [type, key: value]       // an item; ids are snake_case and unique
id "Name" [type] { … }             // a group with items inside
id [generic.component, icon: "aws:AWSLambda"]   // an icon item (AWS, Azure, logos, Lucide…)
page ops "Operations" { … }        // a canvas tab
a -> b "label" [https]             // a line, with a label and a protocol
a <- b   a <-> b   a - b           // arrow at the start, both ends, none
a --> b  a ..> b                   // dashed, dotted
a -> b [curved, color: "#1a73e8", end: diamond]

Types (short names work too, e.g. cloud_run): ${CATALOG.map((e) => e.kind).join(", ")}
Protocols: ${PROTOCOLS.join(", ")}
Line ends: arrow, open, triangle, diamond, odiamond, circle, er-one, er-many, er-one-many, er-zero-many, er-zero-one
AWS icons that generate Terraform: aws:AWSLambda, aws:AmazonSimpleStorageService, aws:AmazonRDS, aws:AmazonDynamoDB,
aws:AmazonSimpleQueueService, aws:AmazonSimpleNotificationService, aws:AmazonElastiCache, aws:AWSSecretsManager,
aws:AmazonElasticContainerRegistry, aws:AmazonElasticContainerService, aws:ElasticLoadBalancingApplicationLoadBalancer,
aws:AmazonAPIGateway, aws:AmazonCloudFront, aws:AmazonCognito, aws:AmazonEC2, aws:AmazonKinesisDataStreams.
AWS boxes: generic.group with icon "aws:VirtualprivatecloudVPC" (put a CIDR in its name), "aws:Publicsubnet", "aws:Privatesubnet", "aws:Region".
Positions are not part of the code: the canvas keeps them and places new items automatically.`;

// ---------------------------------------------------------------- tools

interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly?: boolean;
  run: (args: Record<string, unknown>) => Promise<string>;
}

const str = (v: unknown, name: string): string => {
  if (typeof v !== "string" || !v.trim()) throw new Error(`${name} is required`);
  return v;
};
const diagramArg = { diagram: { type: "string", description: "Diagram id, short id (the end of its URL), URL, or exact title" } };

const TOOLS: Tool[] = [
  {
    name: "list_diagrams",
    description: "List the architecture diagrams you can open, with their projects and ids.",
    inputSchema: { type: "object", properties: { project_id: { type: "string", description: "Only this project's diagrams" } } },
    readOnly: true,
    run: async (a) => {
      const rows = await call<DiagramRow[]>(`/api/diagrams${a.project_id ? `?projectId=${encodeURIComponent(String(a.project_id))}` : ""}`);
      if (!rows.length) return "No diagrams.";
      return rows.map((d) => `${d.id.slice(0, 8)}  ${d.title}${d.project_name ? `  (project: ${d.project_name})` : ""}  ${d.kind}  v${d.version ?? 1}  updated ${d.updated_at}`).join("\n");
    },
  },
  {
    name: "list_projects",
    description: "List workspaces and their projects (to know where to create a diagram).",
    inputSchema: { type: "object", properties: {} },
    readOnly: true,
    run: async () => {
      const ws = await call<{ id: string; name: string; role: string }[]>("/api/workspaces");
      const out: string[] = [];
      for (const w of ws) {
        out.push(`${w.name} (${w.role})`);
        for (const p of await call<{ id: string; name: string }[]>(`/api/workspaces/${w.id}/projects`)) out.push(`  ${p.id}  ${p.name}`);
      }
      return out.join("\n") || "No workspaces.";
    },
  },
  {
    name: "diagram_code_reference",
    description: "The Keelrail diagram code syntax: types, protocols, line styles, AWS icons. Read this before writing code.",
    inputSchema: { type: "object", properties: {} },
    readOnly: true,
    run: async () => REFERENCE,
  },
  {
    name: "get_diagram_code",
    description: "Get an architecture diagram as Keelrail diagram code (.arch). Edit the code and send it back with update_diagram_code.",
    inputSchema: { type: "object", properties: diagramArg, required: ["diagram"] },
    readOnly: true,
    run: async (a) => {
      const d = await resolveDiagram(str(a.diagram, "diagram"));
      return `// ${d.title} (id ${d.id}, v${d.version ?? 1})\n${toCode(cloudModel(d))}`;
    },
  },
  {
    name: "update_diagram_code",
    description:
      "Replace a diagram's content with new diagram code and save it as a new version. Items keep their positions on the canvas; new ones are placed automatically. Returns what changed. Call diagram_code_reference first if unsure of the syntax.",
    inputSchema: {
      type: "object",
      properties: { ...diagramArg, code: { type: "string", description: "The full diagram code" }, message: { type: "string", description: "A name for the new version, e.g. 'Add Redis cache'" } },
      required: ["diagram", "code"],
    },
    run: async (a) => {
      const d = await resolveDiagram(str(a.diagram, "diagram"));
      const before = cloudModel(d);
      const after = parseOrThrow(str(a.code, "code"), before);
      const saved = await call<{ version: number; versionCreated: boolean }>(`/api/diagrams/${d.id}`, {
        method: "PUT",
        body: JSON.stringify({ model: after, ...(typeof a.message === "string" && a.message.trim() ? { message: a.message.trim().slice(0, 200) } : {}) }),
      });
      return `${saved.versionCreated ? `Saved "${d.title}" as v${saved.version}.` : "Nothing changed."}\n\n${changesText(before, after)}`;
    },
  },
  {
    name: "create_diagram",
    description: "Create a new architecture diagram from diagram code in a project (see list_projects).",
    inputSchema: {
      type: "object",
      properties: { project_id: { type: "string" }, title: { type: "string" }, code: { type: "string", description: "Diagram code; positions are laid out when it's opened" } },
      required: ["project_id", "title", "code"],
    },
    run: async (a) => {
      const model = parseOrThrow(str(a.code, "code"));
      const d = await call<DiagramRow>("/api/diagrams", { method: "POST", body: JSON.stringify({ projectId: str(a.project_id, "project_id"), title: str(a.title, "title").slice(0, 200), kind: "cloud", model }) });
      return `Created "${d.title}" (id ${d.id}) with ${model.nodes.length} items and ${model.edges.length} lines.`;
    },
  },
  {
    name: "check_diagram_code",
    description: "Check diagram code without saving it: syntax errors with line numbers, then the architecture review (errors, warnings, suggestions).",
    inputSchema: { type: "object", properties: { code: { type: "string" } }, required: ["code"] },
    readOnly: true,
    run: async (a) => {
      const r = parseCode(str(a.code, "code"));
      if (!r.ok) return `Problems:\n${r.errors.map((e) => `line ${e.line}:${e.col} ${e.message}`).join("\n")}`;
      const issues = validateModel(r.model);
      return `OK: ${r.model.nodes.length} items, ${r.model.edges.length} lines.${issues.length ? `\n\n${issues.map((i) => `${i.severity}: ${i.nodeId ? `${i.nodeId}: ` : ""}${i.message}`).join("\n")}` : ""}`;
    },
  },
  {
    name: "review_diagram",
    description: "Security and reliability review of a saved diagram (or of diagram code).",
    inputSchema: { type: "object", properties: { ...diagramArg, code: { type: "string", description: "Review this code instead of a saved diagram" } } },
    readOnly: true,
    run: async (a) => {
      const m = typeof a.code === "string" && a.code.trim() ? parseOrThrow(a.code) : cloudModel(await resolveDiagram(str(a.diagram, "diagram")));
      const issues = validateModel(m);
      return issues.length ? issues.map((i) => `${i.severity}: ${i.nodeId ? `${i.nodeId}: ` : ""}${i.message}`).join("\n") : "No issues found.";
    },
  },
  {
    name: "get_terraform",
    description: "Terraform for a diagram (Google Cloud and AWS items), from a saved diagram or from diagram code. Deterministic, least-privilege IAM, private networking.",
    inputSchema: { type: "object", properties: { ...diagramArg, code: { type: "string", description: "Compile this code instead of a saved diagram" } } },
    readOnly: true,
    run: async (a) => {
      const m = typeof a.code === "string" && a.code.trim() ? parseOrThrow(a.code) : cloudModel(await resolveDiagram(str(a.diagram, "diagram")));
      const tf = compileTerraform(m);
      const warn = tf.warnings.length ? `\n\nWarnings:\n${tf.warnings.map((w) => `- ${w.nodeId ? `${w.nodeId}: ` : ""}${w.message}`).join("\n")}` : "";
      return tf.files.map((f) => `=== ${f.path} ===\n${f.content}`).join("\n") + warn;
    },
  },
  {
    name: "diff_diagram",
    description: "What changed in a diagram between two versions (default: the previous version and the latest), as a change list, a diagram-code diff and a Terraform change summary.",
    inputSchema: {
      type: "object",
      properties: { ...diagramArg, from_version: { type: "number" }, to_version: { type: "number", description: "Default: the current content" } },
      required: ["diagram"],
    },
    readOnly: true,
    run: async (a) => {
      const d = await resolveDiagram(str(a.diagram, "diagram"));
      const versions = await call<{ version: number }[]>(`/api/diagrams/${d.id}/versions`);
      const to = typeof a.to_version === "number" ? cloudModel(await call<DiagramRow>(`/api/diagrams/${d.id}/versions/${a.to_version}`)) : cloudModel(d);
      const fromNo = typeof a.from_version === "number" ? a.from_version : (versions[1]?.version ?? versions[0]?.version);
      if (!fromNo) return "This diagram has no saved versions to compare with.";
      const from = cloudModel(await call<DiagramRow>(`/api/diagrams/${d.id}/versions/${fromNo}`));
      const tfa = new Set(compileTerraform(from).resources);
      const tfb = new Set(compileTerraform(to).resources);
      const created = [...tfb].filter((r) => !tfa.has(r));
      const destroyed = [...tfa].filter((r) => !tfb.has(r));
      return [
        `${d.title}: v${fromNo} → ${typeof a.to_version === "number" ? `v${a.to_version}` : "current"}`,
        "",
        changesText(from, to),
        "",
        "Diagram code:",
        codeDiff(from, to) || "(no differences)",
        "",
        "Terraform:",
        created.length || destroyed.length ? [...created.map((r) => `+ create ${r}`), ...destroyed.map((r) => `- destroy ${r}`)].join("\n") : "no resources created or destroyed",
      ].join("\n");
    },
  },
  {
    name: "code_from_source",
    description: `Turn infrastructure code into Keelrail diagram code: ${Object.values(SOURCE_NAMES).join(", ")}. Use it to draw an existing system, then create_diagram.`,
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The file contents" },
        file_name: { type: "string", description: "e.g. main.tf, docker-compose.yml, k8s.yaml, schema.sql (helps detect the type)" },
        kind: { type: "string", enum: Object.keys(SOURCE_NAMES) },
      },
      required: ["text"],
    },
    readOnly: true,
    run: async (a) => {
      const text = str(a.text, "text");
      const name = typeof a.file_name === "string" ? a.file_name : "input";
      const kind = (typeof a.kind === "string" ? a.kind : detectSource(name, text)) as SourceKind | null;
      return toCode(importSource(name, text, kind));
    },
  },
];

// ---------------------------------------------------------------- MCP over stdio

type Msg = { jsonrpc: "2.0"; id?: number | string; method?: string; params?: Record<string, unknown> };
const send = (m: unknown) => process.stdout.write(JSON.stringify(m) + "\n");
const reply = (id: Msg["id"], result: unknown) => send({ jsonrpc: "2.0", id, result });
const fail = (id: Msg["id"], code: number, message: string) => send({ jsonrpc: "2.0", id, error: { code, message } });

async function handle(msg: Msg): Promise<void> {
  const { id, method, params = {} } = msg;
  if (id === undefined) return; // notifications (initialized, cancelled…)
  switch (method) {
    case "initialize":
      return reply(id, {
        protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "keelrail", version: "0.1.0" },
        instructions:
          "Keelrail architecture diagrams as code. To change a diagram: get_diagram_code, edit the code, update_diagram_code. Read diagram_code_reference for the syntax. get_terraform builds Terraform; diff_diagram compares versions.",
      });
    case "ping":
      return reply(id, {});
    case "tools/list":
      return reply(id, {
        tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, annotations: { readOnlyHint: Boolean(t.readOnly) } })),
      });
    case "tools/call": {
      const tool = TOOLS.find((t) => t.name === params.name);
      if (!tool) return fail(id, -32602, `unknown tool ${String(params.name)}`);
      try {
        const text = await tool.run((params.arguments as Record<string, unknown>) ?? {});
        return reply(id, { content: [{ type: "text", text }] });
      } catch (e) {
        return reply(id, { content: [{ type: "text", text: (e as Error).message }], isError: true });
      }
    }
    default:
      return fail(id, -32601, `method not found: ${method}`);
  }
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg: Msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return fail(null as never, -32700, "parse error");
  }
  void handle(msg).catch((e) => fail(msg.id, -32603, (e as Error).message));
});
