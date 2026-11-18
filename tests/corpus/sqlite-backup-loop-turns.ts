// node:sqlite's backup() copies between loop turns, so a step that a writer
// blocks is retried while the event loop keeps running: the timer that
// releases the write transaction fires, and the copy then finishes. A copy
// that retried on one turn would never let that timer run.
import { rmSync } from "node:fs";
import { DatabaseSync, backup } from "node:sqlite";

const path = "tmp-sqlite-backup-loop-turns-" + process.pid + ".db";
rmSync(path, { force: true });

async function main(): Promise<void> {
  const source = new DatabaseSync(":memory:");
  source.exec("CREATE TABLE t (a)");
  source.exec("BEGIN");
  for (let i = 0; i < 200; i++) source.exec(`INSERT INTO t VALUES (${i})`);
  source.exec("COMMIT");

  let locked = false;
  let released = false;
  const progress: number[] = [];
  const pages = await backup(source, path, {
    rate: 1,
    progress: (info) => {
      progress.push(info.remainingPages);
      if (!locked) {
        // A write transaction on the source makes every following step
        // report SQLITE_BUSY until it commits.
        locked = true;
        source.exec("BEGIN IMMEDIATE");
        source.exec("UPDATE t SET a = a");
        setTimeout(() => {
          source.exec("COMMIT");
          released = true;
          console.log("released");
        }, 20);
      }
    },
  });
  console.log("retried:", progress.length > pages, "released first:", released, "pages:", pages > 0);

  const copy = new DatabaseSync(path);
  console.log(copy.prepare("SELECT COUNT(*) AS n FROM t").get());
  copy.close();
  source.close();
  rmSync(path, { force: true });
}

void main();
