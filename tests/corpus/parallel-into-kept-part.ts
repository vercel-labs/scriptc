import { parallelInto } from "@scriptc/experimental";

// Parallel loops (@scriptc/experimental): a body the compiler cannot show
// safe runs its chunks one after another on the calling thread, and what it
// does with `part` is ordinary JavaScript. Here the body keeps its `part`,
// as a Node.js body keeps the subarray it is given: the view outlives the
// call, keeps reading the target's elements, and is the last chunk's.

class Kept {
  view: Float64Array | null = null;
}

const kept = new Kept();
const target = new Float64Array(8);
for (let i = 0; i < target.length; i++) target[i] = i * 10;
parallelInto(
  target,
  (part, start, end) => {
    kept.view = part;
    for (let i = start; i < end; i++) part[i - start] = i * 2;
  },
  { grain: 4 },
);

const view = kept.view;
if (view === null) console.log("no view");
else console.log("kept", view.length, view[0], view[3]);
console.log("target", target[0], target[4], target[7]);

// The kept view aliases the target: a later write through it is visible in
// the target, exactly as Node's subarray would be.
if (view !== null) view[0] = 99;
console.log("after", target[4], target[7]);
