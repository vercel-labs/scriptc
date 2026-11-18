// node:sqlite's setAuthorizer and the extension-loading guards: the action
// codes and names the authorizer sees, deny/ignore answers surfacing as
// SQLite errors, the errors a callback with a bad answer raises, a callback
// that throws, clearing with null, and the states loadExtension refuses.
import { DatabaseSync, constants } from "node:sqlite";

const db = new DatabaseSync(":memory:");
const seen: unknown[][] = [];
db.setAuthorizer((action, p1, p2, p3, p4) => {
  seen.push([action, p1, p2, p3, p4]);
  return constants.SQLITE_OK;
});
db.exec("CREATE TABLE t (a)");
db.setAuthorizer(null);
console.log(seen);
db.exec("INSERT INTO t VALUES (1)");
console.log(db.prepare("SELECT COUNT(*) AS n FROM t").get());

db.setAuthorizer((action) =>
  action === constants.SQLITE_READ ? constants.SQLITE_DENY : constants.SQLITE_OK,
);
try {
  db.prepare("SELECT a FROM t").get();
} catch (error) {
  const e = error as { message: string; code: string; errcode: number; errstr: string };
  console.log("deny:", e.message, e.code, e.errcode, e.errstr);
}

db.setAuthorizer(() => "x" as any);
try {
  db.prepare("SELECT a FROM t").get();
} catch (error) {
  const e = error as Record<string, unknown>;
  console.log("badret:", e.name, e.message, e.code);
}
db.setAuthorizer(() => 99 as any);
try {
  db.prepare("SELECT a FROM t").get();
} catch (error) {
  const e = error as Record<string, unknown>;
  console.log("badcode:", e.name, e.message, e.code);
}
db.setAuthorizer(() => {
  throw new Error("authboom");
});
try {
  db.prepare("SELECT a FROM t").get();
} catch (error) {
  const e = error as Record<string, unknown>;
  console.log("throw:", e.message, e.code);
}
db.setAuthorizer(null);
try {
  db.setAuthorizer(1 as never);
} catch (error) {
  const e = error as { message: string; code: string };
  console.log("sett:", e.message, e.code);
}
db.close();

const plain = new DatabaseSync(":memory:");
try {
  plain.enableLoadExtension(true);
} catch (error) {
  const e = error as { message: string; code: string };
  console.log("enable:", e.message, e.code);
}
try {
  plain.loadExtension("/nonexistent/x.so");
} catch (error) {
  const e = error as { message: string; code: string };
  console.log("load:", e.message, e.code);
}
try {
  plain.enableLoadExtension(1 as any);
} catch (error) {
  const e = error as { message: string; code: string };
  console.log("enabletype:", e.message, e.code);
}
plain.close();

const allowed = new DatabaseSync(":memory:", { allowExtension: true });
try {
  allowed.loadExtension("/nonexistent/x.so");
} catch (error) {
  const e = error as { message: string; code: string };
  console.log("load2:", e.message, e.code);
}
allowed.close();
