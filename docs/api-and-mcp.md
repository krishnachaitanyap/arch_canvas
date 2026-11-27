# API, AI agents (MCP) and pull-request reviews

ArchCanvas diagrams can be read and changed from outside the app: by scripts and CI through the
REST API, by AI agents through the MCP server, and in pull requests through the diagram-code CLI.
All three use diagram code (`.arch`, see [Diagram as code](../README.md#diagram-as-code)).

## API tokens

Create a token on the home page: **API tokens** (next to Members and Icon packs). A token acts as
you, with your workspace roles. It is shown once; ArchCanvas stores only its hash. Tokens can
expire (30 days, 90 days, a year) and can be revoked at any time.

Send it as a bearer token:

```bash
curl -H "Authorization: Bearer $ARCHCANVAS_TOKEN" https://archcanvas.example.com/api/diagrams
```

Tokens work whether or not the server uses single sign-on (OIDC).

### Main endpoints

| Method and path | What it does |
|---|---|
| `GET /api/workspaces` | Your workspaces and your role in each |
| `GET /api/workspaces/:id/projects` | Projects in a workspace |
| `GET /api/diagrams?projectId=` | Diagrams (all you can see, or one project's) |
| `GET /api/diagrams/lookup/:shortId` | Full id from the short id at the end of a diagram's URL |
| `GET /api/diagrams/:id` | A diagram, with its model |
| `POST /api/diagrams` | Create: `{ projectId, title, kind: "cloud", model }` |
| `PUT /api/diagrams/:id` | Save a new version: `{ model, message? }` (`autosave: true` stores without a version) |
| `GET /api/diagrams/:id/versions` | Version history |
| `GET /api/diagrams/:id/versions/:n` | One version |
| `POST /api/terraform/validate` | Run `terraform validate` on generated files (when Terraform is installed on the server) |
| `GET /api/tokens`, `POST /api/tokens`, `DELETE /api/tokens/:id` | Manage your tokens |

Models are JSON; to work with code instead, convert with the shared package (`toCode`,
`parseCode`) or let the MCP server and CLI do it.

## MCP server (Claude, Cursor, VS Code and other AI agents)

`scripts/mcp-server.mts` is a Model Context Protocol server over stdio. It has no dependencies
beyond the repository itself.

| Tool | What it does |
|---|---|
| `list_diagrams`, `list_projects` | Find diagrams and where to create them |
| `diagram_code_reference` | The diagram code syntax, types, protocols and AWS icons |
| `get_diagram_code` | A diagram as code (by id, short id, URL or title) |
| `update_diagram_code` | Save new code as a version; positions on the canvas are kept. Returns what changed |
| `create_diagram` | A new diagram from code |
| `check_diagram_code` | Syntax errors with line numbers, then the architecture review |
| `review_diagram` | Security and reliability review |
| `get_terraform` | Terraform for Google Cloud and AWS items |
| `diff_diagram` | Changes between versions: change list, code diff, Terraform created/destroyed |
| `code_from_source` | Terraform, Kubernetes, docker-compose or SQL → diagram code |

Settings (environment variables):

- `ARCHCANVAS_URL`: the API, default `http://localhost:8082`
- `ARCHCANVAS_TOKEN`: an API token (optional when the server runs without sign-in)

**Claude Code:**

```bash
claude mcp add archcanvas --env ARCHCANVAS_URL=http://localhost:8082 --env ARCHCANVAS_TOKEN=ac_... -- node /path/to/archcanvas/node_modules/tsx/dist/cli.mjs /path/to/archcanvas/scripts/mcp-server.mts
```

**Claude Desktop, Cursor, VS Code** (an `mcpServers` entry in the client's MCP settings):

```json
{
  "mcpServers": {
    "archcanvas": {
      "command": "node",
      "args": ["/path/to/archcanvas/dist/archcanvas-mcp.mjs"],
      "env": { "ARCHCANVAS_URL": "http://localhost:8082", "ARCHCANVAS_TOKEN": "ac_..." }
    }
  }
}
```

`dist/archcanvas-mcp.mjs` is a single-file build (`npm run build:cli`) that runs with plain
Node 20+, so the agent's machine doesn't need the repository's dependencies. Don't start the
server through `npm run mcp` in a client config: npm prints a banner on stdout, which breaks
the protocol (use `npm run --silent mcp`, or `node` directly as above).

Example requests to an agent:

- "Add a Redis cache in front of the orders database in the *Orders API* diagram."
- "Draw our docker-compose.yml as a new diagram in the Payments project."
- "What changed in the *HR / DR* diagram since last week, and what would Terraform destroy?"

## Pull-request reviews (GitHub)

Keep diagrams as `.arch` files next to the code. On every pull request that changes one, the
workflow checks the code and comments with what changed: items and lines added, changed and
removed, the Terraform resources that would be created or destroyed, and the code diff.

- In this repository: `.github/workflows/diagrams.yml`.
- In another repository: run `npm run build:cli` here, commit `dist/arch.mjs` there as
  `tools/arch.mjs`, and copy [`docs/github/archcanvas-diagrams.yml`](github/archcanvas-diagrams.yml)
  to its `.github/workflows/`. The CLI is one file, so CI needs no `npm install`.

The same checks run locally:

```bash
npm run arch -- check infra/app.arch
npm run arch -- diff HEAD~1:infra/app.arch infra/app.arch
npm run arch -- diff --markdown main:infra/app.arch infra/app.arch > review.md
```

From the canvas, **Code → Download** saves a diagram as an `.arch` file, and **Import** reads
one back (or Terraform, Kubernetes, docker-compose and SQL).
