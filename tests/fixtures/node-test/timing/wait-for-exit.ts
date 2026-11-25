// A timed-out t.waitFor() clears both of its timers, as Node's done()
// does: once the timeout rejects the result, nothing is left to keep the
// loop alive. The poll interval here is far longer than the timeout, so a
// leaked poll timer holds the process open for it — node-test.test.ts
// bounds this fixture's wall clock to catch that.
import assert from "node:assert/strict";
import { test } from "node:test";

const failure = (error: unknown): string => (error as { message: string }).message;

test("a timed-out waitFor leaves no pending poll timer", async (t) => {
  let thrown: unknown = null;
  try {
    await t.waitFor(
      () => {
        throw new Error("still failing");
      },
      { interval: 5000, timeout: 30 },
    );
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof Error);
  assert.strictEqual(failure(thrown), "waitFor() timed out");
});
