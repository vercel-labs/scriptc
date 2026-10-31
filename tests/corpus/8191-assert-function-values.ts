// assert methods read as values in TypeScript: a constant alias called
// directly, a stored value, and a method passed as a callback.
import assert from "node:assert";
const eq = assert.strictEqual;
eq(1, 1);
const fail = assert.fail;
const checks: unknown[] = [assert.ok, assert.fail];
console.log(typeof checks[0], checks[1] === fail);
try {
  eq(1, 2, "one is not two");
} catch (error) {
  console.log((error as Error).message);
}
const run = (fn: (v: unknown) => void) => fn(true);
run(assert.ok);
console.log("done");
