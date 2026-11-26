import {
  applyOp,
  CATALOG,
  compileTerraform,
  describeIntegrations,
  generateWorkflows,
  type DiagramModel,
  type Op,
  type Protocol,
  PROTOCOLS,
  validateModel,
} from "@archcanvas/shared";
import { type LlmMessage, startToolSession, type ToolCall, type ToolSpec } from "./llm.js";

/**
 * The diagram agent. It edits a working copy of the model only through validated operations,
 * so every change it makes obeys the catalog's rules. The caller streams events to the
 * browser, which shows the result as a proposal the user accepts or rejects.
 */
export type AgentEvent =
  | { type: "text"; text: string }
  | { type: "tool"; name: string; summary: string; ok: boolean; error?: string }
  | { type: "model"; model: DiagramModel }
  | { type: "terraform" }
  | { type: "done"; model: DiagramModel; changed: boolean };

const MAX_STEPS = 12;

const OPERATION_SCHEMA = {
  type: "object",
  properties: {
    op: { type: "string", enum: ["add_node", "update_node", "remove_node", "connect", "disconnect"] },
    id: { type: "string", description: "Node id (add_node, update_node, remove_node). snake_case, unique." },
    kind: { type: "string", enum: CATALOG.map((c) => c.kind), description: "Resource kind (add_node)." },
    label: { type: "string", description: "Short display name (add_node, update_node)." },
    parentId: {
      type: "string",
      description: "Id of the containing group (add_node, update_node). For update_node, an empty string moves it to the top level.",
    },
    props: {
      type: "object",
      description: "Resource properties from the catalog (add_node, update_node). Only keys listed for the kind.",
      additionalProperties: true,
    },
    from: { type: "string", description: "Caller node id (connect, disconnect)." },
    to: { type: "string", description: "Callee node id (connect, disconnect)." },
    protocol: { type: "string", enum: [...PROTOCOLS], description: "Connection protocol (connect)." },
    edgeLabel: { type: "string", description: "Short connection label such as 'enqueue' (connect)." },
  },
  required: ["op"],
};

const TOOLS: ToolSpec[] = [
  {
    name: "edit_diagram",
    description:
      "Apply a batch of operations to the diagram, in order. Each one is validated against the catalog; failed operations are reported and skipped, successful ones are kept. Add groups before the resources inside them, and nodes before connecting them.",
    parameters: {
      type: "object",
      properties: { operations: { type: "array", items: OPERATION_SCHEMA, description: "Operations to apply in order." } },
      required: ["operations"],
    },
  },
  {
    name: "get_diagram",
    description: "Return the current diagram: nodes (id, kind, label, parentId, props) and edges.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "validate_diagram",
    description:
      "Run the deterministic architecture review: errors, deployability warnings from the Terraform compiler, and best-practice suggestions.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "get_workflows",
    description:
      "Return the workflows (request and async flows, step by step) and how each integration works (mechanism, security, configuration, caveats). Use it to answer questions about how components interact.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "generate_terraform",
    description:
      "Compile the diagram to Terraform for the google provider and open it in the user's Terraform tab. Returns file names, resource count and warnings.",
    parameters: { type: "object", properties: {} },
  },
];

export function systemPrompt(): string {
  const catalog = CATALOG.map((c) => {
    const props = c.props.map((p) => `${p.key}:${p.type === "enum" ? p.options!.join("|") : p.type}=${JSON.stringify(p.default)}`);
    return `- ${c.kind} (${c.label})${c.container ? " [group]" : ""}: ${c.description}${
      c.parents.length ? ` Parents: ${c.parents.join(", ")}.` : ""
    }${props.length ? ` Props: ${props.join("; ")}.` : ""}`;
  }).join("\n");
  return `You are ArchCanvas's architecture agent. You design Google Cloud architectures on a typed diagram that compiles to Terraform.

You change the diagram ONLY by calling edit_diagram. Never describe a change without making it.

Catalog (the only node kinds you may use):
${catalog}

How to build diagrams:
- Nest groups as: gcp.project > gcp.region > gcp.vpc > gcp.subnet. Put Cloud SQL and Memorystore inside a VPC; put Cloud Run services that need private resources (Redis) inside a subnet; put other regional resources inside the region.
- Connections point from caller to callee (users → load balancer → service → database). A topic → Cloud Run connection is a push subscription.
- Public web apps: users → gcp.load_balancer → gcp.cloud_run. Do not set public=true when a load balancer fronts the service.
- Ids are short snake_case names (api, orders_db, uploads). Labels are short and human ("Orders DB").
- Do as much as possible in one edit_diagram call.
- After editing, call validate_diagram once and fix errors and warnings that are within the request. Mention remaining suggestions briefly.
- Edit the existing diagram for change requests: keep everything the user did not ask to change.
- For questions (explain, review, compare, cost), answer in text; use validate_diagram for reviews and get_workflows for how components interact; do not edit unless asked.
- If the user asks for Terraform/IaC, make sure the diagram is valid, then call generate_terraform.
- Finish with 1–4 sentences summarising what you did. No markdown headings.`;
}

export async function runAgent(
  initial: DiagramModel,
  message: string,
  history: LlmMessage[],
  emit: (e: AgentEvent) => void,
): Promise<void> {
  let model = initial;
  let changed = false;
  const user = `Current diagram (JSON):\n${JSON.stringify(compact(model))}\n\nRequest: ${message}`;
  const session = startToolSession(systemPrompt(), [...history.slice(-10), { role: "user", content: user }], TOOLS);

  let turn = await session.step();
  for (let step = 0; step < MAX_STEPS; step++) {
    if (turn.text.trim()) emit({ type: "text", text: turn.text });
    if (!turn.calls.length) break;
    const results = turn.calls.map((call) => {
      const r = execute(call, model);
      if (r.model) {
        model = r.model;
        changed = true;
        emit({ type: "model", model });
      }
      if (call.name === "generate_terraform") emit({ type: "terraform" });
      emit({ type: "tool", name: call.name, summary: r.summary, ok: r.ok, ...(r.ok ? {} : { error: r.summary }) });
      return { call, result: r.result };
    });
    turn = await session.step(results);
    if (step === MAX_STEPS - 1 && turn.calls.length)
      emit({ type: "text", text: "Stopped after the maximum number of steps; ask me to continue if something is missing." });
  }
  emit({ type: "done", model, changed });
}

interface ExecResult {
  ok: boolean;
  summary: string;
  result: unknown;
  model?: DiagramModel;
}

export function execute(call: ToolCall, model: DiagramModel): ExecResult {
  switch (call.name) {
    case "get_diagram":
      return { ok: true, summary: "Read the diagram", result: compact(model) };
    case "validate_diagram": {
      const issues = validateModel(model);
      return { ok: true, summary: `Reviewed: ${count(issues, "error")} errors, ${count(issues, "warning")} warnings`, result: { issues } };
    }
    case "get_workflows": {
      const workflows = generateWorkflows(model);
      return {
        ok: true,
        summary: `Read ${workflows.length} workflows`,
        result: {
          workflows: workflows.map((w) => ({ title: w.title, mode: w.mode, summary: w.summary, steps: w.steps.map((s) => s.text) })),
          integrations: describeIntegrations(model).map(({ terraform: _t, ...i }) => i),
        },
      };
    }
    case "generate_terraform": {
      const out = compileTerraform(model);
      return {
        ok: true,
        summary: `Generated Terraform: ${out.resources.length} resources`,
        result: { files: out.files.map((f) => f.path), resourceCount: out.resources.length, warnings: out.warnings },
      };
    }
    case "edit_diagram": {
      const raw = Array.isArray(call.args.operations) ? call.args.operations : [];
      let cur = model;
      const errors: string[] = [];
      let applied = 0;
      for (const [i, o] of raw.entries()) {
        const op = toOp(o as Record<string, unknown>);
        if (typeof op === "string") {
          errors.push(`#${i + 1}: ${op}`);
          continue;
        }
        const r = applyOp(cur, op);
        if (r.ok) {
          cur = r.model;
          applied++;
        } else errors.push(`#${i + 1} ${op.op}: ${r.error}`);
      }
      const summary = `Applied ${applied} of ${raw.length} changes${errors.length ? ` (${errors.length} failed)` : ""}`;
      return { ok: errors.length === 0, summary, result: { applied, errors }, ...(applied ? { model: cur } : {}) };
    }
    default:
      return { ok: false, summary: `Unknown tool ${call.name}`, result: { error: `unknown tool ${call.name}` } };
  }
}

/** Normalises a model-produced operation (loose JSON) into a typed Op, or an error message. */
function toOp(o: Record<string, unknown>): Op | string {
  const s = (k: string) => (typeof o[k] === "string" && o[k] !== "" ? (o[k] as string) : undefined);
  const props = o.props && typeof o.props === "object" ? (o.props as Record<string, unknown>) : undefined;
  switch (o.op) {
    case "add_node":
      if (!s("id") || !s("kind")) return "add_node needs id and kind";
      return { op: "add_node", id: s("id")!, kind: s("kind")!, label: s("label") ?? s("id")!, parentId: s("parentId"), props };
    case "update_node":
      if (!s("id")) return "update_node needs id";
      return {
        op: "update_node",
        id: s("id")!,
        label: s("label"),
        parentId: o.parentId === "" || o.parentId === null ? null : s("parentId"),
        props,
      };
    case "remove_node":
      return s("id") ? { op: "remove_node", id: s("id")! } : "remove_node needs id";
    case "connect":
      if (!s("from") || !s("to")) return "connect needs from and to";
      return {
        op: "connect",
        from: s("from")!,
        to: s("to")!,
        label: s("edgeLabel") ?? s("label"),
        protocol: PROTOCOLS.includes(o.protocol as Protocol) ? (o.protocol as Protocol) : undefined,
      };
    case "disconnect":
      return s("from") && s("to") ? { op: "disconnect", from: s("from")!, to: s("to")! } : "disconnect needs from and to";
    default:
      return `unknown op ${String(o.op)}`;
  }
}

/** The model without layout, which the agent doesn't need. */
function compact(m: DiagramModel) {
  return { nodes: m.nodes, edges: m.edges.map(({ id: _id, ...e }) => e) };
}

const count = (issues: { severity: string }[], s: string) => issues.filter((i) => i.severity === s).length;
