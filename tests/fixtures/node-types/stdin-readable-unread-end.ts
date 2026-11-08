// An input that ends without a byte, under a 'readable' listener that never
// reads. A pipe's end is read once more by Node itself, so the stream ends
// at once. A file's end is not: the stream ends at the next read, which
// here is the one resume() makes. The 'readable' event at the end of the
// input starts the report, so nothing depends on elapsed time.
import type { Readable } from "node:stream";

function watch(stream: Readable): void {
  stream.on("end", () => console.log("end"));
  let announced = false;
  process.stdin.on("readable", () => {
    if (announced) return;
    announced = true;
    setTimeout(() => {
      console.log("after 'readable': ended", stream.readableEnded);
      stream.resume();
    }, 0);
  });
}

watch(process.stdin);
process.on("exit", () => console.log("exit"));
