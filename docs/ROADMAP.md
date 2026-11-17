# Roadmap

## Phase 1 — demo (weeks 1–3) ✅ scaffolded
- [x] Canvas (Excalidraw) with Mermaid diagram-as-code → editable canvas
- [x] AI: generate diagram from prompt; edit current diagram by instruction
- [x] Diagrams CRUD, version snapshots on every save, SVG/PNG export
- [x] Multi-tenant Postgres with row-level security; audit log
- [x] Pluggable LLM gateway (Anthropic, Vertex AI, OpenAI-compatible)
- [x] Docker, docker-compose, Helm chart, GKE Terraform, Cloud Build
- [ ] Run `helm lint`, `terraform validate`, image builds; first GKE deploy

## Phase 2 — cloud beta (weeks 4–10)
- [ ] Wire the web canvas to the collab server (Yjs binding for Excalidraw, presence/cursors)
- [ ] OIDC login in the web app (oidc-client-ts), collab `onAuthenticate`
- [ ] Workspaces, teams, roles (owner / editor / viewer), sharing links, guests
- [ ] Version history UI with restore and visual diff
- [ ] More diagram-as-code: D2, PlantUML, Structurizr (C4); ELK auto-layout
- [ ] Cloud icon packs (AWS, Azure, GCP, Kubernetes) and custom icon upload
- [ ] Docs editor (TipTap) with embedded diagrams; Markdown / PDF export
- [ ] GitHub import: generate diagrams from a repo, Terraform or OpenAPI spec
- [ ] Redis extension for collab scale-out; GCS for attachments

## Phase 3 — self-hosted v1 (weeks 11–16)
- [ ] Offline signed licence keys and feature flags per plan
- [ ] Air-gapped bundle (images + chart + checksums), upgrade-safe migrations
- [ ] Install docs, sizing guide, backup/restore runbook

## Phase 4 — enterprise (months 5–7)
- [ ] SCIM provisioning, SAML via Keycloak, fine-grained (per-diagram) permissions
- [ ] Audit log export to SIEM, data retention, legal hold, BYOK encryption
- [ ] High availability, multi-region; SOC 2 readiness, pen test

## Phase 5 — differentiators (months 7–12)
- [ ] Living architecture: sync from cloud accounts, Kubernetes, code; drift alerts
- [ ] PR bot: diagram diffs on pull requests, architecture-rule checks in CI
- [ ] AI design review and STRIDE threat modelling on the canvas
- [ ] Cost (FinOps) and live health overlays
- [ ] MCP server and public API; Confluence, Jira, Backstage, Slack/Teams integrations
