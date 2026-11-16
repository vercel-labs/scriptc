// @exit: 1
// A suite body that throws fails the suite and cancels its children, as Node
// does: a flagged suite's failure is the expected one, so it and its
// flagged (inherited) children display the pass with the directive while
// still counting as cancelled; a plain suite lists its error with its child.
import { describe, test } from "node:test";

describe("flagged body throw", { expectFailure: true }, () => {
  test("child", () => {});
  throw new Error("body boom");
});

describe("plain body throw", () => {
  test("child", () => {});
  throw new Error("plain boom");
});
