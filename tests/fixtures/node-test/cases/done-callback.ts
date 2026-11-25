// @exit: 1
// Node's callback form: a test or hook written (t, done) finishes when it
// calls done. A falsy result passes, a truthy one fails the test with that
// value, a second call fails it with "callback invoked multiple times", and
// a body that also returns a promise fails with "passed a callback but also
// returned a Promise". Subtests and the hook kinds take the same second
// parameter.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";

test("done", (t, done) => {
  assert.equal(typeof done, "function");
  done();
});

test("done falsy results", (t, done) => {
  done(null);
});

test("done zero", (t, done) => {
  done(0);
});

test("done empty", (t, done) => {
  done("");
});

test("done later", (t, done) => {
  setTimeout(() => done(), 5);
});

test("done error", (t, done) => {
  done(new Error("boom"));
});

test("done truthy value", (t, done) => {
  done("bad");
});

test("done twice", (t, done) => {
  done();
  done();
});

test("done and a promise", async (t, done) => {
  done();
});

test("throws before done", (t, done) => {
  throw new Error("sync");
});

test("timeout with done", { timeout: 20 }, (t, done) => {});

test("subtest with done", async (t) => {
  await t.test("child", (c, done) => {
    c.diagnostic("child diag");
    done();
  });
});

describe("hook forms", () => {
  beforeEach((c, done) => {
    done();
  });
  afterEach((c, done) => {
    done();
  });
  test("inside", (t, done) => {
    done();
  });
});

describe("async hook with done", () => {
  beforeEach(async (c, done) => {
    done();
  });
  test("inside", () => {});
});

describe("failing hook done", () => {
  beforeEach((c, done) => {
    done(new Error("hook boom"));
  });
  test("fails", () => {});
});

test("report", () => {
  assert.ok(true);
});
