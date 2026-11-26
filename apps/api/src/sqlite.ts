import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * SQLite fallback for local development, on Node's built-in `node:sqlite` (nothing to
 * download). Used when DATABASE_URL is `sqlite:<file>`. The API's SQL is written for
 * Postgres; `translate` rewrites the few Postgres-only bits it uses, so every route runs
 * unchanged. Not for production: there is no row-level security (tenant isolation), and
 * requests touching the database run one at a time.
 */

export interface QueryResult<R> {
  rows: R[];
  rowCount: number;
}

/** Columns stored as JSON text in SQLite (JSONB in Postgres): parsed back into objects. */
const JSON_COLUMNS = new Set(["scene", "model", "meta", "icons"]);

/** Rewrites the Postgres-only syntax the API uses into SQLite. */
export function translate(sql: string): string {
  return (
    sql
      // Row locks: SQLite locks the whole database for a write transaction anyway.
      .replace(/\s+FOR UPDATE(\s+OF\s+\w+)?/gi, "")
      // Array parameters (sent as JSON): x = ANY($1) → x IN (values of the JSON array)
      .replace(/=\s*ANY\(\s*\$(\d+)(?:::\w+\[\])?\s*\)/gi, "IN (SELECT value FROM json_each(?$1))")
      // Casts: ::jsonb, ::int, ::text, ::boolean, ::text[]
      .replace(/::\w+(\[\])?/g, "")
      .replace(/\bjsonb_array_length\(/gi, "json_array_length(")
      // $1 → ?1 (SQLite's numbered parameters)
      .replace(/\$(\d+)/g, "?$1")
  );
}

/** Values the way SQLite stores them: JSON for objects and arrays, 1/0 for booleans. */
function bindable(v: unknown): null | number | bigint | string | Uint8Array {
  if (v === undefined || v === null) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number" || typeof v === "bigint" || typeof v === "string") return v;
  if (v instanceof Uint8Array) return v;
  if (v instanceof Date) return v.toISOString();
  return JSON.stringify(v);
}

function readRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) out[k] = JSON_COLUMNS.has(k) && typeof v === "string" ? JSON.parse(v) : v;
  return out;
}

export function openSqlite(url: string) {
  const file = path.resolve(url.replace(/^sqlite:(\/\/)?/, "") || ".data/archcanvas.sqlite");
  mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  // Postgres functions the queries call.
  db.function("now", () => new Date().toISOString());
  db.function("gen_random_uuid", () => randomUUID());
  db.function("greatest", { varargs: true }, (...args: unknown[]) => {
    const vals = args.filter((a) => a !== null && a !== undefined) as (string | number)[];
    return vals.length ? vals.reduce((a, b) => (b > a ? b : a)) : null;
  });
  // Tenant context for row-level security: nothing to set in SQLite.
  db.function("set_config", { varargs: true }, () => null);
  db.function("current_setting", { varargs: true }, () => null);

  const statements = new Map<string, ReturnType<DatabaseSync["prepare"]>>();
  const prepare = (sql: string) => {
    let s = statements.get(sql);
    if (!s) {
      s = db.prepare(translate(sql));
      statements.set(sql, s);
    }
    return s;
  };

  function query<R = Record<string, unknown>>(sql: string, params: unknown[] = []): QueryResult<R> {
    const trimmed = sql.trim();
    if (/^(BEGIN|COMMIT|ROLLBACK)\b/i.test(trimmed)) {
      db.exec(trimmed);
      return { rows: [], rowCount: 0 };
    }
    const stmt = prepare(sql);
    const args = params.map(bindable);
    if (/^(SELECT|WITH)\b/i.test(trimmed) || /\bRETURNING\b/i.test(trimmed)) {
      const rows = (stmt.all(...args) as Record<string, unknown>[]).map(readRow) as R[];
      return { rows, rowCount: rows.length };
    }
    const r = stmt.run(...args);
    return { rows: [], rowCount: Number(r.changes) };
  }

  // One connection: transactions must not interleave, so clients take turns.
  let queue: Promise<void> = Promise.resolve();
  async function connect() {
    let release!: () => void;
    const turn = new Promise<void>((r) => (release = r));
    const before = queue;
    queue = queue.then(() => turn);
    await before;
    return {
      query: async <R = Record<string, unknown>>(sql: string, params?: unknown[]) => query<R>(sql, params),
      release: () => release(),
    };
  }

  return {
    file,
    /** A single statement, waiting for any open transaction to finish. */
    query: async <R = Record<string, unknown>>(sql: string, params?: unknown[]) => {
      const c = await connect();
      try {
        return query<R>(sql, params);
      } finally {
        c.release();
      }
    },
    connect,
    exec: (sql: string) => db.exec(sql),
    end: async () => db.close(),
  };
}
