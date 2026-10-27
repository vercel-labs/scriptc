// getTestContext() answers the context of the test, suite or hook whose
// code is running: undefined at module top level, "<root>" in module-level
// hooks, the suite in its body, the hook's owner in a hook (a suite's
// beforeEach answers the suite), and the test in its body, across awaits,
// in async functions, promise callbacks and timers it starts, and in
// subtests. A timer keeps its test's context after the test ends.
// Concurrent subtests each answer their own context across their awaits.
import { after, afterEach, before, beforeEach, describe, getTestContext, it, test } from "node:test";
import * as assert from "node:assert";

const seen: string[] = [];
let late = "";

function record(where: string): void {
  const c = getTestContext();
  seen.push(`${where}: ${c === undefined ? "undefined" : c.fullName}`);
}

async function helper(where: string): Promise<void> {
  await Promise.resolve();
  record(where);
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 2));

record("top level");

before(() => record("root before"));
beforeEach(() => record("root beforeEach"));

describe("suite", () => {
  record("suite body");
  before(() => record("suite before"));
  beforeEach(() => record("suite beforeEach"));
  afterEach(() => record("suite afterEach"));
  after(() => record("suite after"));

  it("first", async () => {
    record("first body");
    await tick();
    record("first after await");
    await helper("first helper");
    await Promise.resolve().then(() => record("first then"));
    await new Promise<void>((resolve) =>
      setTimeout(() => {
        record("first timer");
        resolve();
      }, 1),
    );
  });

  describe("inner", () => {
    record("inner body");
    it("second", () => record("second body"));
  });
});

test("subtests", async (t) => {
  t.beforeEach(() => record("subtests beforeEach"));
  await t.test("sub", async () => {
    record("sub body");
    await tick();
    record("sub after await");
  });
  record("subtests after sub");
  const c = getTestContext();
  assert.strictEqual(c === t, true);
  setTimeout(() => {
    late = getTestContext()?.name ?? "undefined";
  }, 0);
});

test("concurrent", { concurrency: true }, async (t) => {
  const order: string[] = [];
  const body = async (): Promise<void> => {
    order.push(getTestContext()?.name ?? "undefined");
    await tick();
    order.push(getTestContext()?.name ?? "undefined");
    await tick();
    order.push(getTestContext()?.name ?? "undefined");
  };
  t.after(() => {
    seen.push(`concurrent: ${order.join(" ")}`);
  });
  t.test("c1", body);
  t.test("c2", body);
});

test("check", () => {
  assert.strictEqual(late, "subtests");
  assert.deepStrictEqual(seen, [
    "top level: undefined",
    "root before: <root>",
    "suite body: suite",
    "inner body: suite > inner",
    "suite before: suite",
    "root beforeEach: <root>",
    "suite beforeEach: suite",
    "first body: suite > first",
    "first after await: suite > first",
    "first helper: suite > first",
    "first then: suite > first",
    "first timer: suite > first",
    "suite afterEach: suite",
    "root beforeEach: <root>",
    "suite beforeEach: suite",
    "second body: suite > inner > second",
    "suite afterEach: suite",
    "suite after: suite",
    "root beforeEach: <root>",
    "root beforeEach: <root>",
    "subtests beforeEach: subtests",
    "sub body: subtests > sub",
    "sub after await: subtests > sub",
    "subtests after sub: subtests",
    "root beforeEach: <root>",
    "root beforeEach: <root>",
    "root beforeEach: <root>",
    "concurrent: c1 c2 c1 c2 c1 c2",
    "root beforeEach: <root>",
  ]);
});
