// @exit: 1
// A throwing before hook of a suite fails the suite with its error, and
// every test and suite inside that never ran is cancelled with Node's
// "test did not finish before its parent and was cancelled" — a skipped
// one keeps its SKIP directive and a todo one prints ⚠, and both still
// list in the failing section.
import { before, describe, it, test } from "node:test";

describe("fails", () => {
  before(() => {
    throw new Error("before failed");
  });
  it("child a", () => {});
  it.todo("child todo");
  it.skip("child skip", () => {});
  describe("nested", () => {
    it("grandchild", () => {});
  });
});

describe("still runs", () => {
  test("after sibling suite", () => {});
});
