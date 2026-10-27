// @exit: 1
// A throwing module-level before hook: each top-level test fails with its
// error without running its body or beforeEach hooks, and each top-level
// suite fails with it while the tests and suites in it are cancelled
// before they start. Later module-level before hooks still run at their
// before() calls, and the first failure is the one reported.
import { before, beforeEach, describe, it, test } from "node:test";

before(() => {
  throw new Error("root before failed");
});
before(async () => {
  await Promise.resolve();
  throw new Error("a later failure");
});
beforeEach(() => {
  throw new Error("beforeEach never runs");
});

describe("s", () => {
  it("x", () => {});
  describe("inner", () => {
    it("y", () => {});
  });
  it("z", () => {});
});

test("t", () => {
  throw new Error("the body never runs");
});
