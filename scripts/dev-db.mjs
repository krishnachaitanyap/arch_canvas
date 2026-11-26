// Local dev Postgres without Docker: downloads nothing at runtime, binaries come from the
// embedded-postgres npm package. Data lives in .data/pg (gitignored). Ctrl+C stops it.
import EmbeddedPostgres from "embedded-postgres";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const databaseDir = path.join(root, ".data", "pg");
const port = Number(process.env.PGPORT ?? 5432);

const pg = new EmbeddedPostgres({
  databaseDir,
  user: "archcanvas",
  password: "archcanvas",
  port,
  persistent: true,
});

if (!existsSync(path.join(databaseDir, "PG_VERSION"))) {
  await pg.initialise();
}
await pg.start();
try {
  await pg.createDatabase("archcanvas");
} catch {
  // already exists
}
console.log(`Postgres ready: postgres://archcanvas:archcanvas@localhost:${port}/archcanvas`);

const stop = async () => {
  await pg.stop();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
