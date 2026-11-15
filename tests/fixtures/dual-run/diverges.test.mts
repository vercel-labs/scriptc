import { test } from "node:test";
import assert from "node:assert/strict";

// The executable path is the one value the two lanes cannot share: Node
// prints its own path, the binary prints its own. The comparison stops at
// the first line.
console.log(process.execPath);

test("adds", () => {
  assert.equal(1 + 1, 2);
});
