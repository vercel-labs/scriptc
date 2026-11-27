// Statements a program drops are finalized once nothing can reach them:
// a long-lived connection preparing (and discarding) a query per request
// does not accumulate prepared statements, their cached binds or their
// metadata, and a statement that refers to itself through an added
// property is reclaimed with its cycle rather than kept by the
// connection's live-statement list. Prints the resident-set growth in MiB
// after a warm-up.
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync(":memory:");
function round(n: number): void {
  for (let i = 0; i < n; i++) db.prepare("SELECT 1 AS a");
}
function cycled(n: number): void {
  for (let i = 0; i < n; i++) {
    const statement = db.prepare("SELECT 1 AS a");
    (statement as unknown as Record<string, unknown>)["cached"] = statement;
  }
}
round(200);
cycled(200);
const before = process.memoryUsage().rss;
round(20000);
cycled(20000);
console.log(Math.round((process.memoryUsage().rss - before) / (1024 * 1024)));
db.close();
