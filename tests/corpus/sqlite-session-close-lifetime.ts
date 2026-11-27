// A closed session keeps its wrapper (and its database reference) alive: the
// native session is deleted once, a later close reports the closed session,
// and the database's own close does not touch a freed session.
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync(":memory:");
db.exec("CREATE TABLE t (a INTEGER)");
const session = db.createSession({ table: "t" });
db.exec("INSERT INTO t VALUES (1)");
session.close();
try {
  session.close();
} catch (error) {
  const e = error as { name: string; code: string; message: string };
  console.log("second", e.name, e.code, JSON.stringify(e.message));
}
db.close();
console.log("db closed");

const disposeDb = new DatabaseSync(":memory:");
disposeDb.exec("CREATE TABLE t (a INTEGER)");
const disposed = disposeDb.createSession({ table: "t" });
disposed[Symbol.dispose]();
disposeDb.close();
console.log("dispose db closed");
