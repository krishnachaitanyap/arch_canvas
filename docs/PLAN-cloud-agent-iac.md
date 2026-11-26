# Plan: eraser.io-level cloud diagrams, agentic AI, and Terraform generation

Status: Milestone 1 built · 2026-11-26

## Decisions

| Area | Choice | Later |
|---|---|---|
| Clouds | **GCP** first | AWS and Azure use the same resource catalog format |
| IaC output | **Terraform** (google provider) | Pulumi, Helm/K8s |
| Editor | **Structured editor** for cloud diagrams (React Flow + ELK auto-layout) | Excalidraw stays for freeform whiteboards |
| LLM | **Google Gemini** (`@google/genai`, API key or Vertex AI mode) | Anthropic and OpenAI-compatible stay as gateway adapters |

## Where the code is today

- A diagram is stored as Mermaid text (`source`) plus raw Excalidraw JSON (`scene`). Nothing stores typed resources, groups or connections, so there is nothing for an agent or a Terraform generator to read.
- `apps/api/src/llm.ts` is text-in, text-out. It has no tool calling and no streaming, and the AI edits a diagram by regenerating the whole Mermaid file.
- Canvas edits never write back to `source`, so the two drift apart.
- The collab server exists, but the web app doesn't connect to it.
- No tests, no shared types between web and API, and no Gemini provider.

## Core idea: one typed diagram model is the source of truth

Everything reads and writes a single typed JSON model, defined once with Zod in a new `packages/shared` workspace:

```ts
Diagram  { schemaVersion, kind: "cloud" | "whiteboard", nodes, edges, layout }
Node     { id, kind: "gcp.cloud_run.service", label, parentId?, props: {...} }   // groups are nodes too
Edge     { id, from, to, label?, protocol?: "https" | "grpc" | "tcp" | "pubsub" | ... }
```

These all work from that model:
- the editor, which renders it
- the DSL text view, which converts to and from it
- the agent, which edits it through tools
- the Terraform generator, which compiles it to `.tf` files

The **resource catalog** (`packages/shared/catalog/gcp/*.ts`) defines each GCP resource once. That definition covers:
- its icon and display name
- the groups it can sit inside (for example: project → region → VPC → subnet → resource)
- its props schema
- how it maps to Terraform resources
- what an edge to or from it means (for example, a Cloud Run → Cloud SQL edge means a VPC connector or Cloud SQL connector plus an IAM binding)

**First catalog, about 25 resources:**

| Category | Resources |
|---|---|
| Containers | project, region, VPC, subnet, GKE cluster and node pool |
| Compute | Cloud Run, Cloud Functions, Compute Engine and MIG |
| Data | Cloud SQL, Memorystore, Firestore, Spanner, BigQuery, GCS bucket |
| Messaging and scheduling | Pub/Sub topic and subscription, Cloud Tasks, Scheduler |
| Networking | Load balancer, Cloud Armor, Cloud CDN, Cloud NAT, Serverless VPC connector |
| Security and other | Secret Manager, Artifact Registry, service account, API Gateway |

## Phases

### A. Foundation (about 1 week)
- Add `packages/shared` with the Zod diagram model, model operations (add, update, remove, connect, reparent; each one is pure and validated) and the first GCP catalog.
- Add migration `002_diagram_model.sql`:
  - new columns `kind`, `model JSONB` and `schema_version` on `diagrams` and `diagram_versions`
  - existing rows become `kind = 'whiteboard'`
- Update the API: create and update accept `model` and validate it with the shared schema. Add `POST /api/diagrams/:id/versions/:vid/restore`.
- Add Vitest to both apps and a CI test step. Tests for model operations and catalog rules come first.

### B. Structured cloud editor (2–3 weeks)
- React Flow canvas:
  - GCP icons on nodes and nested group containers
  - drag a resource into a group to reparent it, with catalog rules blocking invalid nesting
  - typed edges with labels
- ELK auto-layout (layered, left to right) on demand and after AI edits; manual positions are kept in `layout`.
- Left panel: resource palette with search. Right panel: properties form generated from each resource's props schema.
- **DSL editor**, a readable text syntax similar to eraser.io's (`api [icon: cloud-run] > db [icon: cloud-sql]`, `vpc { subnet-a { ... } }`). It converts both ways: editing the text updates the canvas and editing the canvas updates the text, which fixes the drift problem.
- Undo/redo (an operation log on the model), SVG/PNG export, copy and paste.
- Icons: use Google Cloud's official architecture icon set after **checking its licence terms**. If it can't be bundled, use our own simple icons.

### C. Gemini gateway and the diagram agent (2–3 weeks)
- **Gateway rework:** `llm.ts` becomes provider adapters behind one interface: `chat({system, messages, tools}) → stream of text and tool calls`.
  - `gemini` adapter on `@google/genai` (`GEMINI_API_KEY`, or `GOOGLE_GENAI_USE_VERTEXAI` with Workload Identity on GKE), using function calling.
  - Anthropic and OpenAI-compatible adapters move behind the same interface.
  - Model name stays configurable through `LLM_MODEL`.
- **Agent loop** runs on the API server (`POST /api/diagrams/:id/agent`, streamed back with SSE):
  - Tools: `get_diagram`, `list_catalog`, `add_node`, `update_node`, `remove_node`, `connect`, `reparent`, `auto_layout`, `validate`, `review`, `generate_terraform`, `import_terraform`.
  - Every tool input is checked against the Zod schemas, and catalog rules are enforced by the tools, not by the prompt.
  - Limits on steps and tokens; each run is recorded in the audit log.
- **Edits are proposals.** The agent's operations stream to the canvas as a highlighted diff (green for added, amber for changed, red for removed). The user accepts or rejects; accepting saves a version.
- **What the agent can do:**
  - prompt → new diagram
  - "add a cache in front of the DB" → targeted edits instead of a full regeneration
  - explain a diagram
  - review it for security, reliability and cost: deterministic rules first (public SQL, missing Cloud Armor, single-zone, no NAT for private GKE), then Gemini's own reasoning
  - Terraform or a design doc → diagram
  - diagram → Terraform
- Chat panel beside the canvas with a per-diagram history (new `agent_runs` and `agent_messages` tables).

### D. Terraform generation (2 weeks, can run alongside C)
- **Deterministic compiler** (`packages/iac-terraform`): the model plus catalog mappings produce `versions.tf`, `providers.tf`, `variables.tf`, `main.tf` (or one file per group) and `outputs.tf`. Gemini is **not** the source of the Terraform; it only explains the output and suggests values for props left empty.
- Edges become real infrastructure: IAM bindings, VPC connectors, private service access, Pub/Sub subscriptions, firewall rules.
- Sensible secure defaults: private IP for SQL, uniform bucket access, least-privilege service accounts, deletion protection on data stores.
- **Validation:** a worker runs `terraform fmt` and `terraform validate` (with `init -backend=false`) in a sandboxed container and shows errors on the matching nodes. CI runs golden-file tests plus `validate` on the sample architectures.
- **UI:** an IaC tab with a file tree, a code viewer and a diff against the last generation, plus a .zip download. Later: open a PR to a GitHub repo.
- **Import:** `.tf` files (parsed with `hcl2json`) and later `terraform.tfstate` → model, using the catalog mappings in reverse.

### E. eraser.io parity polish (ongoing, mostly already in `ROADMAP.md`)
- Docs editor beside the canvas with embedded diagrams.
- Sequence, ERD and flowchart diagram types, each with its own DSL.
- A template gallery, share links, comments, version history with a visual diff, and a presentation mode.
- Real-time collab: Yjs on the JSON model, which is much simpler than syncing Excalidraw. Requires fixing collab auth and tenant scoping first.

## Recommended order: one thin slice end to end first

**Milestone 1 (about 3 weeks):** type "Cloud Run API with Cloud SQL Postgres, a GCS bucket and Pub/Sub for async jobs". Gemini builds the diagram through tool calls, the structured canvas shows it auto-laid-out with GCP icons, and **Download Terraform** produces a zip that passes `terraform validate`.

That slice touches every layer with about 8 resources. After that, widening the catalog, the agent's skills and the editor polish happen in parallel.

## Risks

- **Gemini tool-calling reliability** over long multi-step runs. Mitigations: small tool set, strict schemas, one retry with the validation error fed back, and an eval set of about 30 prompts run in CI against the real model.
- **Terraform correctness.** Golden files plus `validate` in CI. Pin the google provider version; `plan` against a sandbox project is a later step.
- **Icon licensing.** Must be checked before bundling the official set.
- **Tenant isolation.** Local dev and docker-compose connect as a Postgres superuser, which bypasses RLS. Add a non-superuser app role before beta.
- **Scope.** Matching eraser.io across all diagram types is multi-month work. Doing GCP cloud diagrams with the agent and Terraform first gives the product a clear advantage early.

## Milestone 1 status (2026-11-26)

**Done**
- Shared model, ops, GCP catalog (13 kinds), validation and review rules, Terraform compiler, and draw.io, Mermaid and PlantUML exporters, with unit tests.
- Migration `002_diagram_model.sql`; the API accepts and validates `kind` and `model`.
- LLM gateway with tool calling for Gemini (API key or Vertex AI), Anthropic and Vertex Claude; `POST /api/agent` streams over SSE.
- `POST /api/terraform/validate` runs `fmt -check`, `init` and `validate` when Terraform is installed.
- Structured editor: ELK layout, palette, properties, review, Terraform tab, agent proposals with accept/reject, undo/redo, save, and exports (draw.io, SVG, PNG, Mermaid, PlantUML, JSON).

**Not yet verified**
- The agent against a live Gemini model (needs `GEMINI_API_KEY`).
- `terraform validate` on generated code (Terraform isn't installed on the dev machine).

**Next**
- Route connections along ELK's computed paths so lines don't cross nodes.
- Drag a resource into a group to reparent it.
- An eval set of about 30 prompts for the agent.
- Run `terraform validate` in CI.
- Production build of the API with the shared package (it currently runs TypeScript source through tsx).

## Workspaces, projects, versions and compare (2026-11-26)

**Done**
- Migration `003`: workspaces, members with owner/editor/viewer roles, projects, and numbered or named versions. Existing diagrams move into "Default workspace / General", and their creators become owners.
- Access checks for every route (`apps/api/src/access.ts`). New users get a personal workspace on first visit.
- Version history: saves with no changes don't create versions; versions can be named, restored (as a new version) or duplicated into any project.
- Compare (`packages/shared/src/compare.ts`): visual diff, field-level change list, Terraform diff with create/destroy, and line diff. Works across diagrams.
- Web: home screen (workspace switcher, projects, diagram cards, members, move, duplicate, delete), breadcrumbs, version badge, and the History overlay.

**Next**
- Real-time presence and comments on versions.
- Invite emails, and SCIM/IdP group mapping to roles.
- API integration tests against a real Postgres (role checks are only smoke-tested with curl so far).

## Workflows, integrations and presentation mode (2026-11-26)

**Done**
- `flows.ts`: workflows split at Pub/Sub boundaries, and an explanation for each integration that matches the Terraform mappings. `doc.ts` generates the Markdown architecture document.
- Flows tab with canvas highlighting, integration cards in Properties, the "Architecture doc (.md)" export, and full-screen presentation mode.
- `POST /api/ai/workflows` for AI wording, validated against the generated structure; the agent's `get_workflows` tool.

**Not yet verified:** AI wording against a live Gemini model (no key yet).

**Next**
- Let users define, name and save their own workflows (for example "Checkout"), including steps that repeat a connection.
- Sequence-diagram view of a workflow.
- Speaker notes, and exporting the presentation to PDF or slides.
