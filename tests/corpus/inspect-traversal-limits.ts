// util.inspect's traversal limits: nesting deeper than Node's stack allows
// ends in its "Inspection interrupted prematurely" marker (typed records and
// untyped objects alike), and the default depth still answers [Object].
import * as util from "node:util";

type Node = { next?: Node };
const typed: Node = {};
let head = typed;
for (let i = 0; i < 100000; i++) head = head.next = {};
console.log(util.inspect(typed));
const long = util.inspect(typed, { depth: Infinity });
const count = (long.match(/next/g) ?? []).length;
console.log(count > 500 && count < 10000);
console.log(long.includes("[Object: Inspection interrupted prematurely. Maximum call stack size exceeded.]"));

const untyped: unknown = JSON.parse("{}");
let cursor = untyped as Record<string, unknown>;
for (let i = 0; i < 20000; i++) {
  const next: Record<string, unknown> = {};
  cursor.next = next;
  cursor = next;
}
console.log(util.inspect(untyped));
const deep = util.inspect(untyped, { depth: Infinity });
const deepCount = (deep.match(/next/g) ?? []).length;
console.log(deepCount > 500 && deepCount < 10000);
console.log(deep.includes("[Object: Inspection interrupted prematurely. Maximum call stack size exceeded.]"));
