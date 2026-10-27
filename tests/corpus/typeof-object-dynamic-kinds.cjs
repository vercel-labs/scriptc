// typeof over every kind of checked-dynamic value.
class Point {
  constructor(x) {
    this.x = x;
  }
}
const values = [
  null,
  undefined,
  0,
  "s",
  true,
  10n,
  Symbol("k"),
  {},
  [],
  new Uint8Array(2),
  Promise.resolve(1),
  new Map(),
  new Point(1),
  Point,
  () => 1,
  function named() {},
  new Proxy({}, {}),
  new Error("e"),
];
for (const value of values) {
  const isObject = typeof value === "object";
  const isFunction = typeof value === "function";
  console.log(typeof value, isObject, isFunction);
}
