// node:sqlite's statement results as values: a run() result stored, destructured,
// returned from typed and inferred functions, read through the database, and the
// column metadata a prepared statement answers. Errors carry Node's code,
// errcode and errstr fields.
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync(":memory:");
db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)");
const insert = db.prepare("INSERT INTO t VALUES (?, ?)");

const first = insert.run(1, "a");
console.log("stored:", first.changes, first.lastInsertRowid);
const { changes, lastInsertRowid } = insert.run(2, "b");
console.log("destructured:", changes, lastInsertRowid);

function insertOne(id: number, value: string): { changes: number | bigint; lastInsertRowid: number | bigint } {
  return insert.run(id, value);
}
console.log("typed-return:", insertOne(3, "c").changes, insertOne(4, "d").lastInsertRowid);

const inferred = () => insert.run(5, "e");
console.log("inferred:", inferred().changes);

const named = db.prepare("UPDATE t SET v = $v WHERE id = $id");
const updated = named.run({ id: 1, v: "A" });
console.log("named:", updated.changes, String(updated.lastInsertRowid));

const select = db.prepare("SELECT id, v FROM t ORDER BY id");
const metadata = select.columns();
console.log("columns:", metadata.length, JSON.stringify(metadata[0]), JSON.stringify(metadata[1]));
const names: string[] = [];
for (const column of metadata) names.push(`${column.name}:${column.type}`);
console.log("column-names:", names.join(","));

const row = select.get();
console.log("row:", JSON.stringify(row));
const all = select.all();
console.log("all:", all.length, JSON.stringify(all[0]));
const iterator = select.iterate();
const iterated: string[] = [];
for (const entry of iterator) iterated.push(JSON.stringify(entry));
console.log("iterated:", iterated.join(","));

const missing = db.prepare("SELECT id FROM t WHERE id = 99").get();
console.log("missing:", missing);
console.log("empty-all:", db.prepare("SELECT id FROM t WHERE id = 99").all().length);

const counter = new DatabaseSync(":memory:", { readBigInts: true });
counter.exec("CREATE TABLE b(n INTEGER)");
const bigInsert = counter.prepare("INSERT INTO b VALUES (?)");
const bigResult = bigInsert.run(9007199254740993n);
console.log("big-result:", typeof bigResult.changes, String(bigResult.changes), String(bigResult.lastInsertRowid));
const bigRow = counter.prepare("SELECT n FROM b").get() as { n: bigint };
console.log("big-row:", typeof bigRow.n, String(bigRow.n));

function failure(run: () => unknown): void {
  try {
    run();
    console.log("failed: none");
  } catch (error) {
    const e = error as { code?: string; errcode?: number; errstr?: string; message: string };
    console.log("failed:", e.code, e.errcode, e.errstr, e.message);
  }
}
failure(() => db.exec("SELEC 1"));
failure(() => db.prepare("SELECT * FROM nope"));
failure(() => insert.run(1, "duplicate"));
failure(() => db.exec("CREATE TABLE t(x)"));

db.close();
failure(() => db.prepare("SELECT 1"));
