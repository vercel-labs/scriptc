// @exit: 1
// TestContext members read as values: t.filePath (the entry file),
// t.attempt (0), t.passed (false while the body runs, the outcome in the
// test's t.after hooks), t.workerId (undefined outside a worker) and
// t.tags ([] without the tags option).
import { describe, it, test } from "node:test";
import * as assert from "node:assert";

const seen: string[] = [];

describe("passed", () => {
  it("passes", (t) => {
    t.after(() => {
      seen.push(`after passes: ${t.passed}`);
    });
    seen.push(`body: ${t.passed}`);
  });
  it("fails", (t) => {
    t.after(() => {
      seen.push(`after fails: ${t.passed}`);
    });
    throw new Error("expected failure");
  });
});

test("members", (t) => {
  const file = t.filePath ?? "";
  assert.strictEqual(file.endsWith("tests/fixtures/node-test/cases/ctx-members.ts"), true);
  assert.strictEqual(t.attempt, 0);
  assert.strictEqual(t.workerId === undefined, true);
  assert.strictEqual(t.tags.length, 0);
  assert.deepStrictEqual(seen, ["body: false", "after passes: true", "after fails: false"]);
});
