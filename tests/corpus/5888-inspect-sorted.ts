// util.inspect and console.dir with sorted: true order the entries of
// objects, class instances, Maps and Sets by their rendered text, in
// UTF-16 code-unit order (quoted keys sort by their quote, the "... more
// items" tail sorts with the rest), at every nesting level. Arrays keep
// their element order. sorted: false is the default.
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
