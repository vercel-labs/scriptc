// FileHandle | undefined with the optional call `handle?.close()`: the
// nullish arm answers undefined without calling, the present arm calls the
// plain method. Node compares both arms, the write in between, the file
// contents after the close, and a second optional close on a cleared binding.
import { open, readFile, rm } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const scratch = path.join(os.tmpdir(), `scr-opt-close-${process.pid}.txt`);

let handle: FileHandle | undefined;
function held(): FileHandle | undefined {
  return handle;
}

const missing = await handle?.close();
console.log("nullish arm:", missing);

handle = await open(scratch, "w");
await handle.writeFile("hello", "utf8");
const closed = await handle?.close();
console.log("present arm:", closed);

handle = undefined;
const cleared = await held()?.close();
console.log("after clear:", cleared);
console.log("contents:", await readFile(scratch, "utf8"));
await rm(scratch, { force: true });
