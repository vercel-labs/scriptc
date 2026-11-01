// util.inspect's output budget belongs to one call: once an inspection's
// output passes 2 ** 27 characters at one indentation level, its later
// composites print as [Array] and [Object], and the next inspection renders
// whole (typed and untyped values, util.inspect and console.log alike).
import * as util from "node:util";

const s = "x".repeat(10000);
const big: Record<string, string[]> = {};
for (let i = 0; i < 14000; i++) big["k" + i] = [s];
const first = util.inspect(big);
console.log(first.length, first.includes("k13999: [Array]"));

console.log(util.inspect({ a: [1, 2] }));
console.log(util.inspect([{ b: 1 }]));
console.log(util.inspect(new Map<string, number[]>([["c", [3]]])));
const untyped: any = JSON.parse('{"d":[4,{"e":5}]}');
console.log(util.inspect(untyped));
console.log({ f: [6] }, [[7]]);

const dynamicBig: any = JSON.parse("{}");
for (let i = 0; i < 14000; i++) dynamicBig["k" + i] = [s];
console.log(util.inspect(dynamicBig).length);
console.log(util.inspect(untyped));
console.log(util.inspect({ g: [8] }));
