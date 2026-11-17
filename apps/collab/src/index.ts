import { Server } from "@hocuspocus/server";
import { Database } from "@hocuspocus/extension-database";
import pg from "pg";

/**
 * Real-time collaboration server (Yjs CRDT over WebSocket).
 * Documents are persisted to Postgres (collab_documents table, created by the API migrations).
 * Scale-out: add @hocuspocus/extension-redis so multiple replicas share updates.
 */
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL ?? "postgres://archcanvas:archcanvas@localhost:5432/archcanvas",
});

const server = new Server({
  port: Number(process.env.COLLAB_PORT ?? 1234),
  address: "0.0.0.0",
  debounce: 2000,
  extensions: [
    new Database({
      fetch: async ({ documentName }) => {
        const { rows } = await pool.query("SELECT data FROM collab_documents WHERE name = $1", [documentName]);
        return rows[0]?.data ?? null;
      },
      store: async ({ documentName, state }) => {
        await pool.query(
          `INSERT INTO collab_documents (name, data, updated_at) VALUES ($1, $2, now())
           ON CONFLICT (name) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
          [documentName, state],
        );
      },
    }),
  ],
  // TODO(phase 2): verify the same OIDC token as the API in onAuthenticate and
  // check the user can access the diagram's tenant.
});

await server.listen();
