// util._extend and util.isArray at their documented edges: _extend copies
// the source's own enumerable string keys in reverse order (inherited
// enumerable keys and symbol keys stay behind), answers the target itself,
// and a null or primitive target throws as the assignment would; isArray
// answers by the runtime value for arrays against every other value kind.
// The deprecated helpers' warnings are off, so only behavior differs here.
import * as util from "node:util";

process.noDeprecation = true;

// Reverse key order: Object.keys(source) read backwards.
const keys = util._extend({} as Record<string, number>, { a: 1, b: 2, c: 3 });
console.log("order", JSON.stringify(Object.keys(keys)), JSON.stringify(keys));

// Own enumerable string keys only: inherited keys and symbol keys do not cross.
const inherited = Object.create({ inh: 1 }) as Record<string | symbol, unknown>;
inherited.own = 2;
inherited[Symbol("sym")] = 3;
const copied = util._extend({} as Record<string, unknown>, inherited);
console.log("own only", JSON.stringify(Object.keys(copied)), JSON.stringify(copied));

// The target itself comes back, later sources overwrite earlier writes.
const target: Record<string, unknown> = { keep: 1 };
const same = util._extend(target, { x: 2 });
console.log("identity", same === target, JSON.stringify(same));
console.log("null source", JSON.stringify(util._extend({ keep: 1 }, null)));
console.log("undefined source", JSON.stringify(util._extend({ keep: 2 }, undefined)));

// A target that cannot take a property throws the assignment's TypeError.
try {
  util._extend(null as unknown as Record<string, unknown>, { a: 1 });
} catch (e: any) {
  console.log("null target", e.name, e.message);
}
try {
  util._extend(3 as unknown as Record<string, unknown>, { a: 1 });
} catch (e: any) {
  console.log("number target", e.name, e.message);
}

// isArray over the value kinds that are and are not arrays.
const fn = (): void => {};
const values: unknown[] = [[], [1, 2], {}, "x", 5, null, undefined, new Map(), fn, new Uint8Array(1)];
console.log("isArray", values.map((v) => util.isArray(v)).join(" "));
const unknownValue: unknown = [1];
console.log("isArray narrows", util.isArray(unknownValue), util.isArray(unknownValue) ? unknownValue.length : -1);
