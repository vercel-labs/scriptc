// node:sqlite's SQLTagStore: clear() called from a user SQL function while a
// tagged query runs drops the cache but never the running statement, so the
// query finishes and the store reports an empty cache afterwards.
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync(":memory:");
db.exec("CREATE TABLE t (a)");
db.exec("INSERT INTO t VALUES (1), (2), (3)");
const store = db.createTagStore(4);

store.get`SELECT 1 AS one`;
console.log("size:", store.size);
db.function("clear_store", () => {
  store.clear();
  return 1;
});

const rows = store.all`SELECT clear_store() AS c, a FROM t ORDER BY a`;
console.log(rows);
console.log("size:", store.size);
console.log(store.get`SELECT 1 AS one`);
db.close();
