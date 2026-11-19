// @exit: 1
// The { signal } option: an AbortSignal that cancels the run when it fires.
// A test a signal aborts reports the signal's reason and counts cancelled,
// and a suite does the same; a suite aborted before it runs never reports
// the tests inside it, and one aborted while running cancels the child in
// flight and the ones queued behind it with Node's parent message.
import assert from "node:assert/strict";
import { afterEach, describe, it, test } from "node:test";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const ran: string[] = [];

const pre = new AbortController();
pre.abort(new Error("pre aborted"));
test("pre aborted", { signal: pre.signal }, () => {
  ran.push("pre aborted body");
});

const preSuite = new AbortController();
preSuite.abort(new Error("pre aborted suite"));
describe("pre aborted suite", { signal: preSuite.signal }, () => {
  it("child", () => {
    ran.push("pre aborted suite child");
  });
});

const during = new AbortController();
test("aborted during body", { signal: during.signal }, async () => {
  await sleep(60);
});
setTimeout(() => during.abort(new Error("stop")), 10);

const suiteAbort = new AbortController();
describe("suite aborted while running", { signal: suiteAbort.signal }, () => {
  it("slow child", async () => {
    await sleep(60);
  });
  it("queued child", () => {
    ran.push("queued child");
  });
});
setTimeout(() => suiteAbort.abort(new Error("suite stop")), 10);

const hookOrder: string[] = [];
const hookAbort = new AbortController();
describe("hooks after abort", () => {
  afterEach((t) => {
    hookOrder.push(`a1 ${t.name}`);
  });
  afterEach((t) => {
    hookOrder.push(`a2 ${t.name}`);
  });
  test("aborted", { signal: hookAbort.signal }, async () => {
    await sleep(50);
  });
});
setTimeout(() => hookAbort.abort(new Error("hook stop")), 5);

test("cleanup hooks all ran", (t) => {
  t.diagnostic(hookOrder.join(" | "));
});

const syncAbort = new AbortController();
test("sync body aborts its signal", { signal: syncAbort.signal }, (t) => {
  t.diagnostic("sync body ran");
  syncAbort.abort(new Error("sync stop"));
});

test("report", () => {
  assert.deepStrictEqual(ran, []);
});
