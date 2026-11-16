// node:sqlite's returnArrays option, at the database, the statement and the
// per-statement setter, and readBigInts at the database level (which reaches
// a statement's rows and run()'s counters).
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync(":memory:", { returnArrays: true });
db.exec("CREATE TABLE t (a, b); INSERT INTO t VALUES (1, 2)");
console.log(db.prepare("SELECT * FROM t").get());
console.log(db.prepare("SELECT * FROM t").all());
console.log(db.prepare("SELECT * FROM t").iterate().next());
const rows = db.prepare("SELECT * FROM t", { returnArrays: false });
console.log(rows.get());
rows.setReturnArrays(true);
console.log(rows.get());
db.close();

const counter = new DatabaseSync(":memory:", { readBigInts: true });
counter.exec("CREATE TABLE t (a, b)");
const insert = counter.prepare("INSERT INTO t VALUES (?, ?)");
console.log(insert.run(1, 2));
console.log(counter.prepare("SELECT 1 AS n, 2.5 AS f, 'x' AS s").get());
insert.setReadBigInts(false);
console.log(insert.run(3, 4));
counter.close();
