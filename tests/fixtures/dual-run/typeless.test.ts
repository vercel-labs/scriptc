import { test } from "node:test";
import assert from "node:assert/strict";

// A .ts file in a package that does not set "type": "module" makes Node warn
// about the module type, and the warning carries the process id, so two Node
// runs of this file never match. The lanes have to agree on what they see.
test("adds", () => {
  assert.equal(2 + 2, 4);
});
