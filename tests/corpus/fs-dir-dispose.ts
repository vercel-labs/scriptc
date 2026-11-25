// Dir disposal: Symbol.dispose closes with closeSync and returns silently on
// an already-closed Dir and throws a catchable ERR_DIR_CONCURRENT_OPERATION
// while a read is queued, Symbol.asyncDispose awaits close but resolves on an
// already-closed Dir, and `using`/`await using` dispose at scope exit in
// reverse order.
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dir-dispose-"));
fs.writeFileSync(path.join(dir, "entry"), "");

function explicit(): void {
  const closed = fs.opendirSync(dir);
  closed.closeSync();
  closed[Symbol.dispose]();
  console.log("dispose after close", "returned");
  const open = fs.opendirSync(dir);
  open[Symbol.dispose]();
  try {
    open.readSync();
  } catch (error) {
    console.log("dispose closed it", (error as { code?: string }).code);
  }
}

function usingSync(): void {
  using handle = fs.opendirSync(dir);
  console.log("using reads", handle.readSync() !== null);
}

async function asyncDispose(): Promise<void> {
  const closed = fs.opendirSync(dir);
  closed.closeSync();
  try {
    await closed[Symbol.asyncDispose]();
    console.log("async dispose after close", "resolved");
  } catch (error) {
    console.log("async dispose after close", (error as { code?: string }).code);
  }
  const open = fs.opendirSync(dir);
  await open[Symbol.asyncDispose]();
  try {
    await open.read();
  } catch (error) {
    console.log("async dispose closed it", (error as { code?: string }).code);
  }
  {
    await using handle = await fsp.opendir(dir);
    console.log("await using reads", (await handle.read()) !== null);
  }
  {
    await using handle = fs.opendirSync(dir);
    console.log("await using a sync Dir reads", handle.readSync() !== null);
  }
  {
    using first = fs.opendirSync(dir);
    await using second = await fsp.opendir(dir);
    first.closeSync();
    const again: string[] = [];
    for await (const entry of second) again.push(entry.name);
    console.log("nested", again.join(), first.path === dir);
  }
  {
    // Symbol.dispose is closeSync, which throws while a read is queued.
    const busy = fs.opendirSync(dir);
    const pending = busy.read();
    try {
      busy[Symbol.dispose]();
      console.log("dispose during a read", "returned");
    } catch (error) {
      console.log("dispose during a read", (error as { code?: string }).code);
    }
    console.log("the read still settles", (await pending) !== null);
    busy.closeSync();
  }
  fs.rmSync(dir, { recursive: true });
  console.log("removed", fs.existsSync(dir));
}

explicit();
usingSync();
asyncDispose();
