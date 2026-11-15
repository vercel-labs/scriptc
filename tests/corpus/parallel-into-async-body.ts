import { parallelInto, parallelReduce } from "@scriptc/experimental";

// Parallel loops (@scriptc/experimental) with an async body: the call does
// not await the promise the body returns, so each chunk's synchronous part
// runs in order on the calling thread, as in Node, and the rest runs after
// the call returns.

const out = new Float64Array(4096);
const order: number[] = [];
parallelInto(
  out,
  async (part, start, end) => {
    for (let i = start; i < end; i++) part[i - start] = i * 2;
    if (start % 1024 === 0) order.push(start);
  },
  { grain: 256 },
);
console.log(out[0], out[4095], order.join(","));

const sum = parallelReduce(
  4096,
  0,
  (start, end) => {
    let s = 0;
    for (let i = start; i < end; i++) s += out[i]!;
    return s;
  },
  (a, b) => a + b,
  { grain: 512 },
);
console.log(sum);
