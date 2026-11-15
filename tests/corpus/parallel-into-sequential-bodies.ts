import { parallelInto } from "@scriptc/experimental";

// Parallel loops (@scriptc/experimental): a body the compiler cannot show
// safe runs its chunks one after another on the calling thread, in order,
// which is what Node.js does. The build reports SC6106 for each of them,
// and the output is the same either way.

const out = new Float64Array(40);
let calls = 0;
parallelInto(
  out,
  (part, start, end) => {
    calls += 1;
    console.log("chunk", start, end);
    for (let i = start; i < end; i++) part[i - start] = i;
  },
  { grain: 8 },
);
console.log(calls, out[39]);

// A body that reads a typed array which aliases the target: a chunk's write
// could race another chunk's read, so the chunks run one after another.
const a = new Float64Array(64);
const alias = a;
for (let i = 0; i < a.length; i++) a[i] = i;
parallelInto(
  a,
  (part, start, end) => {
    for (let i = start; i < end; i++) part[i - start] = alias[(i + 1) % 64]! + 1000;
  },
  { grain: 4 },
);
console.log(a[0], a[63]);

// A body that allocates stays in order too.
parallelInto(
  out,
  (part, start, end) => {
    const box: number[] = [];
    box.push(start);
    for (let i = start; i < end; i++) part[i - start] = box.length + i;
  },
  { grain: 16 },
);
console.log(out[0], out[39]);
