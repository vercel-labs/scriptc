// node:sqlite through a facade namespace's renamed re-exports: construction,
// instanceof and backup() must lower through the member identifier's own
// symbol, not through the name the access spells.
import { existsSync, rmSync } from "node:fs";
import * as facade from "./facade.ts";

const tail = (path: string): string => {
  let i = path.length - 1;
  while (i >= 0 && path.charAt(i) !== "/" && path.charAt(i) !== "\\") i = i - 1;
  return path.slice(i + 1);
};
const base = "tmp-sqlite-facade-" + tail(process.argv[1] ?? "program") + "-" + process.pid;
const source = base + "-source.db";
const copy = base + "-copy.db";

async function main(): Promise<void> {
  rmSync(source, { force: true });
  rmSync(copy, { force: true });
  const db = new facade.DB(source);
  db.exec("CREATE TABLE t (a); INSERT INTO t VALUES (1), (2)");
  console.log("constructed", db instanceof facade.DB);
  const pages = await facade.snapshotBackup(db, copy);
  console.log("backup", pages, existsSync(copy));
  db.close();
  rmSync(source, { force: true });
  rmSync(copy, { force: true });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
