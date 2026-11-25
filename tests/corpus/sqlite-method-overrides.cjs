// A method read from a database, statement or tag store runs the class's
// implementation when it is called, including after the program writes that
// same value back onto the property; a function the program writes over the
// property is what runs, as Node runs it.
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(":memory:");
db.exec("CREATE TABLE t (a INTEGER)");
const saved = db.exec;
db.exec = saved;
db.exec("INSERT INTO t VALUES (1)");
console.log("saved", db.prepare("SELECT count(*) AS n FROM t").get().n);
let calls = 0;
const override = function (sql) {
  calls += 1;
  return undefined;
};
db.exec = override;
db.exec("ignored");
console.log("override", calls, db.exec === override);
const stmt = db.prepare("SELECT 1 AS n");
const savedGet = stmt.get;
stmt.get = savedGet;
console.log("stmtSaved", stmt.get().n);
