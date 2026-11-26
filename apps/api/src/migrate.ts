import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { execSqlite, isSqlite, pool } from "./db.js";

// SQLite (the local fallback) has its own schema files: it lacks RLS, JSONB and DO blocks.
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), isSqlite ? "migrations-sqlite" : "migrations");

export async function migrate(): Promise<void> {
  await pool.query(
    isSqlite
      ? "CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')))"
      : `CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  );
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) {
    const { rowCount } = await pool.query("SELECT 1 FROM schema_migrations WHERE name = $1", [file]);
    if (rowCount) continue;
    const sql = await readFile(path.join(dir, file), "utf8");
    if (isSqlite) {
      // A schema file is several statements; SQLite runs them with exec().
      execSqlite(`BEGIN; ${sql}\n; INSERT INTO schema_migrations (name) VALUES ('${file.replace(/'/g, "''")}'); COMMIT;`);
      console.log(`applied ${file}`);
      continue;
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
      await client.query("COMMIT");
      console.log(`applied ${file}`);
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  migrate()
    .then(() => pool.end())
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
