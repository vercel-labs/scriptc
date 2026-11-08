// @requires-libnode
// A native writer drives an island Writable with back-pressure (write
// callbacks on the island's immediates), and reads an island Readable by
// events and by async iteration.
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");
const stream = requireModule("node:stream");
const log = (s) => console.log(s);

async function main() {
  const done = lib.end();
  const sink = lib.sink;
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => sink.write(`chunk${i}`, r));
    log(`wrote ${i}`);
  }
  sink.end("last");
  log(`sink got ${await done}`);

  const readable = stream.Readable.from(["a", "b", "c"]);
  await new Promise((resolve) => {
    readable.on("data", (c) => log(`data ${c}`));
    readable.on("end", () => {
      log("end");
      resolve(undefined);
    });
  });
  lib.onFinish(() => log("stdout write callback"));
}

main();
