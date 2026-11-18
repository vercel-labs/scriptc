// @exit: 1
// A pre-aborted suite is a failing result: a file whose only content is that
// cancelled suite exits nonzero, as in Node, even though suites are not
// counted in the summary.
import { describe, it } from "node:test";

const controller = new AbortController();
controller.abort(new Error("gone"));

describe("only child", { signal: controller.signal }, () => {
  it("child", () => {});
});
