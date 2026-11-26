// Starts the API on SQLite (Node's built-in node:sqlite) instead of Postgres: the fallback
// when embedded Postgres can't be installed or started. Data lives in .data/archcanvas.sqlite
// (gitignored). Set SQLITE_FILE to use another file. Needs Node 22.13+.
//
//   npm run dev:api:sqlite
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(`SQLite mode needs Node 22.13 or newer (this is ${process.versions.node}).`);
  process.exit(1);
}

const env = { ...process.env, DATABASE_URL: `sqlite:${process.env.SQLITE_FILE ?? ".data/archcanvas.sqlite"}` };
// .env supplies the rest (API keys, PORT…); DATABASE_URL set here wins over the file.
const args = [...(existsSync(".env") ? ["--env-file=.env"] : []), "node_modules/tsx/dist/cli.mjs", "watch", "apps/api/src/index.ts"];
const child = spawn(process.execPath, args, { stdio: "inherit", env });
child.on("exit", (code) => process.exit(code ?? 0));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
