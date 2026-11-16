// readdir with recursive and withFileTypes together: a Dirent row for every
// entry below the path, each name its basename and each parentPath the
// directory holding it relative to the path (the path as given at the top
// level), in Node's queue order. The names-only recursive listing still
// answers relative paths.
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dir = fs.mkdtempSync(join(tmpdir(), "readdir-rec-types-"));
fs.writeFileSync(join(dir, "a.txt"), "a");
fs.mkdirSync(join(dir, "x", "y"), { recursive: true });
fs.writeFileSync(join(dir, "x", "b.txt"), "b");
fs.writeFileSync(join(dir, "x", "y", "c.txt"), "c");
fs.mkdirSync(join(dir, "empty"));

const rows = (entries: fs.Dirent[]): string[] =>
  entries.map(
    (d) =>
      `${d.name}:${d.parentPath.split(dir).join("<d>")}:${d.isDirectory() ? "d" : d.isFile() ? "f" : "?"}`,
  );

console.log("all", JSON.stringify(rows(fs.readdirSync(dir, { recursive: true, withFileTypes: true }))));
console.log(
  "sub",
  JSON.stringify(rows(fs.readdirSync(join(dir, "x"), { recursive: true, withFileTypes: true }))),
);
console.log(
  "false",
  JSON.stringify(rows(fs.readdirSync(dir, { recursive: false, withFileTypes: true }))),
);
console.log(
  "promise",
  JSON.stringify(rows(await fsp.readdir(dir, { recursive: true, withFileTypes: true }))),
);
console.log("names", JSON.stringify(fs.readdirSync(dir, { recursive: true })));
console.log("promise names", JSON.stringify(await fsp.readdir(dir, { recursive: true })));

try {
  fs.readdirSync(join(dir, "missing"), { recursive: true, withFileTypes: true });
} catch (error) {
  const err = error as NodeJS.ErrnoException;
  console.log("missing", err.code, err.syscall);
}

fs.rmSync(dir, { recursive: true, force: true });
