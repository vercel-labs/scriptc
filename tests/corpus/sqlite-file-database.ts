// node:sqlite over a file-backed database: the location the connection
// reports, data surviving a close and reopen, and a readOnly connection
// refusing writes (ERR_SQLITE_ERROR, SQLITE_READONLY).
import { rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const tail = (path: string): string => {
  let i = path.length - 1;
  while (i >= 0 && path.charAt(i) !== "/" && path.charAt(i) !== "\\") i = i - 1;
  return path.slice(i + 1);
};
const path = "tmp-sqlite-file-" + tail(process.argv[1] ?? "program") + "-" + process.pid + ".db";

const db = new DatabaseSync(path);
console.log(db.location() === path, db.location()?.endsWith(".db"));
db.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)");
db.prepare("INSERT INTO items (name) VALUES (?)").run("first");
db.close();

const reopened = new DatabaseSync(path);
console.log(reopened.prepare("SELECT COUNT(*) AS n FROM items").get());
reopened.close();

const readOnly = new DatabaseSync(path, { readOnly: true });
console.log(readOnly.prepare("SELECT name FROM items").get());
try {
  readOnly.exec("INSERT INTO items (name) VALUES ('second')");
} catch (error) {
  const e = error as { message: string; code: string; errcode: number; errstr: string };
  console.log(e.message, e.code, e.errcode, e.errstr);
}
readOnly.close();
rmSync(path);
