// util.format and util.formatWithOptions over every placeholder (%s, %d,
// %i, %f, %j, %o, %O, %c, %%), with extra arguments, BigInt, symbols,
// boxed-free primitives, arrays, Map/Set, Date, RegExp, getters and the
// options that change the rendering (depth, sorted, maxArrayLength,
// maxStringLength, breakLength, compact, getters, showHidden,
// numericSeparator); util.isDeepStrictEqual across primitives, records,
// arrays with holes, Dates, RegExps, Maps with object keys, Sets, typed
// arrays, BigInts, Errors, symbol keys, cycles and the boolean third
// argument; util.promisify (callback result, rejection, arity, the
// sync-throwing and no-callback forms); util.callbackify of async
// functions (resolve and reject); and util.inspect.custom declared in an
// object literal and as a class method.
import * as util from "node:util";

function shape(fn: () => unknown): string {
  try {
    return "ok " + JSON.stringify(fn());
  } catch (e) {
    const err = e as Error & { code?: string };
    return "ERR " + err.name + " " + String(err.code) + " " + err.message;
  }
}

const symbol = Symbol("s");
console.log("format placeholders", shape(() => util.format("%s|%d|%i|%f|%j|%o|%O|%c|%%", "s", 1, 1.9, 1.9, { a: 1 }, { a: 1 }, { a: 1 }, "css")));
console.log("format bigint", shape(() => [util.format("%s", 1n), util.format("%d", 1n), util.format("%i", 1n), util.format("%j", 1n)]));
console.log("format symbol", shape(() => [util.format("%s", symbol), util.format("%j", symbol)]));
console.log("format units", shape(() => [util.format("%s", undefined), util.format("%s", null), util.format("%d", undefined), util.format("%i", null)]));
console.log("format conversions", shape(() => [util.format("%d", "42"), util.format("%d", "x"), util.format("%i", 3.9), util.format("%f", "3.5"), util.format("%d", -0)]));
console.log("format json", shape(() => [util.format("%j", undefined), util.format("%j", "x"), util.format("%j", { a: [1, null], b: true })]));
console.log("format values", shape(() => [util.format("%s", [1, [2]]), util.format("%o", new Map([[1, 2]])), util.format("%s", new Date(0)), util.format("%s", /re/g)]));
console.log("format widths", shape(() => [util.format("%5s", "a"), util.format("%.2s", "abc"), util.format("a", "b", "c"), util.format()]));
console.log("format extra", shape(() => util.format("%s", "a", { b: 1 }, [2])));
console.log("format getters", shape(() => util.format("%o", { get g() { return 1; } })));
console.log("format nested", shape(() => util.format("%o", { a: { b: { c: { d: 1 } } } })));
console.log("format many", shape(() => util.format("%s%s%s%s", 1, 2, 3, 4)));
console.log("format percent", shape(() => [util.format("100%"), util.format("%", 1), util.format("%x", 255)]));

const options: [string, util.InspectOptions, unknown][] = [
  ["depth", { depth: 0 }, { a: { b: 1 } }],
  ["sorted", { sorted: true }, { b: 1, a: 2 }],
  ["maxArrayLength", { maxArrayLength: 2 }, [1, 2, 3]],
  ["maxStringLength", { maxStringLength: 3 }, "abcdef"],
  ["breakLength", { breakLength: 10 }, { aa: 1, bb: 2 }],
  ["compact", { compact: 3 }, { a: 1, b: 2 }],
  ["getters", { getters: true }, { get g() { return 2; } }],
  ["showHidden", { showHidden: true }, Object.defineProperty({}, "h", { value: 1 })],
  ["numericSeparator", { numericSeparator: true }, 1234567],
];
for (const [name, inspectOptions, value] of options) {
  console.log("formatWithOptions", name, shape(() => util.formatWithOptions(inspectOptions, "%o", value)));
}
console.log("formatWithOptions plain", shape(() => util.formatWithOptions({}, "%s|%d", "x", 2)));
console.log("formatWithOptions null", shape(() => util.formatWithOptions(null as unknown as util.InspectOptions, "%s", "x")));

console.log("deep equal primitives", shape(() => [util.isDeepStrictEqual(1, 1), util.isDeepStrictEqual(1, "1"), util.isDeepStrictEqual(NaN, NaN), util.isDeepStrictEqual(0, -0), util.isDeepStrictEqual(null, undefined), util.isDeepStrictEqual({}, [])]));
console.log("deep equal records", shape(() => [util.isDeepStrictEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] }), util.isDeepStrictEqual({ a: 1 }, { a: 1, b: undefined }), util.isDeepStrictEqual([1, , 3], [1, undefined, 3])]));
console.log("deep equal prototypes", shape(() => [util.isDeepStrictEqual(Object.create(null), {}), util.isDeepStrictEqual(Object.create(null), {}, true), util.isDeepStrictEqual({ a: 1 }, { a: 1 }, false)]));
console.log("deep equal kinds", shape(() => [util.isDeepStrictEqual(new Date(0), new Date(0)), util.isDeepStrictEqual(new Date(0), new Date(1)), util.isDeepStrictEqual(/a/g, /a/g), util.isDeepStrictEqual(/a/g, /a/i)]));
console.log("deep equal containers", shape(() => [util.isDeepStrictEqual(new Map([[{ k: 1 }, "v"]]), new Map([[{ k: 1 }, "v"]])), util.isDeepStrictEqual(new Set([1, 2]), new Set([2, 1])), util.isDeepStrictEqual(Buffer.from("a"), new Uint8Array([97])), util.isDeepStrictEqual(new Float64Array([NaN]), new Float64Array([NaN]))]));
console.log("deep equal misc", shape(() => [util.isDeepStrictEqual(1n, 1n), util.isDeepStrictEqual(1n, 1), util.isDeepStrictEqual(new Error("x"), new Error("x"))]));
console.log("deep equal symbol key", shape(() => util.isDeepStrictEqual({ [symbol]: 1 }, { [symbol]: 1 })));
console.log("deep equal getters", shape(() => util.isDeepStrictEqual(Object.defineProperty({}, "a", { get: () => 1, enumerable: true }), { a: 1 })));
const cyclicA: { x: number; self?: unknown } = { x: 1 };
cyclicA.self = cyclicA;
const cyclicB: { x: number; self?: unknown } = { x: 1 };
cyclicB.self = cyclicB;
console.log("deep equal cycle", shape(() => util.isDeepStrictEqual(cyclicA, cyclicB)));

const add = (a: number, b: number, callback: (error: Error | null, result?: number) => void): void => { callback(null, a + b); };
const reject = (callback: (error: Error | null) => void): void => { callback(new Error("rejected")); };
util.promisify(add)(1, 2).then((result: number | undefined) => console.log("promisify result", result));
util.promisify(reject)().then((result: unknown) => console.log("promisify resolved", result), (error: Error) => console.log("promisify rejected", error.message));
console.log("promisify arity", shape(() => util.promisify(add).length));

util.callbackify(async (x: number) => x * 2)(5, (error: Error | null, result?: number) => console.log("callbackify", error, result));
util.callbackify(async () => { throw new Error("async reject"); })((error: Error | null) => console.log("callbackify reject", error instanceof Error, error && error.message));

console.log("inspect custom literal", shape(() => util.inspect({ [util.inspect.custom]: () => "CUSTOM" })));
console.log("inspect custom depth", shape(() => util.inspect({ a: { [util.inspect.custom]: (depth: number) => "d" + depth } }, { depth: 3 })));
class Custom {
  [util.inspect.custom](): string {
    return "CUSTOM-CLASS";
  }
}
console.log("inspect custom class", shape(() => util.inspect(new Custom())));
console.log("inspect custom symbol", shape(() => util.inspect.custom === Symbol.for("nodejs.util.inspect.custom")));
