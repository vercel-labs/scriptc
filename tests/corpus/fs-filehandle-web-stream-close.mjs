// FileHandle.close() with an autoClose readableWebStream open: Node closes the
// descriptor even though the stream still holds a reference, the stream then
// answers EOF, and a second close() is a no-op that resolves.
import { open, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = await mkdtemp(join(tmpdir(), "fh-"));
const path = join(dir, "f.txt");
await writeFile(path, "hello world");

const handle = await open(path, "r");
const stream = handle.readableWebStream({ autoClose: true });
const reader = stream.getReader();
const first = await reader.read();
console.log("first", first.value.length);
await handle.close();
const second = await reader.read();
console.log("second", second.done);
const closed = await Promise.race([
  handle.close().then(() => "closed"),
  new Promise((resolve) => setTimeout(() => resolve("pending"), 400)),
]);
console.log("close", closed);
