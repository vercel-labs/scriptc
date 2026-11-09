// process.stdin paused before it is handed on as a Readable, then read by
// async iteration. Pausing leaves flowing mode; it does not stop a reader
// that pulls, so the iteration gets the whole input, and both names answer
// the one paused state.
import type { Readable } from "node:stream";

async function total(stream: Readable): Promise<void> {
  console.log("handed on", stream.isPaused(), stream.readableFlowing, process.stdin.isPaused());
  let bytes = 0;
  let buffers = true;
  for await (const chunk of stream) {
    buffers &&= Buffer.isBuffer(chunk);
    bytes += (chunk as Buffer).length;
  }
  console.log("iterated", bytes, "all Buffers:", buffers);
  console.log("after", stream.isPaused(), process.stdin.isPaused());
}

process.stdin.pause();
void total(process.stdin);
