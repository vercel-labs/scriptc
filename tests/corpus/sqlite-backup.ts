// node:sqlite's backup(): copies the source database into a new file, reports
// page progress, and answers the page count; the option checks are Node's.
import { existsSync, rmSync } from "node:fs";
import { DatabaseSync, backup } from "node:sqlite";

const tail = (path: string): string => {
  let i = path.length - 1;
  while (i >= 0 && path.charAt(i) !== "/" && path.charAt(i) !== "\\") i = i - 1;
  return path.slice(i + 1);
};
const path = "tmp-sqlite-backup-" + tail(process.argv[1] ?? "program") + "-" + process.pid + ".db";
rmSync(path, { force: true });

async function main(): Promise<void> {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE t (a); INSERT INTO t VALUES (1), (2), (3)");
  const progress: number[][] = [];
  const pages = await backup(db, path, {
    rate: 1,
    progress: (info) => {
      progress.push([info.totalPages, info.remainingPages]);
    },
  });
  console.log("pages:", pages, "progress:", progress.length);
  const copy = new DatabaseSync(path);
  console.log(copy.prepare("SELECT COUNT(*) AS n FROM t").get());
  copy.close();

  try {
    await backup(db, path, { rate: 0 });
  } catch (error) {
    const e = error as { message: string; code: string };
    console.log("rate0:", e.message, e.code);
  }
  try {
    await backup(db, path, { rate: 1.5 });
  } catch (error) {
    const e = error as { message: string; code: string };
    console.log("ratef:", e.message, e.code);
  }
  try {
    await backup(db, path, { source: 1 as any });
  } catch (error) {
    const e = error as { message: string; code: string };
    console.log("source:", e.message, e.code);
  }
  try {
    await backup(db, path, { progress: 1 as any });
  } catch (error) {
    const e = error as { message: string; code: string };
    console.log("progress:", e.message, e.code);
  }
  try {
    await backup(db, path, { target: 1 as any });
  } catch (error) {
    const e = error as { message: string; code: string };
    console.log("target:", e.message, e.code);
  }
  // Surplus arguments exist only for their effects: they evaluate in source
  // order before the copy, and a throwing one keeps the copy from starting.
  const order: string[] = [];
  const note = (label: string): string => {
    order.push(label);
    return label;
  };
  const fail = (): string => {
    throw new RangeError("extra");
  };
  const extra = path + ".extra";
  rmSync(extra, { force: true });
  // @ts-expect-error: backup reads three arguments and ignores the rest
  const extraPages = await backup(db, extra, { rate: 1 }, note("fourth"), note("fifth"));
  console.log("extra:", extraPages, order.join(","), existsSync(extra));
  rmSync(extra, { force: true });
  try {
    // @ts-expect-error: backup reads three arguments and ignores the rest
    await backup(db, extra, { rate: 1 }, fail());
  } catch (error) {
    const e = error as { name: string; message: string };
    console.log("extra throw:", e.name, e.message, existsSync(extra));
  }
  rmSync(path, { force: true });
  db.close();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
