// Session wrappers collected in a cycle while the database stays open must
// not leave entries behind in the database's session registry: a request
// loop that opens one database and drops a request-scoped session into a
// cycle prints the resident-set growth in MiB after a warm-up.
import { DatabaseSync } from "node:sqlite";
import type { Session } from "node:sqlite";

const db = new DatabaseSync(":memory:");
db.exec("CREATE TABLE t (x)");

interface Holder {
  session: Session;
  self?: Holder;
}

function churn(count: number): void {
  for (let i = 0; i < count; i++) {
    const holder: Holder = { session: db.createSession() };
    holder.self = holder;
  }
}

churn(2000);
const before = process.memoryUsage().rss;
for (let i = 0; i < 250; i++) churn(2000);
console.log(Math.round((process.memoryUsage().rss - before) / (1024 * 1024)));
db.close();
