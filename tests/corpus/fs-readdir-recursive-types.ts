// readdir with recursive and withFileTypes together: a Dirent row for every
// entry below the path, each name its basename and each parentPath the
// directory holding it relative to the path (the path as given at the top
// level). The synchronous form walks a queue and follows a symlinked
// directory; fs/promises walks a stack (depth-first, so a later sibling
// comes first) and does not follow the symlink when withFileTypes is set —
// its names-only form does. The names-only recursive listing still answers
// relative paths.
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
// Two sibling directories with entries of their own, plus a symlink to one
// of them: the walks order these differently and disagree on the link.
fs.mkdirSync(join(dir, "one", "one-deep"), { recursive: true });
fs.mkdirSync(join(dir, "two", "two-deep"), { recursive: true });
fs.writeFileSync(join(dir, "one", "one.txt"), "1");
fs.writeFileSync(join(dir, "one", "one-deep", "deep.txt"), "d");
fs.writeFileSync(join(dir, "two", "two.txt"), "2");
fs.writeFileSync(join(dir, "two", "two-deep", "deep.txt"), "d");
fs.symlinkSync("../two", join(dir, "one", "link"));

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
// fs/promises: the stack walk, and the symlink rule per form.
console.log(
  "promise types",
  JSON.stringify(rows(await fsp.readdir(dir, { recursive: true, withFileTypes: true }))),
);
console.log(
  "promise names",
  JSON.stringify(
    (await fsp.readdir(dir, { recursive: true })).map((n) => n.split(dir).join("<d>")),
  ),
);

try {
  fs.readdirSync(join(dir, "missing"), { recursive: true, withFileTypes: true });
} catch (error) {
  const err = error as NodeJS.ErrnoException;
  console.log("missing", err.code, err.syscall);
}

fs.rmSync(dir, { recursive: true, force: true });
