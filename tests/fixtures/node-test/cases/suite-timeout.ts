// @exit: 1
// A suite's { timeout } is Node's shared deadline for its hooks and tests:
// a child still running when it elapses is cancelled with Node's parent
// message, the children that never ran are cancelled the same way, and the
// suite fails with its own "test timed out after <timeout>ms".
import { describe, it, test } from "node:test";

describe("suite timeout", { timeout: 20 }, () => {
  it("slow child", async () => {
    await new Promise((resolve) => setTimeout(resolve, 60));
  });
  it("never runs", () => {});
});

describe("suite concurrency still runs", { concurrency: 2 }, () => {
  it("a", () => {});
  it("b", () => {});
});

test("report", () => {});
