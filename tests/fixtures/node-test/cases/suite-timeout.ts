// @exit: 1
// A suite's { timeout } is Node's shared deadline for its hooks and tests: a
// child still running when it elapses is cancelled with Node's parent
// message, the children that never ran are cancelled the same way, and the
// suite fails with its own "test timed out after <timeout>ms". Under
// { concurrency } the children still queued when the deadline passes are
// cancelled without running, and a suite running beside a timed one is not
// bounded by its sibling's deadline.
import assert from "node:assert/strict";
import { before, beforeEach, describe, it, test } from "node:test";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const ran: string[] = [];

describe("suite timeout", { timeout: 20 }, () => {
  it("slow child", async () => {
    await sleep(60);
  });
  it("never runs", () => {});
});

describe("concurrent timeout", { timeout: 20, concurrency: 2 }, () => {
  it("first slow", async () => {
    await sleep(60);
  });
  it("second slow", async () => {
    await sleep(60);
  });
  it("queued child", () => {
    ran.push("queued child");
  });
});

describe("outer", { concurrency: 2 }, () => {
  describe("timed", { timeout: 20 }, () => {
    it("slow", async () => {
      await sleep(60);
    });
  });
  describe("untimed", () => {
    it("child", async () => {
      await sleep(30);
    });
  });
});

describe("suite concurrency still runs", { concurrency: 2 }, () => {
  it("a", () => {});
  it("b", () => {});
});

describe("nested deadlines", { timeout: 20 }, () => {
  describe("longer inner", { timeout: 200 }, () => {
    it("slow", async () => {
      await sleep(60);
    });
  });
});

describe("inherited hook deadline", { timeout: 20 }, () => {
  beforeEach(async () => {
    await sleep(60);
  });
  describe("hook inner", () => {
    it("child", () => {});
  });
});

describe("slow before", { timeout: 20 }, () => {
  before(async () => {
    await sleep(40);
  });
  it("child", async () => {
    await sleep(10);
  });
  it("fast child", () => {});
});

test("report", () => {
  assert.deepStrictEqual(ran, []);
});
