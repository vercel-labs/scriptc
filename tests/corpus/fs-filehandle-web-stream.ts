// filehandle.readableWebStream() answers the handle's content as Node's
// type: "bytes" web stream: a default reader is handed 16 KiB chunks, a BYOB
// reader fills a view of its own, the stream closes at EOF (closing the
// handle when the caller asked for autoClose), and a handle that is already
// closed throws ERR_INVALID_STATE at the call.
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dir = fs.mkdtempSync(join(tmpdir(), "scr-fh-web-stream-"));
const file = join(dir, "data.bin");
// Non-uniform bytes: a chunk larger than a BYOB view must not lose its tail.
const data = Buffer.alloc(40000);
for (let i = 0; i < data.length; i++) data[i] = i % 251;
fs.writeFileSync(file, data);

// 1. The default reader gets the auto-allocated 16 KiB chunks.
const first = await fs.promises.open(file, "r");
const stream = first.readableWebStream();
const reader = stream.getReader();
const one = await reader.read();
console.log("default", one.done, (one.value as Uint8Array).length);
await reader.cancel();

// 2. A BYOB reader fills the view it hands over, from the handle's current
// position; the following read continues after it.
const second = await fs.promises.open(file, "r");
const byob = second.readableWebStream().getReader({ mode: "byob" });
const head = await byob.read(new Uint8Array(100), {});
const headValue = head.value as Uint8Array;
console.log("byob", head.done, headValue.length, headValue[0], headValue[99]);
const nextValue = (await byob.read(new Uint8Array(10), {})).value as Uint8Array;
console.log("byob next", nextValue.length, nextValue[0], nextValue[9]);
await byob.cancel();

// 3. The stream iterates too, and autoClose closes the handle when it ends.
const third = await fs.promises.open(file, "r");
const chunks: number[] = [];
for await (const chunk of third.readableWebStream({ autoClose: true })) {
  chunks.push((chunk as Uint8Array).length);
}
console.log("iterated", chunks.length, chunks[0], third.fd >= 0);

// 4. A closed handle is Node's ERR_INVALID_STATE at the call.
const fourth = await fs.promises.open(file, "r");
await fourth.close();
try {
  fourth.readableWebStream();
  console.log("closed", "no error");
} catch (err) {
  console.log("closed", (err as Error).name, (err as { code: string }).code, (err as Error).message);
}

// 5. A stream that does not close the handle takes no reference on it: once
// it ends, a close() finishes instead of waiting for a reference no one will
// drop.
const fifth = await fs.promises.open(file, "r");
const plain = fifth.readableWebStream();
for await (const chunk of plain) void chunk;
await fifth.close();
console.log("close after stream", fifth.fd >= 0);

// 6. autoClose closes the handle when the stream ends, once no other stream
// holds its descriptor.
const sixth = await fs.promises.open(file, "r");
const auto = sixth.readableWebStream({ autoClose: true });
for await (const chunk of auto) void chunk;
try {
  await sixth.read();
  console.log("after autoClose", "read");
} catch (err) {
  console.log("after autoClose", (err as Error).name, (err as { code?: string }).code);
}

// 7. One stream per handle, as Node's lock: a second readableWebStream is
// the locked error, and the lock outlives the stream.
const seventh = await fs.promises.open(file, "r");
const lockedStream = seventh.readableWebStream();
try {
  seventh.readableWebStream();
  console.log("second", "opened");
} catch (err) {
  console.log("second", (err as Error).name, (err as { code?: string }).code, (err as Error).message);
}
await lockedStream.cancel();
try {
  seventh.readableWebStream();
  console.log("after cancel", "opened");
} catch (err) {
  console.log("after cancel", (err as Error).name, (err as { code?: string }).code);
}

// 8. autoClose runs close()'s steps: a paused read stream on the same
// handle is closed with it, and the descriptor follows.
const eighth = await fs.promises.open(file, "r");
const paused = eighth.createReadStream({ start: 0, end: 3 });
let pausedClosed = false;
paused.on("close", () => {
  pausedClosed = true;
});
const autoSecond = eighth.readableWebStream({ autoClose: true });
await autoSecond.cancel();
await new Promise((resolve) => setTimeout(resolve, 50));
console.log("paused", pausedClosed, eighth.fd >= 0, paused.destroyed);

fs.rmSync(dir, { recursive: true, force: true });
