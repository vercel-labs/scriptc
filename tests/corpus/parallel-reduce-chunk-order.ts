import { parallelReduce } from "@scriptc/experimental";

// Parallel loops (@scriptc/experimental): parallelReduce folds one value
// per chunk from left to right in chunk order, whatever thread computed a
// chunk, so a combine that is not associative still prints the same number
// as the Node.js loop. The default grain is about 256 chunks over the
// count.

const squares = parallelReduce(
  5000,
  0,
  (start, end) => {
    let sum = 0;
    for (let i = start; i < end; i++) sum += i * i;
    return sum;
  },
  (left, right) => left + right,
  { grain: 128 },
);
console.log(squares);

const folded = parallelReduce(
  64,
  1,
  (start, end) => start * 1000 + end,
  (left, right) => left * 2 + right,
  { grain: 8 },
);
console.log(folded);

// ceil(1000 / 256) = 4: 250 chunks, each one adding its own width.
const widths = parallelReduce(
  1000,
  0,
  (start, end) => (end - start) * 100 + start,
  (left, right) => left + right,
  {},
);
console.log(widths);

// A count smaller than one chunk is one chunk.
const single = parallelReduce(
  3,
  10,
  (start, end) => start * 10 + end,
  (left, right) => left * 2 + right,
  {},
);
console.log(single);
