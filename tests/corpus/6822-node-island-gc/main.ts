// @requires-libnode
// Garbage collections inside calls into Node.js: calls that allocate enough
// for V8 to collect while JavaScript runs, from the main program and from an
// async function that a timer on Node's loop resumes.
import { call, callSync } from "@scriptc/node";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  console.log("sync", callSync<number>("./alloc.cjs", "churn", 20));
  console.log("async", await call<number>("./alloc.cjs", "churn", 10));
  for (let i = 0; i < 3; i++) {
    await sleep(1);
    console.log("after timer", i, callSync<number>("./alloc.cjs", "churn", 20));
  }
  const a = call<number>("./alloc.cjs", "churn", 5);
  const b = call<number>("./alloc.cjs", "churn", 5);
  console.log("both", await a, await b);
  console.log("kept", callSync<number>("./alloc.cjs", "kept"));
}

main();
