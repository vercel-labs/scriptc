// 'data' listeners on process.stdin and on the Readable it is handed on as,
// with the input paused before the hand-on. Neither listener receives
// anything while the one stream is paused, and isPaused() answers true
// through both names; resume() through the other name starts both.
import type { Readable } from "node:stream";

let own = 0;
let handed = 0;

function listen(stream: Readable): void {
  stream.on("data", (chunk: Buffer) => {
    handed += chunk.length;
  });
  stream.on("end", () => console.log("ended", own, handed));
  setTimeout(() => {
    console.log("paused", own, handed, stream.isPaused(), process.stdin.isPaused());
    process.stdin.resume();
    console.log("resumed", stream.isPaused(), stream.readableFlowing, process.stdin.isPaused());
  }, 150);
}

process.stdin.on("data", (chunk: Buffer) => {
  own += chunk.length;
});
process.stdin.pause();
listen(process.stdin);
