// A database and the session it created, dropped without an explicit close,
// are reclaimed together: the session's SQLite object is deleted before its
// connection can close, whatever order the collector frees them in. Prints
// the resident-set growth in MiB after a warm-up.
import { DatabaseSync } from "node:sqlite";

function round(n: number): void {
  for (let i = 0; i < n; i++) {
    const db = new DatabaseSync(":memory:");
    db.createSession();
  }
}
round(100);
const before = process.memoryUsage().rss;
round(4000);
console.log(Math.round((process.memoryUsage().rss - before) / (1024 * 1024)));
