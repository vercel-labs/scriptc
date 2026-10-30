// util.isArray and util._extend over typed values: isArray answers by the
// runtime value, and _extend writes into the typed target and answers the
// target itself.
import * as util from "node:util";

process.noDeprecation = true;
const nums: number[] = [1, 2];
const text: string = "x";
const anything: unknown = [3];
console.log(util.isArray(nums), util.isArray(text), util.isArray(new Map()), util.isArray(anything));

interface Opts {
  a: number;
  b?: string;
}
const base: Opts = { a: 1 };
const merged = util._extend(base, { b: "two" });
console.log(merged, merged === base, base.b);
const plain = util._extend({}, { x: 1, y: 2 });
console.log(plain, Object.keys(plain));
console.log(util._extend({ keep: 1 }, null), util._extend({ keep: 2 }, undefined));
