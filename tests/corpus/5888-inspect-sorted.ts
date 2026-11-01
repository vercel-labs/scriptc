// util.inspect and console.dir with sorted: true order the entries of
// objects, class instances, Maps and Sets by their rendered text, in
// UTF-16 code-unit order (quoted keys sort by their quote, the "... more
// items" tail sorts with the rest), at every nesting level. An array or
// typed array keeps its elements in place and sorts its own-property
// entries after them, the hidden `[length]` and symbol keys included, and
// only when it has at least two. sorted: false is the default.
import { inspect } from "node:util";

const record = {
  zeta: 1,
  alpha: { c: 3, b: 2, a: 1 },
  "quoted-key": true,
  Beta: [3, 1, 2],
  _under: null,
  10: "ten",
  2: "two",
};
console.log(inspect(record, { sorted: true }));
console.log(inspect(record, { sorted: false }));
console.log(inspect(new Map<string, unknown>([["b", 1], ["a", 2], ["c", { z: 1, y: 2 }]]), { sorted: true }));
console.log(inspect(new Set(["pear", "apple", "fig"]), { sorted: true }));
console.log(inspect({ é: 1, e: 2, "😀": 3, "￿": 4 }, { sorted: true }));
console.log(inspect([{ b: 1, a: 2 }, { d: 1, c: 2 }], { sorted: true, compact: false }));

class Point {
  y = 1;
  x = 2;
}
console.log(inspect(new Point(), { sorted: true }), inspect([3, 1, 2], { sorted: true }));
const many = new Set(Array.from({ length: 105 }, (_, i) => `k${i}`));
console.log(inspect(many, { sorted: true, breakLength: Infinity }));
const parsed: unknown = JSON.parse('{"b":1,"a":{"d":1,"c":2}}');
console.log(inspect(parsed, { sorted: true }));
console.dir({ b: 1, a: 2 }, { sorted: true });
console.log(record);

// An array's own properties sort after its elements, and only when there
// are at least two of them.
const list: unknown = JSON.parse('[1, 2]');
const listProps = list as Record<string, unknown>;
listProps.zeta = "z";
listProps.alpha = "a";
console.log(inspect(list, { sorted: true }));
console.log(inspect(list));
const hidden: unknown = JSON.parse('[1]');
Object.defineProperty(hidden as object, "note", { value: "n", enumerable: false });
Object.defineProperty(hidden as object, Symbol("t"), { value: 6, enumerable: true });
console.log(inspect(hidden, { showHidden: true, sorted: true }));
console.log(inspect(hidden, { showHidden: true }));
const typed = new Uint8Array([1, 2]);
const typedProps = typed as unknown as Record<string, unknown>;
typedProps.zeta = "z";
typedProps.alpha = "a";
console.log(inspect(typed, { sorted: true }));
console.log(inspect(typed));
