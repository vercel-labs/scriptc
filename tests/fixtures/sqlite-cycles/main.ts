// A database that owns objects referring back to it -- a cached tag store, a
// closure over the connection, a statement -- is reclaimed once nothing else
// holds them: the runtime's cycle collector frees the group, so a
// request-scoped database does not pin its cache and metadata for good.
// Prints the resident-set growth in MiB after a warm-up round.
import { DatabaseSync } from "node:sqlite";

function round(): void {
  const payload = "x".repeat(128 * 1024);
  const db = new DatabaseSync(":memory:");
  const fields = db as unknown as Record<string, unknown>;
  const tag = db.createTagStore(4);
  (tag as unknown as Record<string, unknown>).payload = payload;
  fields.tag = tag;
  fields.back = () => {
    payload.length;
    return db.isOpen;
  };
  const stmt = db.prepare("SELECT 1 AS a");
  (stmt as unknown as Record<string, unknown>).payload = payload;
  fields.stmt = stmt;
}

function measure(): number {
  for (let i = 0; i < 20; i++) round();
  const before = process.memoryUsage().rss;
  for (let i = 0; i < 400; i++) round();
  return Math.round((process.memoryUsage().rss - before) / (1024 * 1024));
}

console.log(measure());
