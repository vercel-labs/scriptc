// @requires-libnode
// Synchronous calls into Node.js through @scriptc/node: arguments and
// results cross as JSON copies, module state lives on between calls, and
// output from both sides interleaves in program order.
import { callSync } from "@scriptc/node";
import * as node from "@scriptc/node";
import { callSync as runInNode } from "@scriptc/node";

interface Point {
  x: number;
  y: number;
  label: string;
}

console.log("before");
const sum = callSync<number>("./math.cjs", "add", 2, 3);
console.log("sum", sum, sum + 1);
console.log(callSync<string>("./math.cjs", "greet", "wörld ☃ 🌍"));
const p = callSync<Point>("./math.cjs", "point", 1.5, -2);
console.log(p.x + p.y, p.label, JSON.stringify(p));
const squares = callSync<number[]>("./math.cjs", "squares", 5);
console.log(squares.length, squares.join(","));
const nothing = callSync<undefined>("./math.cjs", "nothing");
console.log(nothing === undefined);
const echoed = callSync(
  "./math.cjs",
  "echo",
  { a: [1, "two", null, true], b: { c: "d" } },
  undefined,
  [undefined, 0.1],
);
console.log(JSON.stringify(echoed));
const flags = callSync<boolean[]>("./math.cjs", "flags", 3);
console.log(flags.map((f) => (f ? "y" : "n")).join(""));
console.log(node.callSync<string>("pkg-esm", "shout", "an es module, loaded with require"));
console.log(runInNode<number>("./math.cjs", "add", 40, 2));
console.log(callSync<number>("./math.cjs", "count"), callSync<number>("./math.cjs", "count"));
callSync("./math.cjs", "say", "from node");
console.log("after");
