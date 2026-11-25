import { parallelInto, parallelReduce } from "@scriptc/experimental";

// Parallel loops (@scriptc/experimental) in a program that reads stack
// traces: the bodies run their chunks on the calling thread, and the stack
// a later Error captures names only the frames that are still running.

const table = new Float64Array(64);
for (let i = 0; i < table.length; i++) table[i] = i;
const out = new Float64Array(1 << 16);
parallelInto(
  out,
  (part, start, end) => {
    for (let i = start; i < end; i++) part[i - start] = table[i % 64]! + Math.sqrt(i);
  },
  { grain: 1024 },
);
const total = parallelReduce(
  out.length,
  0,
  (start, end) => {
    let s = 0;
    for (let i = start; i < end; i++) s += out[i]!;
    return s;
  },
  (a, b) => a + b,
  { grain: 2048 },
);
console.log(out[0], out[out.length - 1]!.toFixed(3), total.toFixed(3));

function where(): string {
  const lines = String(new Error("probe").stack).split("\n");
  return lines[0] + " / " + lines.length;
}
function outer(): string {
  return where();
}
console.log(outer().split(" / ")[0]);
