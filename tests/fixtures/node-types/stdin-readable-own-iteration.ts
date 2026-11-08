// for await over process.stdin in a program that also hands process.stdin
// on as a Readable. In Node both read the one stream. The compiled
// iteration is refused by name at its first step: iterate the Readable.
import type { Readable } from "node:stream";

function listen(stream: Readable): void {
  stream.on("data", () => {});
}

void (async () => {
  let bytes = 0;
  for await (const chunk of process.stdin) bytes += chunk.length;
  console.log("iterated", bytes);
})();
listen(process.stdin);
