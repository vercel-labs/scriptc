// node:sqlite through a facade namespace's renamed re-exports: construction,
// instanceof and backup() must lower through the member identifier's own
// symbol, not through the name the access spells. A receiver with evaluation
// of its own runs once, in order, before the call.
import { existsSync, rmSync } from "node:fs";
import * as facade from "./facade.ts";

const tail = (path: string): string => {
  let i = path.length - 1;
  while (i >= 0 && path.charAt(i) !== "/" && path.charAt(i) !== "\\") i = i - 1;
  return path.slice(i + 1);
};
const base = "tmp-sqlite-facade-" + tail(process.argv[1] ?? "program") + "-" + process.pid;
const source = base + "-source.db";
const copies = [1, 2, 3, 4].map((n) => `${base}-copy${n}.db`);

const marks: string[] = [];
const pick = (): typeof facade => {
  marks.push("pick");
  return facade;
};

async function main(): Promise<void> {
  rmSync(source, { force: true });
  for (const path of copies) rmSync(path, { force: true });
  const db = new facade.DB(source);
  db.exec("CREATE TABLE t (a); INSERT INTO t VALUES (1), (2)");
  console.log("constructed", db instanceof facade.DB);
  const pages = await facade.snapshotBackup(db, copies[0]!);
  console.log("backup", pages, existsSync(copies[0]!));

  const comma = await (marks.push("comma"), facade).snapshotBackup(db, copies[1]!);
  console.log("comma", comma, marks.join(","));
  marks.length = 0;

  const cond = await (
    marks.length === 0 ? (marks.push("cond"), facade) : facade
  ).snapshotBackup(db, copies[2]!);
  console.log("cond", cond, marks.join(","));
  marks.length = 0;

  const call = await pick().snapshotBackup(db, copies[3]!);
  console.log("call", call, marks.join(","));

  db.close();
  rmSync(source, { force: true });
  for (const path of copies) rmSync(path, { force: true });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
