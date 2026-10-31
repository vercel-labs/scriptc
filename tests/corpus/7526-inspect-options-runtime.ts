// util.inspect with colors, option values and options objects known only
// at run time, and the legacy inspect(value, showHidden, depth, colors)
// form: Node's ANSI styles per value kind, color-aware line breaking and
// grouping, runtime depth and layout options, and colored output from
// util.formatWithOptions.
import * as util from "node:util";

class Point {
  x: number;
  y: number;
  constructor(x: number, y: number) {
    this.x = x;
    this.y = y;
  }
}

const sparse: number[] = [1, 2, 3];
sparse.length = 5;
const values: unknown[] = [
  1,
  -0,
  "text",
  "it's",
  null,
  undefined,
  true,
  10n,
  Symbol("sym"),
  [1, "two", [3, [4, [5]]]],
  { a: 1, "b-c": "d", nested: { deep: { deeper: { deepest: 1 } } } },
  new Map<unknown, unknown>([["k", { v: 1 }]]),
  new Set(["s", 2]),
  new Date(0),
  new Uint8Array([1, 2, 3]),
  Buffer.from("hi"),
  function named() {},
  new Point(1, 2),
  sparse,
  Object.create(null),
  Array.from({ length: 30 }, (_, i) => i * 37),
  "a long string with a newline\nand more text than fits on one line of eighty characters",
];
for (const value of values) {
  console.log(JSON.stringify(util.inspect(value, { colors: true })));
}
const depth = process.argv.length > 99 ? 5 : 1;
const breakLength = process.argv.length > 99 ? 80 : 30;
console.log(util.inspect(values[10], { depth }));
console.log(util.inspect(values[10], { depth: depth - 1, breakLength }));
console.log(util.inspect(values[20], { breakLength, compact: depth }));
console.log(util.inspect({ b: 2, a: 1 }, { sorted: depth > 0 }));
console.log(util.inspect(values[10], { depth: undefined }));
const options: util.InspectOptions = { depth: 0, colors: true };
console.log(JSON.stringify(util.inspect(values[10], options)));
options.colors = false;
console.log(util.inspect(values[10], options));
console.log(util.inspect(values[10], false, 0));
console.log(util.inspect(values[10], false, null, false));
console.log(JSON.stringify(util.inspect(values[11], false, 1, true)));
console.log(util.inspect(values[10], undefined, depth));
console.log(JSON.stringify(util.formatWithOptions({ colors: true }, "%s %O", "x", values[12])));
console.log(JSON.stringify(util.formatWithOptions({ colors: true }, values[10], values[9])));
