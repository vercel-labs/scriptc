const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(":memory:");
db.exec("CREATE TABLE t (a INTEGER)");
const saved = db.exec;
let reads = 0;
Object.defineProperty(db, "exec", {
  configurable: true,
  get() {
    reads += 1;
    if (reads > 1) throw new Error("second read");
    return saved;
  },
});
db.exec("INSERT INTO t VALUES (1)");
console.log("reads", reads, db.prepare("SELECT count(*) AS n FROM t").get().n);
