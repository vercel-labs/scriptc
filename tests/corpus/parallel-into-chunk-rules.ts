import { parallelFor, parallelInto } from "@scriptc/experimental";

// Parallel loops (@scriptc/experimental): the chunk plan is the Node.js
// implementation's — `count` is the target's length divided by `stride`,
// a chunk covers [start, min(start + grain, count)) and `part` is the
// stride's slice of the target — and the argument checks throw its
// messages before any chunk runs.

const grid = new Float64Array(64);
parallelInto(
  grid,
  (part, start, end) => {
    for (let k = 0; k < part.length; k++) part[k] = (start * 4 + k) / 8;
  },
  { stride: 4, grain: 5 },
);
console.log(grid.join(","));

const counts = new Float64Array(10);
parallelInto(
  counts,
  (part, start, end) => {
    for (let k = 0; k < part.length; k++) part[k] = start * 100 + k;
  },
  { stride: 1, grain: 3 },
);
console.log(counts.join(","));

function attempt(run: () => void): void {
  try {
    run();
    console.log("no error");
  } catch (caught) {
    const error = caught as RangeError;
    console.log(error.name, error.message);
  }
}

const fill = (part: Float64Array, start: number, end: number): void => {
  for (let i = start; i < end; i++) part[i - start] = i;
};
attempt(() => parallelInto(grid, fill, { stride: 0 }));
attempt(() => parallelInto(grid, fill, { stride: 2.5 }));
attempt(() => parallelInto(grid, fill, { stride: 3 }));
attempt(() => parallelInto(grid, fill, { grain: 0 }));
attempt(() => parallelInto(grid, fill, { grain: 1.5 }));
const touch = (start: number, end: number): void => {
  for (let i = start; i < end; i++) Math.sqrt(i);
};
attempt(() => parallelFor(-1, touch));
attempt(() => parallelFor(2.5, touch));
