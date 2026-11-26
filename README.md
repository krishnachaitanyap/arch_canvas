# ArchCanvas

AI-native architecture diagramming — one codebase that runs as **ArchCanvas Cloud on GCP** and as a **self-hosted install** in a customer's Kubernetes cluster (including air-gapped).

> Status: **phase 1 demo** — canvas, Mermaid diagram-as-code, AI "prompt → diagram" and "edit current diagram", save/load with version history, SVG/PNG export, multi-tenant Postgres with row-level security, audit log, collab server.

```
apps/
  web/      React + Vite + Excalidraw canvas, Mermaid → editable canvas
  api/      Fastify (TypeScript): diagrams, versions, AI, OIDC auth, tenant isolation (Postgres RLS)
  collab/   Hocuspocus (Yjs CRDT) real-time sync server, persisted to Postgres
deploy/
  docker/            Dockerfiles + nginx template
  helm/archcanvas/   One Helm chart for GKE and self-hosted
  helm/values-*.yaml GCP and self-hosted overlays
  terraform/gcp/     VPC, GKE Autopilot, Cloud SQL (private IP), GCS, Artifact Registry, Workload Identity
docker-compose.yml   Single-machine self-hosted / local stack
cloudbuild.yaml      Build + push images to Artifact Registry
```

## Run locally

Requirements: Node 20+. No Docker needed: `npm run dev:db` runs an embedded Postgres (data in `.data/pg`).

```bash
cp .env.example .env            # set GEMINI_API_KEY (or another LLM_PROVIDER), PORT, API_PROXY_TARGET
npm install
npm run dev:db                  # Postgres on :5432
node --env-file=.env node_modules/tsx/dist/cli.mjs watch apps/api/src/index.ts     # API (runs migrations)
node --env-file=.env node_modules/vite/bin/vite.js apps/web --port 5174            # web app
npm test                        # unit tests (shared model, Terraform compiler, agent tools)
```

The same three commands are in `.claude/launch.json`. Install Terraform on the API host to enable **Validate** in the Terraform tab.

Or the whole stack in containers: `docker compose up -d --build` → http://localhost:8000.
Add `--profile sso` for Keycloak, `--profile local-llm` for Ollama.

## GCP architecture diagrams (Milestone 1)

- **Typed model** (`packages/shared`): nodes, groups and connections checked against a GCP resource catalog.
- **Structured editor**: React Flow canvas with nested groups (project → region → VPC → subnet), ELK auto-layout, palette, properties, undo/redo.
- **Assistant** (Gemini by default): edits the diagram through validated tool calls and shows changes as a highlighted proposal to accept or reject. It also reviews designs and generates Terraform.
- **Terraform**: a deterministic compiler (`packages/shared/src/terraform.ts`) turns the diagram into `google` provider code. Connections become IAM, VPC access, Pub/Sub push subscriptions and load balancer backends. Download as a zip, or validate with `terraform validate`.
- **Export**: draw.io (`.drawio`), SVG, PNG, Mermaid, PlantUML and JSON.

## Workspaces, projects, versions and compare

- **Workspaces** hold **projects**, and projects hold diagrams. Each workspace has members with roles:
  - **owner**: also manages members and workspace settings
  - **editor**: creates and changes projects and diagrams
  - **viewer**: can only read
  Members are added by OIDC user id or email. Non-members can't see the workspace at all.
- **Versions:** every save that changes something creates a numbered version, and a save with no changes doesn't. You can name versions, restore an old one (it's saved as a new version, so history is never rewritten), or copy any version into a new diagram, in this project or another one.
- **Compare** any two versions, the editor's unsaved state, or another diagram's latest version:
  - a visual diff on the canvas (added, changed, removed)
  - a field-level change list
  - the Terraform diff, showing which resources would be created or destroyed
  - a Mermaid or text diff
- **Dev mode** (no `OIDC_ISSUER`): the "as" box in the top bar switches the acting user (sent as the `x-dev-user` header), so you can try the roles.

## Workflows, integrations and presentations

Workflows and integration explanations come from the diagram (`packages/shared/src/flows.ts`), using the same edge rules as the Terraform compiler, so they always describe what actually gets deployed.

- **Workflows:** request flows start at users (or at services nothing calls), and each Pub/Sub topic starts its own async workflow.
- **How each integration works:** for every connection, the mechanism, security (IAM), configuration (environment variables), what to watch out for, and the Terraform resources it creates.
- **Normal view:** the **Flows** tab in the editor. Clicking a step highlights it on the canvas. Selecting a connection shows its explanation in Properties. **Download doc** produces a Markdown architecture document with a Mermaid diagram, components, workflows, integrations, review and deployment.
- **Presentation:** **Present** opens a full-screen walkthrough (title, overview, each workflow step by step with the canvas zooming to the connection, wrap-up). Use ← and → to move, F for fullscreen, Esc to exit.
- **AI wording** (optional): Gemini rewrites titles and step text. It can't add, remove or reorder steps; anything that doesn't match the diagram is discarded.

See [docs/PLAN-cloud-agent-iac.md](docs/PLAN-cloud-agent-iac.md) for the roadmap.

## AI providers

Set `LLM_PROVIDER`:

| Value | Use for | Config |
|---|---|---|
| `gemini` | Default. Gemini API key, or Vertex AI when the key is empty | `GEMINI_API_KEY` or `VERTEX_PROJECT_ID`, `VERTEX_REGION`; `LLM_MODEL` |
| `anthropic` | Claude via the Anthropic API | `ANTHROPIC_API_KEY`, `LLM_MODEL` |
| `vertex` | Claude on Vertex AI (GCP, data stays in your project) | `VERTEX_PROJECT_ID`, `VERTEX_REGION`; auth via Workload Identity |
| `openai_compatible` | Self-hosted / air-gapped: vLLM, Ollama, LiteLLM, Azure OpenAI | `OPENAI_BASE_URL`, `OPENAI_API_KEY`, `LLM_MODEL` |
| `none` | AI disabled | — |

## Deploy to GCP

```bash
cd deploy/terraform/gcp
terraform init && terraform apply -var project_id=<project> -var region=asia-south1
$(terraform output -raw get_credentials)

# images
cd ../../.. && gcloud builds submit --config cloudbuild.yaml --substitutions=_REGION=asia-south1,_TAG=0.1.0

# database secret (value lives in Secret Manager: terraform output database_url_secret)
kubectl create namespace archcanvas
kubectl -n archcanvas create secret generic archcanvas-db \
  --from-literal=DATABASE_URL="$(gcloud secrets versions access latest --secret=archcanvas-database-url)"

# app — edit deploy/helm/values-gcp.yaml first (project, host, issuer)
helm upgrade --install archcanvas deploy/helm/archcanvas -n archcanvas -f deploy/helm/values-gcp.yaml
```

Point your DNS A record at `terraform output ingress_ip`; the Google-managed certificate provisions once DNS resolves.

## Self-hosted install

```bash
helm upgrade --install archcanvas deploy/helm/archcanvas -n archcanvas --create-namespace \
  -f deploy/helm/values-selfhosted.yaml
```

- **Database:** any Postgres 14+ (CloudNativePG recommended). `postgresql.enabled=true` gives an in-cluster DB for evaluation only.
- **SSO:** any OIDC issuer — Keycloak federated to Okta / Entra ID / LDAP. Tokens must carry a `tenant` claim (configurable via `auth.tenantClaim`).
- **Air-gapped:** mirror the three images into the customer registry, use `openai_compatible` with an in-cluster model server. The web app self-hosts its fonts — no CDN calls.

## Validation status

Verified in development: TypeScript builds for all apps, API end-to-end against Postgres 16 (CRUD, versions, audit log, AI route, RLS tenant isolation), web UI flow (AI prompt → Mermaid → canvas → save), collab server start-up.
**Not yet run:** `helm lint`/`helm template`, `terraform validate`, and Docker image builds — run these before the first deploy.

## Roadmap (next)

See [docs/ROADMAP.md](docs/ROADMAP.md).
