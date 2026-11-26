// A session the program drops inside a cycle is collected while its database
// stays alive: the database's registry lets go of the entry, so the later
// close of the still-live database never touches a freed session. Prints the
// resident-set growth in MiB after a warm-up.
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync(":memory:");
db.exec("CREATE TABLE t (a INTEGER)");

function round(): void {
  const holder: Record<string, unknown> = {};
  holder.self = holder;
  holder.session = db.createSession({ table: "t" });
}

function churn(): void {
  for (let i = 0; i < 2000; i++) {
    const junk: Record<string, unknown> = {};
    junk.self = junk;
    junk.payload = "x".repeat(256);
  }
}

for (let i = 0; i < 20; i++) {
  round();
  churn();
}
const before = process.memoryUsage().rss;
for (let i = 0; i < 400; i++) {
  round();
  churn();
}
const growth = Math.round((process.memoryUsage().rss - before) / (1024 * 1024));
db.close();
console.log(growth);
