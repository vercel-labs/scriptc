// A throwing module-level after hook: the run reports the entry file as a
// failed result with the hook's location, after the top-level results,
// without counting it, and the exit code stays 0, as in Node.
import { after, test } from "node:test";

after(() => {
  throw new Error("root after failed");
});

test("t", () => {});
