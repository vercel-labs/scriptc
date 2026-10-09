// `i in arr` with a RUNTIME numeric key over a typed array answers with the
// array's own slot/property presence query (holes, length, ordinary numeric
// properties) instead of materializing the array per probe. The large loop
// at the end used to be quadratic.
const dense: number[] = [10, 20, 30];
const probes: number[] = [0, 1, 2, 3, -1, 1.5, NaN, Infinity, -Infinity, -0, 4294967294, 4294967295];
console.log(probes.map((k) => k in dense).join(","));

// Holes from `new Array(n)` and from writes past the end.
const holes = new Array<number>(6);
holes[1] = 1;
holes[4] = 4;
const present: number[] = [];
for (let i = -1; i < 8; i++) if (i in holes) present.push(i);
console.log(present.join(","), holes.length);

// Length truncation and pop remove presence; fill restores it.
const shrink: number[] = [1, 2, 3, 4, 5];
shrink.length = 2;
shrink.pop();
let alive = 0;
for (let i = 0; i < 5; i++) if (i in shrink) alive++;
console.log(alive, shrink.length);
shrink.length = 4;
console.log([0, 1, 2, 3].map((i) => i in shrink).join(","));
shrink.fill(9);
console.log([0, 1, 2, 3].map((i) => i in shrink).join(","));

// Ordinary (noncanonical) numeric property keys live beside the slots.
const withProps: number[] = [1, 2];
withProps[-1] = 5;
withProps[1.5] = 6;
console.log(-1 in withProps, 1.5 in withProps, -2 in withProps, 2.5 in withProps, withProps.length);

// String and object element arrays share the same query.
const names: string[] = ["a", "b"];
const objs: { v: number }[] = [{ v: 1 }];
let idx = 1;
console.log(idx in names, idx in objs, !(idx in objs));

// A key read from another array (number after the non-null assertion).
const keys: number[] = [0, 5, 2];
console.log(keys.map((_, j) => keys[j]! in dense).join(","));

// Sparse indices past the dense cutoff.
const sparse: number[] = [];
sparse[3000000] = 1;
sparse[5] = 2;
console.log(5 in sparse, 6 in sparse, 3000000 in sparse, 2999999 in sparse, sparse.length);

// JS evaluates the key before the receiver, and both exactly once.
const trace: string[] = [];
function key(k: number): number {
  trace.push("key");
  return k;
}
function recv(): number[] {
  trace.push("recv");
  return dense;
}
console.log(key(1) in recv(), key(7) in recv(), trace.join(","));

// Reassigning the receiver inside the key expression: the receiver is read
// after the key ran.
let swap: number[] = [1];
let j = 0;
console.log((swap = [1, 2, 3], j = 2, j) in swap);

// Large loop: linear in the array size.
const big: number[] = [];
for (let i = 0; i < 300000; i++) if (i % 3 !== 0) big[i] = i;
let count = 0;
for (let i = 0; i < 600000; i++) if (i in big) count++;
console.log(count, big.length);
