// assert.strictEqual and assert.notStrictEqual compare a nullable number,
// string or boolean with SameValue against a value of another type or
// null/undefined, and notStrictEqual compares a nullable stream against
// null or undefined. Failures report Node's messages.
import assert from "node:assert";
import { spawn, spawnSync } from "node:child_process";

function find(values: number[], value: number): number | null {
  const index = values.indexOf(value);
  return index < 0 ? null : index;
}
function label(n: number): string | null {
  return n > 0 ? "positive" : null;
}
function ratio(n: number): number | undefined {
  return n === 0 ? undefined : n / n;
}
function flag(n: number): boolean | null {
  return n === 0 ? null : n > 0;
}

assert.strictEqual(find([1, 2, 3], 2), 1);
assert.strictEqual(find([1, 2, 3], 9), null);
assert.notStrictEqual(find([1, 2, 3], 3), null);
assert.notStrictEqual(find([1, 2, 3], 3), 1);
assert.strictEqual(label(1), "positive");
assert.strictEqual(label(-1), null);
assert.notStrictEqual(label(-1), undefined);
assert.strictEqual(ratio(0), undefined);
assert.strictEqual(ratio(-0), undefined);
assert.strictEqual(flag(2), true);
assert.strictEqual(flag(0), null);
assert.strictEqual(null, find([], 1));
console.log("passing comparisons ok");

const nan: number | null = Number("x");
assert.strictEqual(nan, NaN);

function report(run: () => void): void {
  try {
    run();
    console.log("no throw");
  } catch (e) {
    const error = e as assert.AssertionError;
    console.log(error.name, error.code, error.operator, error.generatedMessage);
    console.log(JSON.stringify(error.message));
    console.log(String(error.actual), String(error.expected));
  }
}
report(() => assert.strictEqual(find([1], 1), null));
report(() => assert.strictEqual(find([1], 2), 0));
report(() => assert.strictEqual(label(1), null));
report(() => assert.strictEqual(label(-1), "positive", "label mismatch"));
report(() => assert.notStrictEqual(find([1], 2), null));
report(() => assert.notStrictEqual(label(3), "positive"));
report(() => assert.strictEqual(flag(0), false));
report(() => assert.strictEqual(find([0], 0), -0));

const result = spawnSync("true");
assert.strictEqual(result.status, 0);
assert.strictEqual(result.signal, null);
const child = spawn("true", [], { stdio: ["ignore", "pipe", "pipe"] });
assert.notStrictEqual(child.stdout, null);
assert.notStrictEqual(child.stdout, undefined);
assert.notStrictEqual(child.stdin, undefined);
report(() => assert.notStrictEqual(child.stdin, null));
assert.strictEqual(child.signalCode, null);
child.on("close", (code) => {
  assert.strictEqual(child.exitCode, 0);
  assert.strictEqual(child.signalCode, null);
  console.log("child closed", code);
});
