// readdir's recursive options: the sync walk queues directories FIFO and
// reads each when its turn comes; fs.promises recurses into a directory
// before yielding its entries. Names list paths relative to the argument,
// Dirent rows carry the directory's path as parentPath, and a names walk
// follows a symlink to a directory while a Dirent walk does not.
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "scr-rec-opts-"));
function relativeTo(root: string, path: string): string {
  if (path === root) return ".";
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
}
fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(`${root}/a/b`, { recursive: true });
fs.mkdirSync(`${root}/z`);
fs.writeFileSync(`${root}/f1.txt`, "1");
fs.writeFileSync(`${root}/a/f2.txt`, "2");
fs.writeFileSync(`${root}/a/b/f3.txt`, "3");
fs.writeFileSync(`${root}/z/f4.txt`, "4");
fs.symlinkSync(`${root}/a/b`, `${root}/link`);

// The names walks, sync then promise.
console.log("sync", fs.readdirSync(root, { recursive: true }).join(" "));
console.log("sync-slash", fs.readdirSync(`${root}/`, { recursive: true }).join(" "));

// The Dirent walks: nested rows carry the directory that listed them.
function rows(listing: fs.Dirent[]): string {
  return listing
    .map((r) => `${relativeTo(root, r.parentPath)}/${r.name}${r.isDirectory() ? "/" : ""}`)
    .join(" ");
}
console.log("sync-dirent", rows(fs.readdirSync(root, { recursive: true, withFileTypes: true })));

async function main(): Promise<void> {
  console.log("promise", (await fsp.readdir(root, { recursive: true })).join(" "));
  console.log(
    "promise-dirent",
    rows(await fsp.readdir(root, { recursive: true, withFileTypes: true })),
  );
  // A file entry below a directory named in the walk.
  console.log(
    "promise-types",
    (await fsp.readdir(`${root}/a`, { recursive: true })).join(" "),
  );
  // The buffered names walk rejects Node's TypeError on its first entry
  // once a Buffer would have to be joined into a path.
  try {
    await fsp.readdir(root, { recursive: true, encoding: "buffer" });
    console.log("p-no-throw");
  } catch (e) {
    console.log("p-caught", (e as NodeJS.ErrnoException).code);
  }
}

main().then(() => {
  fs.rmSync(root, { recursive: true, force: true });
});
