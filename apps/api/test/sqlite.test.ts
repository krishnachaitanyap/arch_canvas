import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { openSqlite, translate } from "../src/sqlite.js";

describe("SQLite fallback", () => {
  it("translates the Postgres-only syntax the API uses", () => {
    expect(translate("SELECT role FROM m WHERE id = $1 AND user_id = ANY($2)")).toBe("SELECT role FROM m WHERE id = ?1 AND user_id IN (SELECT value FROM json_each(?2))");
    expect(translate("SELECT count(*)::int AS n, x::text FROM t WHERE tab = ANY($2::text[])")).toBe("SELECT count(*) AS n, x FROM t WHERE tab IN (SELECT value FROM json_each(?2))");
    expect(translate("SELECT d.* FROM d WHERE d.id = $1 FOR UPDATE OF d")).toBe("SELECT d.* FROM d WHERE d.id = ?1");
    expect(translate("COALESCE(jsonb_array_length(model->'nodes'), 0), COALESCE($6, '{}'::jsonb)")).toBe("COALESCE(json_array_length(model->'nodes'), 0), COALESCE(?6, '{}')");
  });

  it("runs queries with JSON columns, arrays, booleans and Postgres functions", async () => {
    const db = openSqlite(`sqlite:${path.join(mkdtempSync(path.join(tmpdir(), "ac-sqlite-")), "t.sqlite")}`);
    db.exec("CREATE TABLE d (id TEXT PRIMARY KEY, model TEXT, tag TEXT, flag INTEGER, updated_at TEXT)");
    await db.query("INSERT INTO d (id, model, tag, flag, updated_at) VALUES (gen_random_uuid(), $1, $2, $3, now())", [{ nodes: [1, 2] }, "a", true]);
    await db.query("INSERT INTO d (id, model, tag, flag, updated_at) VALUES (gen_random_uuid(), $1, $2, $3, now())", [{ nodes: [] }, "b", false]);
    const { rows } = await db.query<{ model: { nodes: number[] }; n: number; flag: number; later: string }>(
      "SELECT model, jsonb_array_length(model->'nodes')::int AS n, flag, GREATEST(updated_at, NULL) AS later FROM d WHERE tag = ANY($1) ORDER BY tag",
      [["a", "c"]],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].model).toEqual({ nodes: [1, 2] });
    expect(rows[0].n).toBe(2);
    expect(rows[0].flag).toBe(1);
    expect(rows[0].later).toMatch(/^\d{4}-\d\d-\d\dT/);
    const del = await db.query("DELETE FROM d WHERE tag = $1", ["b"]);
    expect(del.rowCount).toBe(1);
    await db.end();
  });

  it("keeps transactions from different requests apart", async () => {
    const db = openSqlite(`sqlite:${path.join(mkdtempSync(path.join(tmpdir(), "ac-sqlite-")), "t.sqlite")}`);
    db.exec("CREATE TABLE n (v INTEGER)");
    const tx = async (v: number) => {
      const c = await db.connect();
      try {
        await c.query("BEGIN");
        await c.query("INSERT INTO n (v) VALUES ($1)", [v]);
        await new Promise((r) => setTimeout(r, 5));
        await c.query("COMMIT");
      } finally {
        c.release();
      }
    };
    await Promise.all([tx(1), tx(2), tx(3)]);
    const { rows } = await db.query<{ c: number }>("SELECT count(*) AS c FROM n");
    expect(rows[0].c).toBe(3);
    await db.end();
  });
});
