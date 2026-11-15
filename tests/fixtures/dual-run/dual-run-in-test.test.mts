import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dualRun } from "@scriptc/experimental/dual-run";

// A node:test file that compares another file from inside the runner. The
// process the runner starts carries NODE_TEST_CONTEXT, which must not reach
// either lane: node:test would answer with binary test events instead of the
// spec report, and a compiled program never does that.
test("dualRun inside the runner compares the file", async () => {
  const result = await dualRun(fileURLToPath(new URL("./passing.test.mts", import.meta.url)), {
    cwd: process.cwd(),
  });
  if (!result.equal) throw new Error(result.diff);
});
