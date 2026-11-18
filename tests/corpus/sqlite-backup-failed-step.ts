// node:sqlite's backup() rejects with the failing step's own code: a
// destination that is not a database reports SQLITE_NOTADB with the engine's
// text, not an empty error from the destination handle.
import { rmSync, writeFileSync } from "node:fs";
import { DatabaseSync, backup } from "node:sqlite";

const path = "tmp-sqlite-backup-failed-step-" + process.pid + ".db";
rmSync(path, { force: true });
writeFileSync(path, Buffer.alloc(8192, 0x41));

async function main(): Promise<void> {
  const source = new DatabaseSync(":memory:");
  source.exec("CREATE TABLE t (a); INSERT INTO t VALUES (1)");
  try {
    const pages = await backup(source, path, { rate: 1 });
    console.log("pages", pages);
  } catch (error) {
    const e = error as { message: string; code: string; errcode: number; errstr: string };
    console.log("error", e.code, e.errcode, e.errstr, e.message);
  }
  source.close();
  rmSync(path, { force: true });
}

void main();
