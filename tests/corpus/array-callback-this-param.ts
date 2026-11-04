// A callback's `(value, index, array)` positions count from its first data
// parameter: an explicit `this` parameter (TypeScript declares it first)
// takes no position, so unannotated parameters after it bind the tail the
// helper passes.
interface Box {
  tag: string;
}
const box: Box = { tag: "o" };
[7, 8].forEach(function (this: Box, n, i, a) {
  console.log("args", this === undefined, n, i, a.length);
});
[7, 8].map(function (this: Box, n, i) {
  return i * 10 + n;
}).forEach((v) => console.log("mapped", v));
console.log([7, 8, 9].findIndex(function (this: Box, n, i, a) { return i === 1 && a.length === 3; }));
let count = 0;
[7].forEach(function (this: Box) { count++; });
console.log("count", count);
