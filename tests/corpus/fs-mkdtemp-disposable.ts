// fsPromises.mkdtempDisposable / fs.mkdtempDisposableSync answer the created
// directory plus its removal and disposal hooks: `path` is the path mkdtemp
// made, remove() deletes the directory tree (a tree that is already gone is
// not a failure — the removal is rimraf-shaped), and the disposal symbols are
// remove() under Node's names. The path is resolved against the cwd when the
// object is made, so a later chdir cannot change what remove() deletes.
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const base = fs.mkdtempSync(join(tmpdir(), "scr-mkdtemp-disposable-"));
const exists = (path: string): boolean => fs.existsSync(path);

// 1. The promise form: the directory exists, remove() deletes it, and a
// second remove() settles without an error.
const made = await fs.promises.mkdtempDisposable(join(base, "promised-"));
console.log("path", made.path.startsWith(base), exists(made.path));
await made.remove();
console.log("removed", exists(made.path));
try {
  await made.remove();
  console.log("second remove", "resolved");
} catch (err) {
  console.log("second remove", (err as { code: string }).code);
}

// 2. The options record and the bare name: both are the utf8 the path needs.
const withOptions = await fs.promises.mkdtempDisposable(join(base, "opted-"), { encoding: "utf8" });
const withName = await fs.promises.mkdtempDisposable(join(base, "named-"), "utf8");
console.log("options", exists(withOptions.path), exists(withName.path));
await withOptions[Symbol.asyncDispose]();
await withName[Symbol.asyncDispose]();
console.log("options removed", exists(withOptions.path), exists(withName.path));

// 3. The sync form: path, remove(), and Symbol.dispose.
const sync = fs.mkdtempDisposableSync(join(base, "sync-"));
fs.writeFileSync(join(sync.path, "kept.txt"), "x");
console.log("sync path", exists(join(sync.path, "kept.txt")));
sync[Symbol.dispose]();
console.log("sync disposed", exists(sync.path));

const syncGone = fs.mkdtempDisposableSync(join(base, "again-"));
syncGone.remove();
console.log("sync removed", exists(syncGone.path));
try {
  syncGone.remove();
  console.log("second sync remove", "resolved");
} catch (err) {
  console.log("second sync remove", (err as { code: string }).code);
}

// 4. The objects are disposable declarations: `using` runs the sync form's
// Symbol.dispose at scope exit and `await using` the promise form's
// Symbol.asyncDispose, which is removal under both names.
let usingPath = "";
{
  using scoped = fs.mkdtempDisposableSync(join(base, "using-"));
  usingPath = scoped.path;
  console.log("using exists", exists(scoped.path));
}
console.log("using removed", exists(usingPath));

let awaitUsingPath = "";
{
  await using scoped = await fs.promises.mkdtempDisposable(join(base, "await-using-"));
  awaitUsingPath = scoped.path;
  console.log("await using exists", exists(scoped.path));
}
console.log("await using removed", exists(awaitUsingPath));

fs.rmSync(base, { recursive: true, force: true });
