// fs.mkdtempDisposableSync and fs.promises.mkdtempDisposable: the records
// Node 24 answers for a freshly created temporary directory — `path`, a
// `remove` that deletes the tree, and the dispose symbol — called explicitly
// and by `using` / `await using` at scope exit.
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const base = path.join(os.tmpdir(), "mkdtemp-disposable-");

function explicitSync(): void {
  const dir = fs.mkdtempDisposableSync(base);
  console.log("sync path", dir.path.startsWith(base), typeof dir.path, fs.existsSync(dir.path));
  fs.writeFileSync(path.join(dir.path, "entry"), "payload");
  console.log("sync remove", dir.remove(), fs.existsSync(dir.path));
  // Node's remove is binding.rmSync(path, 0, recursive, retryDelay): the
  // second call finds nothing and still returns quietly.
  console.log("sync remove again", dir.remove(), fs.existsSync(dir.path));
}

function symbolSync(): void {
  const dir = fs.mkdtempDisposableSync(base, { encoding: "utf8" });
  fs.writeFileSync(path.join(dir.path, "entry"), "payload");
  console.log("sync dispose", dir[Symbol.dispose](), fs.existsSync(dir.path));
}

function usingSync(): void {
  let seen = "";
  {
    using dir = fs.mkdtempDisposableSync(base);
    seen = dir.path;
    fs.writeFileSync(path.join(seen, "entry"), "payload");
    console.log("using created", seen.startsWith(base), fs.existsSync(seen));
  }
  console.log("using disposed", fs.existsSync(seen));
}

async function explicitAsync(): Promise<void> {
  const dir = await fsp.mkdtempDisposable(base);
  console.log("async path", dir.path.startsWith(base), typeof dir.path, fs.existsSync(dir.path));
  fs.writeFileSync(path.join(dir.path, "entry"), "payload");
  console.log("async remove", await dir.remove(), fs.existsSync(dir.path));
  console.log("async remove again", await dir.remove(), fs.existsSync(dir.path));
  const other = await fsp.mkdtempDisposable(base, "utf8");
  console.log("async dispose", await other[Symbol.asyncDispose](), fs.existsSync(other.path));
}

async function awaitUsing(): Promise<void> {
  let seen = "";
  {
    await using dir = await fsp.mkdtempDisposable(base);
    seen = dir.path;
    fs.writeFileSync(path.join(seen, "entry"), "payload");
    console.log("await using created", seen.startsWith(base), fs.existsSync(seen));
  }
  console.log("await using disposed", fs.existsSync(seen));
  let first = "";
  let second = "";
  {
    using sync = fs.mkdtempDisposableSync(base);
    await using async = await fsp.mkdtempDisposable(base);
    first = sync.path;
    second = async.path;
    fs.writeFileSync(path.join(first, "entry"), "payload");
    fs.writeFileSync(path.join(second, "entry"), "payload");
    console.log("nested created", first !== second, fs.existsSync(first), fs.existsSync(second));
  }
  console.log("nested disposed", fs.existsSync(first), fs.existsSync(second));
}

explicitSync();
symbolSync();
usingSync();
await explicitAsync();
await awaitUsing();
