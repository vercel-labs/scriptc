// FileHandle.stat options: Node validates the handle first, then reads
// options.bigint through the property — so a bigint accessor runs after the
// handle check (a closed handle is EBADF before the read), a throwing one
// rejects with its own error, and a null options value rejects with the
// property read's TypeError. The member table still comes from the call's
// static type, so a getter answering true yields BigIntStats.
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Stats } from "node:fs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fsp-fhstat-accessor-"));
const file = path.join(dir, "file.txt");
fs.writeFileSync(file, "hello");
const handle = await fsp.open(file);

let reads = 0;
const getter = {
  get bigint(): true {
    reads += 1;
    console.log("getter", reads);
    return true;
  },
};
const big = await handle.stat(getter);
console.log("getter bigint", big.size, typeof big.size, reads);

// A stored record: the getter still runs at the call.
const stored = getter;
const again = await handle.stat(stored);
console.log("stored bigint", again.size, reads);

const plain: { bigint?: false } = {};
const numberSize = await handle.stat(plain);
console.log("plain stats", numberSize.size, typeof numberSize.size);

// A throwing accessor replaces the stat with its error.
const throwing = {
  get bigint(): false {
    throw new Error("read boom");
  },
};
try {
  console.log("throwing unexpected", (await handle.stat(throwing)).size);
} catch (error) {
  console.log("throwing", (error as Error).message, reads);
}

// A null options value reaches the property read after the handle check.
function maybe(options: null | { bigint?: false }): Promise<Stats> {
  return handle.stat(options);
}
try {
  await maybe(null);
} catch (error) {
  console.log("null options", (error as Error).message);
}
console.log("record options", (await maybe({})).size);

await handle.close();

// Closed handle: EBADF first, the options accessor never runs.
let closedReads = 0;
const closedGetter = {
  get bigint(): true {
    closedReads += 1;
    return true;
  },
};
try {
  await handle.stat(closedGetter);
} catch (error) {
  const errno = error as NodeJS.ErrnoException;
  console.log("closed", errno.code, errno.message, closedReads);
}

fs.rmSync(dir, { recursive: true, force: true });
