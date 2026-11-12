import { test } from "node:test";

// Declared in a module the entry imports. Node reports the failure with the
// module as `file` and the file it ran as `entryFile`, so the reporter must
// keep the failure on the entry's line instead of comparing this module as
// a file of its own.
test("helper fails", () => {
  throw new Error("from the helper");
});

test("helper passes", () => {});
