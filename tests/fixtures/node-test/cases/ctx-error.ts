// @exit: 1
// t.error: null while a test has not failed (its beforeEach hook and a
// passing test), and otherwise Node's ERR_TEST_FAILURE wrapper over the
// failure — its message the cause's message, a thrown string as itself and
// anything else inspected, its code ERR_TEST_FAILURE, and its `cause` the
// value the test threw. The shapes are recorded in afterEach hooks (an
// assertion there after a failing test is swallowed, as in Node) and
// compared by a final passing test.
import assert from "node:assert";
import { afterEach, beforeEach, test, type SuiteContext, type TestContext } from "node:test";

const seen: string[] = [];

/* @types/node does not declare TestContext.error (Node documents it), so
 * the hook narrows to the test context the runtime hands it. */
const testContext = (t: TestContext | SuiteContext): TestContext => t as unknown as TestContext;

beforeEach((t) => {
  seen.push(`before ${t.name} ${testContext(t).error === null}`);
});

afterEach((t) => {
  const error = testContext(t).error;
  if (error === null) {
    seen.push(`after ${t.name} null`);
    return;
  }
  const code = (error as unknown as { code: string }).code;
  seen.push(`after ${t.name} ${error instanceof Error} ${typeof code} ${error.message}`);
});

test("passes", () => {});

test("throws string", () => {
  throw "plain string";
});

test("throws object", () => {
  throw { code: "E_X" };
});

test("assertion", () => {
  assert.strictEqual(1, 2);
});

test("timeout", { timeout: 20 }, async () => {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 60);
  });
});

test("records", () => {
  assert.deepStrictEqual(seen.slice(0, 7), [
    "before passes true",
    "after passes null",
    "before throws string true",
    "after throws string true string plain string",
    "before throws object true",
    "after throws object true string { code: 'E_X' }",
    "before assertion true",
  ]);
  // The AssertionError's own message, which the assertion library renders.
  assert.strictEqual((seen[7] ?? "").startsWith("after assertion true string "), true);
  assert.deepStrictEqual(seen.slice(8), [
    "before timeout true",
    "after timeout true string test timed out after 20ms",
    "before records true",
  ]);
});
