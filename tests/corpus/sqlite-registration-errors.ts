// node:sqlite's failure paths that free a registration or a session: an
// unusable function name fails Node's error exactly, the database stays
// usable afterwards, and a session dropped before the connection closes
// leaves the connection closable.
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync(":memory:");
try {
  db.function("x".repeat(300), () => 1);
} catch (error) {
  const e = error as { message: string; code: string; errcode: number; errstr: string };
  console.log("name:", e.message, e.code, e.errcode, e.errstr);
}
console.log(db.prepare("SELECT 1 AS n").get());

db.exec("CREATE TABLE t (a)");
function changesetLength(database: DatabaseSync): number {
  const session = database.createSession();
  return session.changeset().length;
}
console.log("session:", changesetLength(db) === 0);

const closed = db.createSession();
closed.close();
console.log(db.prepare("SELECT COUNT(*) AS n FROM t").get());
db.close();
console.log("closed");
