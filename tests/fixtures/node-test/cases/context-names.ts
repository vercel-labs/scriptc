// @exit: 0
// The names and values a context carries: name and fullName for a test
// body, a subtest, a suite body and the hooks' contexts, filePath, attempt,
// workerId and tags, passed in the body and in the hooks, and the
// diagnostic lines a test and a suite queue. The registration overloads
// that take a bare function, no function, or an options object first are
// part of the same surface.
import assert from "node:assert";
import { afterEach, describe, it, test, type SuiteContext, type TestContext } from "node:test";

const seen: string[] = [];
const asTest = (c: TestContext | SuiteContext): TestContext => c as unknown as TestContext;

test("names", (t) => {
  seen.push(`body ${t.name} | ${t.fullName}`);
  t.diagnostic("test diagnostic");
  t.test("inner", (c) => {
    seen.push(`inner ${c.name} | ${c.fullName}`);
  });
});

describe("suite names", (s) => {
  seen.push(`suite ${s.name} | ${s.fullName} | ${s.attempt} | ${(s.filePath ?? "").endsWith("context-names.ts")}`);
  s.diagnostic("suite diagnostic");
  afterEach((c) => {
    const context = asTest(c);
    seen.push(`afterEach ${context.name} passed=${context.passed}`);
  });
  it("child", () => {
    seen.push("child body");
  });
});

function namedBare() {
  seen.push("bare function");
}
test(namedBare);

test("no function at all");

test("overloads", async (t) => {
  function bare() {
    seen.push("t.test(fn)");
  }
  await t.test(bare);
  await t.test("with fn", () => {
    seen.push("t.test(name,fn)");
  });
  await t.test("with opts", { concurrency: false }, () => {
    seen.push("t.test(name,opts,fn)");
  });
  await t.test({ skip: true }, () => {
    seen.push("t.test(opts,fn) does not run");
  });
});

test("values", (t) => {
  seen.push(`attempt=${t.attempt} workerId=${String(t.workerId)} tags=${t.tags.length}`);
  t.diagnostic("values diagnostic");
  t.assert.ok(true);
  t.assert.strictEqual(1, 1);
  t.assert.deepStrictEqual([1], [1]);
  seen.push(`body passed=${t.passed}`);
});

test("report", () => {
  assert.deepStrictEqual(seen, [
    "suite suite names | suite names | 0 | true",
    "body names | names",
    "inner inner | names > inner",
    "child body",
    "afterEach child passed=true",
    "bare function",
    "t.test(fn)",
    "t.test(name,fn)",
    "t.test(name,opts,fn)",
    "attempt=0 workerId=undefined tags=0",
    "body passed=false",
  ]);
});
