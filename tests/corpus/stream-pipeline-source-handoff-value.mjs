// A plain stage after an iterable source receives the source value itself,
// and the source expression runs once.
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

function run(stageArg, sinkArg) {
  return pipeline((evals.push("source"), ["a", "b"]), stageArg, sinkArg);
}

await run(stage, sink);
console.log(`evals ${evals.length} seen ${seen.join(",")} out ${out.join(",")}`);
