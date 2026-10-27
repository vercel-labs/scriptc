// util.inspect of errors that carry Node's extra own properties: the
// AssertionError fields (rendered at depth 0, with long string values
// shortened), the falsy-rejection reason util.callbackify attaches, an
// OpenSSL-style crypto error's library and reason, and a system error's
// errno, syscall and path. Each error's stack is cleared first, so Node
// prints the same stackless form.
import * as assert from "node:assert";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import { callbackify, inspect } from "node:util";

function show(e: unknown): void {
  if (e instanceof Error) {
    e.stack = "";
    console.log(inspect(e));
  }
}

try {
  assert.strictEqual(1, 2);
} catch (e) {
  show(e);
}
type Doc = { a: number; nested?: { b: number[] } };
const left: Doc = { a: 1, nested: { b: [1, 2] } };
const right: Doc = { a: 2 };
try {
  assert.deepStrictEqual(left, right, "custom message");
} catch (e) {
  show(e);
}
try {
  assert.notStrictEqual("x".repeat(600), "x".repeat(600));
} catch (e) {
  show(e);
}
try {
  assert.ok(false);
} catch (e) {
  show(e);
}
try {
  throw new RangeError("no extra properties");
} catch (e) {
  show(e);
}
try {
  crypto.createHash("sha256", { outputLength: 5 });
} catch (e) {
  show(e);
}
try {
  fs.readFileSync("/no/such/dir/file.txt");
} catch (e) {
  show(e);
  console.log(inspect({ error: e }, { depth: 0 }));
}

async function rejectsNull(): Promise<void> {
  return Promise.reject(null);
}
callbackify(rejectsNull)((err: NodeJS.ErrnoException | null) => {
  show(err);
});
