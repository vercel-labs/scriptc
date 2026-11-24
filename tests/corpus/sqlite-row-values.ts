// node:sqlite's row values as values: rows stored, printed, indexed and
// iterated with the shape the statement's options select — records by
// default, arrays under returnArrays, BigInts under readBigInts, blobs as
// Uint8Array, and a missing row as undefined.
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync(":memory:");
db.exec("CREATE TABLE t(id INTEGER, name TEXT, data BLOB)");
db.prepare("INSERT INTO t VALUES (?, ?, ?)").run(1, "a", new Uint8Array([1, 2, 3]));

const select = db.prepare("SELECT id, name, data FROM t");
const row = select.get() as { id: number; name: string; data: Uint8Array };
console.log("record:", row.id, row.name, Array.from(row.data));
const rows = select.all();
console.log("records:", rows.length, JSON.stringify(rows[0]));

const arrays = db.prepare("SELECT id, name FROM t");
arrays.setReturnArrays(true);
const arrayRow = arrays.get() as unknown as [number, string];
console.log("array-row:", Array.isArray(arrayRow), arrayRow[0], arrayRow[1]);
console.log("array-json:", JSON.stringify(arrayRow));
const arrayRows = arrays.all() as unknown as [number, string][];
console.log("array-rows:", arrayRows.length, arrayRows[0][0], arrayRows[0][1]);

const iterated: string[] = [];
for (const entry of arrays.iterate()) iterated.push(JSON.stringify(entry));
console.log("array-iterate:", iterated.join(","));

const store = db.createTagStore(4);
const stored = store.run`SELECT ${1} AS v`;
console.log("store-run:", stored.changes, String(stored.lastInsertRowid));
const storedRow = store.all`SELECT id FROM t` as { id: number }[];
console.log("store-rows:", storedRow.length, storedRow[0].id);
store.clear();
console.log("store-cleared:", store.size);

const empty = db.prepare("SELECT id FROM t WHERE id = ?");
console.log("absent:", empty.get(99));
console.log("absent-all:", empty.all(99).length);
