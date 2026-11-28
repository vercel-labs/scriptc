// A web ReadableStream source is still read through its adapter when a
// later pipeline argument is untyped.
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";

const web = new ReadableStream({
  start(controller) {
    controller.enqueue("a");
    controller.enqueue("b");
    controller.close();
  },
});

const out = [];
const sink = new Writable({
  write(chunk, _enc, cb) {
    out.push(String(chunk));
    cb();
  },
});

function run(sinkArg) {
  return pipeline(web, sinkArg);
}

await run(sink);
console.log(`out ${out.join(",")}`);
