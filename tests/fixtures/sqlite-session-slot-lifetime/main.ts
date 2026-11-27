// Sessions a program holds across a database's close must not leave their
// registry entries behind: closing the database hands back both references
// on each live session's entry. A request loop that opens a database,
// creates sessions and closes it prints the resident-set growth in MiB after
// a warm-up.
import { DatabaseSync } from "node:sqlite";
import type { Session } from "node:sqlite";

function cycle(count: number): void {
  const db = new DatabaseSync(":memory:");
  const sessions: Session[] = [];
  for (let i = 0; i < count; i++) sessions.push(db.createSession());
  db.close();
  // The sessions go out of scope here: their entries are already gone.
  if (sessions.length === 0) console.log("empty");
}
cycle(100);
const before = process.memoryUsage().rss;
for (let i = 0; i < 250; i++) cycle(2000);
console.log(Math.round((process.memoryUsage().rss - before) / (1024 * 1024)));
