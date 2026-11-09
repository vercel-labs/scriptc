// Async iteration and read() over process.stdin received as a Readable,
// with no encoding set: the chunks are Buffers, as Node's stdin yields.
// Where one chunk ends depends on when the input arrives, so the program
// reports the kinds of the pieces and the bytes of all of them together.
import type { Readable } from "node:stream";

let bytes = 0;
let hex = "";

async function drain(stream: Readable): Promise<void> {
  let buffers = true;
  for await (const chunk of stream) {
    buffers &&= Buffer.isBuffer(chunk);
    bytes += (chunk as Buffer).length;
    hex += (chunk as Buffer).toString("hex");
  }
  console.log("iterated, all Buffers:", buffers);
  console.log("read and iterated", bytes, hex);
}
function first(stream: Readable): void {
  stream.once("readable", () => {
    const chunk: unknown = stream.read();
    console.log("read a Buffer:", Buffer.isBuffer(chunk), (chunk as Buffer).length > 0);
    bytes += (chunk as Buffer).length;
    hex += (chunk as Buffer).toString("hex");
    void drain(stream);
  });
}
first(process.stdin);
