// A source expression followed by a statically known plain stage runs once,
// and the stage receives the source value.
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";

const evals = [];
const seen = [];
function stage(src) {
  seen.push(Array.isArray(src) ? "array" : typeof src);
  return (async function* () {
    for await (const chunk of src) yield chunk;
  })();
}

const out = [];
const sink = new Writable({
  write(chunk, _enc, cb) {
    out.push(String(chunk));
    cb();
  },
});

await pipeline((evals.push("source"), ["a", "b"]), stage, sink);
console.log(`evals ${evals.length} seen ${seen.join(",")} out ${out.join(",")}`);
