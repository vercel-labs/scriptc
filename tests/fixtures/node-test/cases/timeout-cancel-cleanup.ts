// @exit: 1
// A subtest cancelled by its parent's timeout is cleaned up as Node does:
// its mocks are restored at once, and its afterEach chain and t.after
// hooks run once the runner has moved on to the next test. Its body keeps
// running and sees the restored method when it settles.
import { afterEach, test } from "node:test";
import * as assert from "node:assert";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const api = { greet: (): string => "real" };
const seen: string[] = [];

afterEach((c) => {
  seen.push(`root afterEach for ${c.name}`);
});

test("parent", { timeout: 30 }, async (t) => {
  t.afterEach((c) => {
    seen.push(`parent afterEach for ${c.name}`);
  });
  await t.test("sub", async (t) => {
    t.mock.method(api, "greet", () => "mocked");
    t.after(() => {
      seen.push(`after hook of ${t.name}`);
    });
    seen.push(`sub runs: ${api.greet()}`);
    await sleep(200);
    seen.push(`sub settles: ${api.greet()}`);
  });
});

test("next", async () => {
  seen.push(`next starts: ${api.greet()}`);
  await sleep(300);
  assert.deepStrictEqual(seen, [
    "sub runs: mocked",
    "root afterEach for parent",
    "next starts: real",
    "parent afterEach for sub",
    "root afterEach for sub",
    "after hook of sub",
    "sub settles: real",
  ]);
});
