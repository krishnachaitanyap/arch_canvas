import pg from "pg";
import { config } from "./config.js";
import { openSqlite } from "./sqlite.js";

/** What routes need from a database connection (a pg client, or the SQLite adapter). */
export interface Db {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query<R = any>(text: string, params?: unknown[]): Promise<{ rows: R[]; rowCount: number | null }>;
}

interface Pool extends Db {
  connect(): Promise<Db & { release(): void }>;
  end(): Promise<void>;
}

/**
 * DATABASE_URL `postgres://…` (the default and the production setup), or `sqlite:<file>` for
 * a no-install local fallback on Node's built-in SQLite (see docs/enterprise-network.md).
 */
export const isSqlite = config.DATABASE_URL.startsWith("sqlite:");

const sqlite = isSqlite ? openSqlite(config.DATABASE_URL) : null;
export const sqliteFile = sqlite?.file;

export const pool: Pool = sqlite
  ? { query: sqlite.query, connect: sqlite.connect, end: sqlite.end }
  : (new pg.Pool({ connectionString: config.DATABASE_URL, max: 10 }) as unknown as Pool);

/** Runs SQLite schema statements (migrations); Postgres runs them through query(). */
export function execSqlite(sql: string): void {
  sqlite!.exec(sql);
}

/**
 * Runs a query inside a transaction with the tenant set for Postgres row-level security.
 * Every tenant-scoped table has an RLS policy on `app.tenant_id`, so a missing
 * WHERE clause can never leak another tenant's data. (SQLite has no RLS: the access checks
 * in access.ts still apply, but tenants aren't isolated, so it's for local use only.)
 */
export async function withTenant<T>(tenantId: string, fn: (c: Db) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
