// Async iteration and read() over process.stdin received as a Readable,
// with no encoding set: the chunks are Buffers, as Node's stdin yields.
import type { Readable } from "node:stream";

async function drain(stream: Readable): Promise<void> {
  let bytes = 0;
  let buffers = true;
  let hex = "";
  for await (const chunk of stream) {
    buffers &&= Buffer.isBuffer(chunk);
    bytes += (chunk as Buffer).length;
    hex += (chunk as Buffer).toString("hex");
  }
  console.log("iterated", bytes, "all Buffers:", buffers, hex);
}
function first(stream: Readable): void {
  stream.once("readable", () => {
    const chunk: unknown = stream.read();
    console.log("read a Buffer:", Buffer.isBuffer(chunk), (chunk as Buffer).toString("base64"));
    void drain(stream);
  });
}
first(process.stdin);
