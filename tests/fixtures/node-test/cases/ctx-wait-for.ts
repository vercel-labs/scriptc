// t.waitFor polls a condition until it stops throwing or rejecting, racing
// the poll against one timeout; the timeout Error carries the last cause.
import assert from "node:assert/strict";
import { test } from "node:test";

type Failure = { name: string; message: string; cause?: { message: string } };
const failure = (error: unknown): string => {
  const e = error as Failure;
  const cause = e.cause ? ` cause=${e.cause.message}` : "";
  return `${e.name} ${e.message}${cause}`;
};

test("waitFor resolves with a synchronous result", async (t) => {
  assert.strictEqual(await t.waitFor(() => 42), 42);
});

test("waitFor resolves an undefined result", async (t) => {
  const value: undefined = await t.waitFor(() => undefined);
  assert.ok(value === undefined);
});

test("waitFor awaits a promise-returning condition", async (t) => {
  assert.strictEqual(await t.waitFor(() => Promise.resolve(7)), 7);
});

test("waitFor returns a promise", async (t) => {
  const p = t.waitFor(() => true);
  assert.strictEqual(p instanceof Promise, true);
  await p;
});

test("waitFor polls until the condition stops throwing", async (t) => {
  let attempts = 0;
  const value = await t.waitFor(
    () => {
      attempts++;
      if (attempts < 3) throw new Error(`attempt ${attempts}`);
      return attempts * 10;
    },
    { interval: 5 },
  );
  assert.strictEqual(value, 30);
  assert.strictEqual(attempts, 3);
});

test("waitFor awaits an async condition", async (t) => {
  let attempts = 0;
  const value = await t.waitFor(
    async () => {
      attempts++;
      if (attempts < 2) throw new Error("not yet");
      return "ok";
    },
    { interval: 5 },
  );
  assert.strictEqual(value, "ok");
  assert.strictEqual(attempts, 2);
});

test("waitFor rejects with the last cause on timeout", async (t) => {
  let thrown: unknown = null;
  try {
    await t.waitFor(
      () => {
        throw new Error("still failing");
      },
      { interval: 5, timeout: 30 },
    );
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof Error);
  assert.strictEqual(failure(thrown), "Error waitFor() timed out cause=still failing");
});

test("waitFor reports the last async rejection as the cause", async (t) => {
  let thrown: unknown = null;
  try {
    await t.waitFor(
      async () => {
        throw new Error("rejected");
      },
      { interval: 5, timeout: 20 },
    );
  } catch (error) {
    thrown = error;
  }
  assert.strictEqual(failure(thrown), "Error waitFor() timed out cause=rejected");
});

test("waitFor validates the option values", async (t) => {
  const range = 'The value of "options.interval" is out of range. It must be >= 0 && <= 2147483647.';
  let interval: unknown = null;
  try {
    await t.waitFor(() => true, { interval: -1 });
  } catch (error) {
    interval = error;
  }
  assert.strictEqual(failure(interval), `RangeError ${range} Received -1`);

  const timeoutRange = range.replace("interval", "timeout");
  let timeout: unknown = null;
  try {
    await t.waitFor(() => true, { timeout: 1e21 });
  } catch (error) {
    timeout = error;
  }
  assert.strictEqual(failure(timeout), `RangeError ${timeoutRange} Received 1e_+21`);
});

test("waitFor treats an explicit undefined option as absent", async (t) => {
  assert.strictEqual(
    await t.waitFor(() => "first", { interval: undefined, timeout: undefined }),
    "first",
  );
});

test("waitFor with a zero timeout still takes a synchronous result", async (t) => {
  assert.strictEqual(await t.waitFor(() => "first", { timeout: 0 }), "first");
});
