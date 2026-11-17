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

Requirements: Node 20+, Docker (for Postgres).

```bash
cp .env.example .env            # add ANTHROPIC_API_KEY, or set LLM_PROVIDER=openai_compatible for Ollama
docker run -d --name archcanvas-pg -p 5432:5432 \
  -e POSTGRES_USER=archcanvas -e POSTGRES_PASSWORD=archcanvas -e POSTGRES_DB=archcanvas postgres:16-alpine
npm install
set -a; source .env; set +a
npm run dev:api                 # http://localhost:8080 (runs DB migrations on start)
npm run dev:web                 # http://localhost:5173
npm run dev:collab              # ws://localhost:1234 (optional for now)
```

Or the whole stack in containers: `docker compose up -d --build` → http://localhost:8000.
Add `--profile sso` for Keycloak, `--profile local-llm` for Ollama.

## AI providers

Set `LLM_PROVIDER`:

| Value | Use for | Config |
|---|---|---|
| `anthropic` | Cloud default | `ANTHROPIC_API_KEY`, `LLM_MODEL` |
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
