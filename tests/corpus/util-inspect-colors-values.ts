// util.inspect with colors: every primitive keeps its own style, an
// accessor's label is styled without the space and closing bracket around
// its value, an invoked getter styles the label alone, a function's tag
// takes color only when nothing follows it, a RegExp's base is red only on
// its early return, and an inherited property is wrapped in the literal
// faint codes outside the palette. The option reaches the same walk through
// formatWithOptions' %o.
import * as util from "node:util";

const show = (label: string, value: any, options?: any): void => {
  console.log(`${label}: ${util.inspect(value, options)}`);
};
const colors = { colors: true };

show("primitives", { n: 1, s: "x", b: true, z: null, u: undefined, big: 10n }, colors);
show("array", [1, "two", [3]], colors);
show("nested", { a: { b: [1] } }, colors);
show("symbol key", { [Symbol("s")]: 1 }, colors);

const accessors: any = { a: 1 };
Object.defineProperty(accessors, "g", { get() { return 2; }, enumerable: true, configurable: true });
Object.defineProperty(accessors, "s2", { set(_v: number) {}, enumerable: true, configurable: true });
Object.defineProperty(accessors, "gs", { get() { return 3; }, set(_v: number) {}, enumerable: true, configurable: true });
Object.defineProperty(accessors, "hid", { get() { return 4; }, enumerable: false, configurable: true });
show("accessors", accessors, colors);
show("accessors hidden", accessors, { colors: true, showHidden: true });
show("getters", accessors, { colors: true, getters: true });

const bare: any = function bare() {};
const withProps: any = function named() {};
withProps.x = 1;
const box: any = { bare, withProps };
show("function", box.bare, colors);
show("function with props", box.withProps, colors);
show("function nested", box, colors);
show("function hidden", box.withProps, { colors: true, showHidden: true });

show("regexp", /a.c/gi, colors);
show("regexp hidden", /a.c/gi, { colors: true, showHidden: true });

const promise: any = Promise.resolve(7);
show("promise", promise, colors);

show("map", new Map<string, number>([["k", 1]]), colors);
show("set", new Set<number>([1, 2]), colors);
show("date", new Date(0), colors);
show("typed array", new Uint8Array([1, 2]), colors);

const inherited: any = Object.create({ x: 1 });
show("inherited", inherited, { colors: true, showHidden: true });
show("inherited value", Object.create({ nested: { y: 2 } }), { colors: true, showHidden: true });

console.log(`formatWithOptions o: ${util.formatWithOptions({ colors: true }, "%o", { a: 1, f: box.withProps })}`);
console.log(`formatWithOptions O: ${util.formatWithOptions({ colors: true }, "%O", { a: [1] })}`);
