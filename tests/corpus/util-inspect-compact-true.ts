// util.inspect compact: true — Node's legacy layout: one line when it fits,
// otherwise the opening brace shares the first entry's line and the closing
// brace the last one; circular references sit on the opening brace; object
// properties indent their values one level further and move a value wider
// than breakLength to its own line; long strings are not split.
import { inspect } from "node:util";

const custom = inspect.custom;

const nested = { a: { b: 1 }, c: [1, 2, 3], d: { e: { f: { g: 1 } } } };
console.log(inspect(nested, { compact: true, breakLength: 20 }));
console.log(inspect({ a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 }, { compact: true, breakLength: 10 }));
console.log(inspect({ a: { b: { c: { d: 1 } } } }, { compact: true, depth: 2, breakLength: 30 }));
const circular: any = { x: 1 };
circular.self = circular;
console.log(inspect(circular, { compact: true }));
class Point { x = 1; y = { z: [1, 2] }; }
console.log(inspect(new Point(), { compact: true, breakLength: 20 }));
console.log(inspect("a".repeat(40), { compact: true, breakLength: 20 }));
console.log(inspect([1, 2, 3, 4, 5, 6, 7, 8], { compact: true, breakLength: 10 }));
console.log(inspect(new Map([["k", { a: 1 }]]), { compact: true }));
console.log(inspect(new Set([{ a: 1 }, { b: 2 }]), { compact: true, breakLength: 15 }));
console.log(inspect({ long: `${"x".repeat(30)} y` }, { compact: true, breakLength: 20 }));
console.log(inspect({ a: 1 }, { compact: true }));
console.log(inspect({ a: 1 }, { compact: false }));
console.log(inspect({ a: 1 }, { compact: 3 }));
console.log(inspect({ a: [1, 2], b: { c: 3 } }, { compact: true, breakLength: 30 }));
const parsed = JSON.parse('{"obj":{"a":1},"list":[1,2,3]}');
console.log(inspect(parsed, { compact: true, breakLength: 15 }));
console.log(inspect({ wide: "日本語日本語" }, { compact: true, breakLength: 12 }));
const colorOptions: any = { compact: true, colors: true, breakLength: 8 };
console.log(JSON.stringify(inspect({ s: "abcdef" }, colorOptions)));
const symbol = Symbol("tag");
const withSymbol: any = { a: 1 };
withSymbol[symbol] = { nested: 12345 };
console.log(inspect(withSymbol, { compact: true, breakLength: 12 }));
class CompactView {
  [custom](_depth: number, options: { compact?: boolean }): string {
    return `compact=${String(options.compact)}`;
  }
}
console.log(inspect(new CompactView(), { compact: true }));
const dynamicOptions: any = { compact: true, breakLength: 20 };
console.log(inspect({ a: { b: 1 }, c: 2 }, dynamicOptions));
console.log(inspect({ a: { b: 1 }, c: 2 }, { breakLength: 20 }));
