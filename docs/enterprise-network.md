# Installing behind a corporate network

On a company network, `npm install` / `npm ci` can fail even though nothing is wrong with
the packages. The usual symptoms:

| Error | What's happening |
|---|---|
| `SELF_SIGNED_CERT_IN_CHAIN` (for any package, e.g. `@excalidraw/excalidraw`, `mermaid`, `@embedded-postgres/windows-x64`) | The network inspects HTTPS and re-signs it with the company's own root certificate. Windows trusts it; npm and Node don't. |
| `SELF_SIGNED_CERT_IN_CHAIN` during `npm audit` | Same, for npm's security-advisory service. |
| `ECONNRESET` partway through an install | A slow or busy proxy / package mirror (e.g. Nexus, Artifactory) dropped the connection. |
| `EPERM ... rmdir` warnings on Windows | Files locked by a sync tool, antivirus or an editor. Not a network problem. |
| `npm run dev:db` fails, or `@embedded-postgres/...` won't install | The embedded Postgres build is blocked. Use SQLite instead (see the end of this page). |

Work through the steps in order, then run a clean install (step 6).

## 1. Trust the company's root certificate

Get the root certificate as a `.pem` file. Your IT team may publish a "CA bundle"; otherwise
export it on Windows:

1. Run `certmgr.msc` → **Trusted Root Certification Authorities → Certificates**.
2. Find your company's root certificate → **All Tasks → Export** → **Base-64 encoded X.509**.
3. Save it, for example as `C:\certs\corp-ca.pem`. (Several roots can be pasted into one file.)

On macOS, export it from **Keychain Access → System Roots / System** as a `.pem`.

Point npm and Node at it:

```bash
npm config set cafile "C:\certs\corp-ca.pem"
```

```bash
setx NODE_EXTRA_CA_CERTS "C:\certs\corp-ca.pem"
```

`NODE_EXTRA_CA_CERTS` covers anything that downloads with Node itself rather than npm.
Open a new terminal afterwards. (macOS/Linux: `export NODE_EXTRA_CA_CERTS=~/certs/corp-ca.pem`
in your shell profile.)

**Alternative (Node 22.15+ / 23.8+, including Node 24):** use the operating system's certificate
store directly, with no export:

```bash
setx NODE_USE_SYSTEM_CA 1
```

Don't use `npm config set strict-ssl false` or `NODE_TLS_REJECT_UNAUTHORIZED=0`: they turn off
certificate checks entirely, and security teams flag them.

## 2. Install through the company's package mirror

`package-lock.json` records `registry.npmjs.org` addresses. If installs must go through a mirror
(Nexus, Artifactory…), set it as npm's registry; npm swaps the public address for the mirror
when it installs from the lockfile:

```bash
npm config set registry https://<your-mirror-host>/repository/<npm-group>/
```

If the mirror needs a login, your IT team will give you the `_auth` / token line for `~/.npmrc`.
Keep credentials in your user `~/.npmrc`, never in the project.

## 3. Turn off `npm audit` during installs

`npm audit` calls npmjs.org's advisory service, which many mirrors don't pass through:

```bash
npm config set audit false
```

Run `npm audit` separately when the mirror supports it, or rely on the mirror's own scanning.

## 4. Make a slow connection tolerable (`ECONNRESET`)

```bash
npm config set fetch-retries 5
```

```bash
npm config set fetch-retry-maxtimeout 120000
```

```bash
npm config set fetch-timeout 600000
```

```bash
npm config set maxsockets 4
```

If a run still drops, just run the install again: npm resumes from its download cache.

## 5. Windows file locks (`EPERM ... rmdir`)

- Keep the project outside OneDrive or other synced folders, e.g. `C:\dev\archcanvas`.
- Close editors and terminals running inside the project before reinstalling.
- If it keeps happening, ask IT to exclude the project folder from real-time antivirus scanning.

## 6. Clean install

```bash
npm cache verify
```

Delete `node_modules`, then:

```bash
npm ci
```

## If embedded Postgres won't install or start

`@embedded-postgres/<platform>` contains a full Postgres build and is only used by
`npm run dev:db`. Proxies and antivirus tools sometimes block it. You have two ways around it.

### Option A: SQLite (nothing extra to install)

The API can run on SQLite through Node's built-in `node:sqlite` module, so there is no
database package to download and no database server to run. It needs **Node 22.13 or newer**.

Skip `npm run dev:db` and start the API with:

```bash
npm run dev:api:sqlite
```

Start the web app as usual. Data is kept in `.data/archcanvas.sqlite` (set `SQLITE_FILE` to use
another file). To use SQLite with the commands in the README instead, set this in `.env`:

```bash
DATABASE_URL=sqlite:.data/archcanvas.sqlite
```

Everything in the app works the same: workspaces, projects, diagrams, autosave, versions and
compare, members and roles, and icon packs. The API translates its Postgres SQL for SQLite and
creates the tables when it starts. Limits, which is why it's for local use only:

- **No tenant isolation.** Postgres row-level security keeps each tenant's data apart; SQLite has
  no equivalent. Workspace roles (owner, editor, viewer) are still enforced by the API.
- **One request at a time** touches the database. Fine for one person, not for a team server.
- **Real-time whiteboard collaboration** (`npm run dev:collab`) still needs Postgres.
- Data doesn't move between SQLite and Postgres automatically. Export diagrams (draw.io or
  Keelrail JSON) and import them if you switch.

### Option B: an existing Postgres

Use any Postgres you already have (a local install, a container, or a shared development
database):

1. Create a database and user.
2. Set `DATABASE_URL` in `.env` (default: `postgres://archcanvas:archcanvas@localhost:5432/archcanvas`).
3. Start the API and the web app as in the README, without `npm run dev:db`. The API creates its
   tables (migrations) when it starts.

## Checking your settings

```bash
npm config list
```

The output should show your `cafile`, `registry`, `audit = false` and the fetch settings. To see
which step is failing, run an install with `--loglevel verbose` and look at the first error.
