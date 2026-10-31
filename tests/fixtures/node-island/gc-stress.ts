// Full garbage collections in Node during island calls
// (tests/harness/node-island.test.ts): from the main stack, from deep native
// recursion, from async functions and from timers, with deep JavaScript
// recursion on Node's side.
import { call, callSync } from "@scriptc/node";

function nested(depth: number): number {
  if (depth === 0) return callSync<number>("./gc.cjs", "deep", 2000);
  return nested(depth - 1) + 1;
}

async function inFiber(n: number): Promise<number> {
  const later = await call<number>("./gc.cjs", "later", n);
  return later + callSync<number>("./gc.cjs", "churn", 1);
}

console.log("churn", callSync<number>("./gc.cjs", "churn", 20));
console.log("nested", nested(3000));
console.log("deep", callSync<number>("./gc.cjs", "deep", 8000));
const results = await Promise.all([1, 2, 3, 4].map((n) => inFiber(n)));
console.log("fibers", results.join(","));
setTimeout(() => {
  console.log("timer", callSync<number>("./gc.cjs", "churn", 5));
}, 1);
