// node:sqlite's changeset sessions: createSession captures the changes made
// after it was created, changeset()/patchset() answer their bytes, close()
// makes further calls state errors, applyChangeset replays them (and its
// conflict answers), and createSession's table/db options are validated.
import { DatabaseSync, constants } from "node:sqlite";

const db = new DatabaseSync(":memory:");
db.exec("CREATE TABLE t (a INTEGER PRIMARY KEY, b TEXT)");
const session = db.createSession();
db.exec("INSERT INTO t VALUES (1, 'x'), (2, 'y')");
const changeset = session.changeset();
console.log(changeset instanceof Uint8Array, changeset.length > 0);
const patchset = session.patchset();
console.log(patchset instanceof Uint8Array, patchset.length > 0);
session.close();
try {
  session.changeset();
} catch (error) {
  const e = error as { message: string; code: string };
  console.log("closed:", e.message, e.code);
}

db.exec("DELETE FROM t");
console.log(db.prepare("SELECT COUNT(*) AS n FROM t").get());
console.log("applied:", db.applyChangeset(changeset));
console.log(db.prepare("SELECT a, b FROM t ORDER BY a").all());
db.exec("UPDATE t SET b = 'z' WHERE a = 1");
console.log("conflict-default:", db.applyChangeset(changeset));
console.log(
  "conflict-omit:",
  db.applyChangeset(changeset, {
    onConflict: () => constants.SQLITE_CHANGESET_OMIT,
  }),
);
console.log(db.prepare("SELECT a, b FROM t ORDER BY a").all());

const updated = db.createSession({ table: "t" });
db.exec("UPDATE t SET b = 'q' WHERE a = 2");
console.log(updated.changeset().length > 0);
updated.close();
const named = db.createSession({ db: "main" });
console.log(typeof named.changeset);
named.close();

try {
  db.createSession({ table: 1 as any });
} catch (error) {
  const e = error as { message: string; code: string };
  console.log("badsess:", e.message, e.code);
}
try {
  db.applyChangeset("nope" as unknown as Uint8Array);
} catch (error) {
  const e = error as { message: string; code: string };
  console.log("badapply:", e.message, e.code);
}
db.close();
