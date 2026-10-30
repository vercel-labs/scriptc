// util.format, util.formatWithOptions and console output with format
// strings known only at run time, spread arguments and options objects:
// every substitution, the argument cursor, %% and %c, missing and extra
// arguments, the space-joined form of strings without a '%', and Node's
// inspectOptions validation.
import * as util from "node:util";

class Point {
  x: number;
  y: number;
  constructor(x: number, y: number) {
    this.x = x;
    this.y = y;
  }
}

interface Row {
  id: number;
  tags: string[];
  nested: { deep: { deeper: { deepest: number } } };
}

const formats: string[] = [
  "%s and %s",
  "%d|%i|%f",
  "%j",
  "%O / %o",
  "100%% of %s",
  "%c%s%c",
  "no specifiers",
  "trailing %",
  "%x %s",
  "%s",
];
const row: Row = { id: 7, tags: ["a", "b"], nested: { deep: { deeper: { deepest: 1 } } } };

for (const format of formats) {
  console.log(util.format(format, "first", 42, row));
  console.log(util.format(format, 3.5, "12.75"));
  console.log(util.format(format));
}

function pick(i: number): string {
  return ["%s=%d", "%j", "%O", "plain"][i % 4]!;
}
for (let i = 0; i < 4; i++) {
  console.log(util.format(pick(i), new Point(1, 2), -0, [1, 2, 3]));
  console.log(pick(i), new Map([["k", new Point(3, 4)]]), new Set([1n, 2n]));
  console.error(pick(i), "to stderr", null, undefined);
}

const label: string = process.argv.length > 99 ? "" : "count: %d of %s";
console.log(label, 5, "five", "extra");
console.log(util.format(label, 10n, Symbol("sym")));
console.log(util.format(label, new Point(0, 0), [new Point(5, 6)]));
console.log(util.format(pick(0), { toString: "not a function" }, true));

// Arguments that are all strings, numbers, booleans, null or undefined.
const prim: string = process.argv.length > 99 ? "" : "%s|%d|%i|%f|%j|%O|%o|%c|%%";
console.log(prim, -0, "12.5", -0, true, 'q"uote', "s", 3, "css", "rest", null, undefined);
console.log(prim, NaN, null, undefined, "0x10", Infinity, NaN, false);
console.log(util.format(prim, "a\nb", " 7 ", "-3.9e2", "", -Infinity, 'it\'s', 1e21));
console.log(util.format(label, 2.5));

// A union first argument formats only when it holds a string.
const maybe: string | number = process.argv.length > 99 ? 1 : "%s/%s";
const notString: string | number = process.argv.length > 99 ? "%s" : 9;
console.log(util.format(maybe, "u", "v"));
console.log(util.format(notString, "u", "v"));
console.log(maybe, "w", "x");

// An unknown first argument.
const loose: unknown = process.argv.length > 99 ? 0 : "%s-%i";
console.log(util.format(loose, "a", "7.9"));
console.log(loose, "b", 3.2);

// Spread arguments.
const values: unknown[] = ["%s + %s = %d", 1, 2, 3, "tail"];
console.log(util.format(...values));
console.log(util.format("%s|%s", ...values));
console.log(...values);
console.log("prefix", ...new Set(["x", "y"]), "suffix");
console.error(...[1, "two", [3]]);
console.log(util.format(...([] as string[])));

// formatWithOptions with an options object.
const deep = { a: { b: { c: { d: { e: 1 } } } } };
const depth = process.argv.length > 99 ? 1 : 0;
console.log(util.formatWithOptions({ depth }, "%O", deep));
console.log(util.formatWithOptions({ depth: null }, deep));
console.log(util.formatWithOptions({ depth: undefined }, "x", deep));
console.log(util.formatWithOptions({ depth: 0 }, "%s|%O", deep, deep));
console.log(util.formatWithOptions({ compact: false }, "%s", "v", { a: 1, b: [1, 2] }));
console.log(util.formatWithOptions({ breakLength: 20 }, { alpha: 1, beta: 2, gamma: 3 }));
console.log(util.formatWithOptions({ sorted: true }, "%O", { b: 1, a: 2, c: { z: 1, y: 2 } }));
console.log(util.formatWithOptions({ colors: true }, "%s %d %O", "s", 2, 3), "|");
console.log(util.formatWithOptions({ colors: true }, 1, "plain", null, undefined, true, 4n));
const options: util.InspectOptions = { depth: 1, compact: 1 };
console.log(util.formatWithOptions(options, "%O", deep));
console.log(util.formatWithOptions(options, ...values));
console.log(util.formatWithOptions([] as unknown as util.InspectOptions, "%s", 1));
const invalid: unknown[] = [null, 1, "x", undefined, () => {}];
for (const bad of invalid) {
  try {
    util.formatWithOptions(bad as util.InspectOptions, "a");
  } catch (error) {
    const e = error as NodeJS.ErrnoException;
    console.log(e.name, e.code, e.message);
  }
}
