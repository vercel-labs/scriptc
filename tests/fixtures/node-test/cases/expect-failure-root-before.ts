// @exit: 1
// A throwing root before hook fails each top-level test before it runs; for
// a test or suite flagged { expectFailure } that failure is the expected
// one, so it passes with its directive, and a flagged suite's descendants
// (which inherit the flag) pass the same way.
import { afterEach, before, describe, test } from "node:test";

before(() => {
  throw new Error("root before");
});

afterEach((t) => {
  if (t.name === "flagged test") t.diagnostic(`passed=${t.passed}`);
});

test("flagged test", { expectFailure: true }, () => {});
describe("flagged suite", { expectFailure: true }, () => {
  test("inner", () => {});
});
test("plain", () => {});
