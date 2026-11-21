const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(":memory:");
db.exec("CREATE TABLE t (a INTEGER)");
const saved = db.exec;
db.exec = saved;
db.exec("INSERT INTO t VALUES (1)");
console.log("n", db.prepare("SELECT count(*) AS n FROM t").get().n);
