// process.stdin with a 'data' listener of its own, paused, then handed on
// as a Readable that is read four bytes at a time under 'readable'. A
// paused stream emits no 'data' by itself, but every read() hands its
// chunk to the 'data' listeners, so the listener registered on
// process.stdin sees every byte the reads take.
import type { Readable } from "node:stream";

function drain(stream: Readable): void {
  let bytes = 0;
  let pieces = 0;
  stream.on("readable", () => {
    let chunk: unknown;
    while ((chunk = stream.read(4)) !== null) {
      pieces++;
      bytes += (chunk as Buffer).length;
    }
  });
  stream.on("end", () => console.log("read(4)", bytes, pieces, stream.isPaused(), process.stdin.isPaused()));
}

let own = 0;
process.stdin.on("data", (chunk: Buffer) => {
  own += chunk.length;
});
process.stdin.pause();
process.on("exit", () => console.log("own data", own));
drain(process.stdin);
