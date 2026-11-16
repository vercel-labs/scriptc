// @exit: 1
// { expectFailure } (and its expectFailure method twins): a flagged test or
// suite passes only if its own run throws, and its result line carries
// "# EXPECTED FAILURE". An unexpected pass fails with Node's message. The
// flag is inherited by descendants the way todo is; skip keeps its SKIP
// directive and todo keeps TODO (and its counter) while the flip still
// applies, a throwing hook is the expected failure, and the hooks see the
// flipped outcome (passed true, t.error the thrown error).
import assert from "node:assert";
import {
  afterEach,
  beforeEach,
  describe,
  expectFailure,
  it,
  suite,
  test,
  type SuiteContext,
  type TestContext,
} from "node:test";

/* @types/node does not declare TestContext.error, so the hook narrows to the
 * test context the runtime hands it. */
const hookContext = (t: TestContext | SuiteContext): TestContext => t as unknown as TestContext;

test("throws as expected", { expectFailure: true }, () => {
  throw new Error("boom");
});

test("string reason behaves as true", { expectFailure: "not implemented yet" }, () => {
  throw new Error("boom");
});

test("unexpected pass fails", { expectFailure: true }, () => {});

test.expectFailure("method twin", () => {
  throw new Error("boom");
});

it.expectFailure("it twin", () => {
  throw new Error("boom");
});

expectFailure("top-level export", () => {
  throw new Error("boom");
});

test("flagged parent inherits to children", { expectFailure: true }, async (t) => {
  await t.test("child throws", () => {
    throw new Error("child");
  });
});

describe("flagged suite", { expectFailure: true }, () => {
  test("child throws too", () => {
    throw new Error("in suite");
  });
});

describe.expectFailure("describe twin", () => {
  throw new Error("suite body");
});

suite.expectFailure("suite twin", { skip: false }, () => {
  throw new Error("suite body");
});

describe.expectFailure("describe with child", () => {
  test("child throws", () => {
    throw new Error("child");
  });
});

test("skip keeps its directive", { expectFailure: true, skip: true }, () => {});
test("todo keeps its directive", { expectFailure: true, todo: true }, () => {
  throw new Error("expected and todo");
});
test("todo unexpected pass stays todo", { expectFailure: true, todo: true }, () => {});

describe("hook failure is the expected failure", () => {
  beforeEach(() => {
    throw new Error("hook");
  });
  test("flagged", { expectFailure: true }, () => {});
});

const seen: string[] = [];

afterEach((t) => {
  const context = hookContext(t);
  if (t.name === "throws as expected" || t.name === "unexpected pass fails") {
    seen.push(
      `${t.name} passed=${t.passed} error=${context.error === null ? "null" : context.error.message}`,
    );
  }
});

test("records the hook view", () => {
  assert.deepStrictEqual(seen, [
    "throws as expected passed=true error=boom",
    "unexpected pass fails passed=false error=test was expected to fail but passed",
  ]);
});
