// node:sqlite's SQLTagStore: a tagged literal's SQL becomes a cached prepared
// statement, run/get/all/iterate bind the placeholders, size/capacity/db
// report the cache, clear drops it, and the bounds and mismatch errors are
// Node's.
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync(":memory:");
db.exec("CREATE TABLE t (a, b)");
const store = db.createTagStore(4);
console.log(store.capacity, store.size, store.db === db, store.db.isOpen);
const id = 1;
console.log(store.run`INSERT INTO t VALUES (${id}, ${"x"})`);
console.log(store.get`SELECT a, b FROM t WHERE a = ${id}`);
console.log(store.all`SELECT a, b FROM t ORDER BY a`);
console.log(store.size);
store.run`INSERT INTO t VALUES (${2}, ${"y"})`;
console.log(store.size, store.all`SELECT a FROM t ORDER BY a`);
store.clear();
console.log(store.size);
console.log([...store.iterate`SELECT a FROM t ORDER BY a`]);

try {
  store.get`SELECT 1 WHERE 1 = ?`;
} catch (error) {
  const e = error as { message: string; code: string };
  console.log("mismatch:", e.message, e.code);
}
try {
  db.createTagStore(0);
} catch (error) {
  const e = error as { message: string; code: string };
  console.log("cap0:", e.message, e.code);
}
try {
  db.createTagStore(1.5);
} catch (error) {
  const e = error as { message: string; code: string };
  console.log("capf:", e.message, e.code);
}
try {
  db.createTagStore("x" as unknown as number);
} catch (error) {
  const e = error as { message: string; code: string };
  console.log("caps:", e.message, e.code);
}

const tiny = db.createTagStore(1);
tiny.all`SELECT 1 AS one`;
tiny.all`SELECT 2 AS two`;
console.log("tiny size:", tiny.size);
db.close();
try {
  store.all`SELECT 1 AS one`;
} catch (error) {
  const e = error as { message: string; code: string };
  console.log("closed:", e.message, e.code);
}
