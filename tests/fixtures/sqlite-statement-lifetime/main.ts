// Statements a program drops are finalized once nothing can reach them:
// a long-lived connection preparing (and discarding) a query per request
// does not accumulate prepared statements, their cached binds or their
// metadata. Prints the resident-set growth in MiB after a warm-up.
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync(":memory:");
function round(n: number): void {
  for (let i = 0; i < n; i++) db.prepare("SELECT 1 AS a");
}
round(200);
const before = process.memoryUsage().rss;
round(20000);
console.log(Math.round((process.memoryUsage().rss - before) / (1024 * 1024)));
db.close();
