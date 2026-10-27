// Tagged templates whose tags touch the dynamic tier: `any[]`-rest tags
// (the corpus's dominant shape — the strings array and every value cross
// the checked-dynamic boundary per call), `any`-typed parameters, and a
// tag that is itself an `any` value (the dynCall boundary: a
// non-function tag throws Node's catchable TypeError).
function f(...args: any[]): string {
  return args.length > 1
    ? `${args.length}:${String(args[0])}:${String(args[1])}`
    : `${args.length}:${String(args[0])}`;
}
console.log(f`a${1}b${2}c`);
console.log(f`plain`);

function declare(x: any, ...ys: any[]): string {
  return `${String(x)}|${ys.length}`;
}
console.log(declare`Hello ${0} world!`);

var notATag: any;
try {
  notATag`boom`;
} catch (e) {
  // The engine's TypeError text drops the callee name where Node carries
  // it (the island callFn divergence, plain calls included) — pin the
  // catchability and the class of message, not the exact bytes.
  console.log("caught:", (e as Error).message.includes("not a function"));
}
