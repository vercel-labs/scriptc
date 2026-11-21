// t.test takes Node's subtest options: skip and todo directives, a timeout,
// plan, and concurrency, and the awaited call resolves to undefined once the
// subtest settles.
import assert from "node:assert";
import { test } from "node:test";

const seen: string[] = [];
const results: string[] = [];

test("subtests take Node's options", async (t) => {
  const resolved = await t.test("plain", () => {
    seen.push("plain");
  });
  results.push(`resolved ${resolved === undefined}`);
  await t.test("skipped", { skip: "not now" }, () => {
    seen.push("skip");
  });
  await t.test("todo", { todo: true }, () => {
    seen.push("todo");
  });
  await t.test("timed", { timeout: 500 }, () => {
    seen.push("timed");
  });
  await t.test("planned", { plan: 1 }, (st) => {
    st.assert.ok(true);
  });
  await t.test("conc", { concurrency: 2 }, async (st) => {
    await st.test("a", () => {});
  });
});

test("the options behaved as documented", () => {
  assert.deepStrictEqual(results, ["resolved true"]);
  // skip never runs, todo runs, and the timed, planned and concurrent
  // subtests ran.
  assert.deepStrictEqual(seen, ["plain", "todo", "timed"]);
});
