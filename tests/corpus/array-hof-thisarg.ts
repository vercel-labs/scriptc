// The callback HOFs take an optional thisArg: the callback runs with `this`
// bound to it, exactly as Node binds it. A call without one keeps the
// ambient receiver. The helper frame carries the thisArg as its own slot, so
// the callback's arguments are untouched.
interface Box {
  tag: string;
}
const box: Box = { tag: "o" };
const other: Box = { tag: "x" };
function sameBox(this: Box, n: number): boolean {
  return this === box;
}
console.log([1, 2].every(sameBox, box), [1, 2].every(sameBox, other), [1, 2].every(sameBox));
console.log([1, 2].some(sameBox, box), [1, 2].some(sameBox, other));
console.log(
  [1, 2].map(function (this: Box, n) { return this === box ? n * 10 : -1; }, box).join(","),
);
console.log([1, 2, 3].filter(function (this: Box, n) { return this === box && n > 1; }, box).join(","));
let seen = "none";
[7].forEach(function (this: Box) { seen = this.tag; }, box);
console.log("forEach", seen);
[7].forEach(function (this: Box, n, i, a) { console.log("args", n, i, a.length); }, box);
console.log([1, 2, 3].find(function (this: Box, n) { return this === box && n === 2; }, box));
console.log([1, 2, 3].findIndex(function (this: Box, n) { return this === box && n === 3; }, box));
console.log([1, 2, 3].findLast(function (this: Box, n) { return this === box && n < 3; }, box));
console.log([1, 2, 3].findLastIndex(function (this: Box, n) { return this === box && n === 1; }, box));
console.log([1, 2].flatMap(function (this: Box, n) { return this === box ? [n, n] : []; }, box).join(","));
console.log([1, 2].flatMap(function (this: Box, n) { return this === box ? [n] : []; }, other).join(","));
// A thisArg of undefined or null reaches a strict callback as itself.
console.log([1].every(function (this: unknown) { return this === undefined; }, undefined));
console.log([1].every(function (this: unknown) { return this === null; }, null));
// An arrow keeps its lexical `this`; the thisArg never reaches it.
console.log([1].map(function (this: Box) { return (() => this === box)(); }, box)[0]);
// The borrowed form routes through the checked-dynamic array dispatch.
const like = { 0: "a", 1: "b", length: 2 };
const borrowed = Array.prototype.map.call(like, function (this: Box, v: string) {
  return this === box ? v + "!" : v;
}, box);
console.log(borrowed.join(","), borrowed.length);
