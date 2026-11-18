// node:sqlite's backup() failures: a destination that cannot be opened
// rejects the promise with the engine's message and code, and the source
// connection stays usable.
import { DatabaseSync, backup } from "node:sqlite";

const db = new DatabaseSync(":memory:");
db.exec("CREATE TABLE t (a); INSERT INTO t VALUES (1)");
try {
  await backup(db, "/");
} catch (error) {
  const e = error as { message: string; code: string; errcode: number; errstr: string };
  console.log("open:", e.message, e.code, e.errcode, e.errstr);
}
console.log(db.prepare("SELECT COUNT(*) AS n FROM t").get());
db.close();
console.log("closed");
