// @exit: 1
// A suite body that throws fails the suite and cancels its children, as Node
// does: a flagged suite's failure is the expected one, so it and its
// flagged (inherited) children display the pass with the directive while
// still counting as cancelled; a plain suite lists its error with its child.
import assert from "node:assert";
import { after, before, describe, test } from "node:test";

const log: string[] = [];

describe("flagged body throw", { expectFailure: true }, () => {
  before(() => {
    log.push("before flagged");
  });
  after(() => {
    log.push("after flagged");
  });
  test("child", () => {});
  throw new Error("body boom");
});

describe("plain body throw", () => {
  before(() => {
    log.push("before plain");
  });
  after(() => {
    log.push("after plain");
  });
  test("child", () => {});
  throw new Error("plain boom");
});

test("hooks ran around the cancellation", () => {
  assert.deepStrictEqual(log, ["before flagged", "after flagged", "before plain", "after plain"]);
});
