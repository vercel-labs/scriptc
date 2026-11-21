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
const copies = [1, 2, 3, 4, 5, 6].map((n) => `${base}-copy${n}.db`);

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

  // The receiver runs before the arguments, each exactly once.
  const ordered = await (marks.push("receiver"), facade).snapshotBackup(
    db,
    (marks.push("argument"), copies[2]!),
  );
  console.log("ordered", ordered, marks.join(","));
  marks.length = 0;

  // A conditional receiver evaluates its condition and only the chosen branch.
  const cond = await (
    marks.push("condition"),
    marks.length > 0 ? (marks.push("branch"), facade) : facade
  ).snapshotBackup(db, copies[3]!);
  console.log("cond", cond, marks.join(","));
  marks.length = 0;

  const condFalse = await (
    marks.push("condition"),
    marks.length > 1 ? (marks.push("branch"), facade) : facade
  ).snapshotBackup(db, copies[4]!);
  console.log("condfalse", condFalse, marks.join(","));
  marks.length = 0;

  const call = await pick().snapshotBackup(db, (marks.push("argument"), copies[5]!));
  console.log("call", call, marks.join(","));

  db.close();
  rmSync(source, { force: true });
  for (const path of copies) rmSync(path, { force: true });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
