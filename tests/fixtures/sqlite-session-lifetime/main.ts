// Sessions a program drops are deleted with their last reference, so
// request-scoped sessions do not accumulate change tracking and history on a
// long-lived database. Prints the resident-set growth in MiB after a warm-up.
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync(":memory:");
db.exec("CREATE TABLE t (a INTEGER)");

function round(n: number): void {
  for (let i = 0; i < n; i++) {
    const session = db.createSession({ table: "t" });
    for (let k = 0; k < 10; k++) db.exec(`INSERT INTO t VALUES (${i * 10 + k})`);
    void session;
  }
}

round(100);
const before = process.memoryUsage().rss;
round(4000);
console.log(Math.round((process.memoryUsage().rss - before) / (1024 * 1024)));
