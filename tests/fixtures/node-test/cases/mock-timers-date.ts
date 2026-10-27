// mock.timers for Date, setImmediate, AbortSignal.timeout and
// timers/promises scheduler.wait, enable() without apis, which mocks every
// API, and [Symbol.dispose](): Date.now() and new Date() read the mock
// clock that tick and setTime move, a mocked setImmediate runs before
// timers due at the same tick, a mocked AbortSignal.timeout aborts with
// the AbortError reason, mocking Date twice throws, and once a reset gives
// scheduler.wait back, Node's restored scheduler.wait throws
// ERR_INVALID_THIS, so its suite runs first.
import { describe, it, mock } from "node:test";
import * as assert from "node:assert";
import * as timersNamespace from "node:timers";
import { setImmediate as namedSetImmediate } from "node:timers";
import { scheduler } from "node:timers/promises";
import * as timersPromises from "node:timers/promises";

type Fail = { name: string; code?: string; message: string };
const failure = (fn: () => void): string => {
  try {
    fn();
    return "no throw";
  } catch (error) {
    const e = error as Fail;
    return `${e.name} ${e.code ?? "-"} ${e.message}`;
  }
};

describe("scheduler.wait", () => {
  it("settles from the mock queue, a microtask after tick", async (t) => {
    // scheduler.wait is not in the typed apis list; enable() mocks it.
    t.mock.timers.enable();
    const log: string[] = [];
    const named = scheduler.wait(50).then(() => {
      log.push("named");
    });
    const namespace = timersPromises.scheduler.wait(50).then(() => {
      log.push("namespace");
    });
    const omitted = scheduler.wait().then(() => {
      log.push("omitted");
    });
    const unref = scheduler.wait(50, { ref: false }).then(() => {
      log.push("unref");
    });
    t.mock.timers.tick(50);
    log.push("after tick");
    queueMicrotask(() => log.push("microtask"));
    await Promise.all([named, namespace, omitted, unref]);
    assert.deepStrictEqual(log, [
      "after tick",
      "microtask",
      "named",
      "namespace",
      "omitted",
      "unref",
    ]);
  });

  it("throws once a reset gave it back", () => {
    const got = failure(() => {
      void scheduler.wait(1);
    });
    assert.strictEqual(
      got,
      'TypeError ERR_INVALID_THIS Value of "this" must be of type Scheduler',
    );
  });
});

describe("Date", () => {
  it("reads the mock clock", (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 1000 });
    assert.strictEqual(Date.now(), 1000);
    assert.strictEqual(new Date().getTime(), 1000);
    assert.strictEqual(new Date(5).getTime(), 5);
    assert.strictEqual(new Date() instanceof Date, true);
    t.mock.timers.tick(5);
    assert.strictEqual(Date.now(), 1005);
    t.mock.timers.setTime(50);
    assert.strictEqual(new Date().toISOString(), "1970-01-01T00:00:00.050Z");
  });

  it("is real again after reset", (t) => {
    t.mock.timers.enable({ apis: ["Date"] });
    assert.strictEqual(Date.now(), 0);
    t.mock.timers.reset();
    assert.strictEqual(Date.now() > 1e12, true);
  });

  it("shares the clock with mocked timers", (t) => {
    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 100 });
    const seen: number[] = [];
    setTimeout(() => seen.push(Date.now()), 25);
    t.mock.timers.tick(30);
    seen.push(Date.now());
    assert.deepStrictEqual(seen, [130, 130]);
  });

  it("throws when another tracker mocks Date", (t) => {
    mock.timers.enable({ apis: ["Date"], now: 7 });
    const got = failure(() => t.mock.timers.enable({ apis: ["Date"] }));
    assert.strictEqual(got, "Error ERR_INVALID_STATE Invalid state: Date is already being mocked!");
    assert.strictEqual(failure(() => t.mock.timers.tick(1)).includes("enable MockTimers first"), true);
    assert.strictEqual(Date.now(), 7);
    mock.timers.reset();
  });
});

describe("setImmediate", () => {
  it("runs before timers due at the same tick", (t) => {
    t.mock.timers.enable({ apis: ["setImmediate", "setTimeout"] });
    const log: string[] = [];
    setTimeout(() => log.push("timeout 0"), 0);
    setImmediate(() => log.push("immediate"));
    setImmediate((tag: string) => log.push(`immediate ${tag}`), "x");
    const cleared = setImmediate(() => log.push("cleared"));
    clearImmediate(cleared);
    assert.strictEqual(cleared.hasRef(), true);
    assert.strictEqual(cleared.unref().hasRef(), true);
    assert.strictEqual(cleared.ref().hasRef(), true);
    t.mock.timers.tick(0);
    log.push("tick 0");
    assert.deepStrictEqual(log, ["immediate", "immediate x", "timeout 0", "tick 0"]);
  });

  it("an immediate queued by a due timeout runs that timeout again", (t) => {
    // Node removes a fired timer only when it is still first in the queue;
    // the immediate's run time (now - 1) puts it first.
    t.mock.timers.enable({ apis: ["setImmediate", "setTimeout"] });
    const log: string[] = [];
    setTimeout(() => {
      log.push("timeout");
      if (log.length === 1) setImmediate(() => log.push("immediate"));
    }, 0);
    t.mock.timers.tick(0);
    assert.deepStrictEqual(log, ["timeout", "immediate", "timeout"]);
  });

  it("named and namespace imports keep the loop's immediates", async (t) => {
    t.mock.timers.enable({ apis: ["setImmediate"] });
    const log: string[] = [];
    await new Promise<void>((resolve) =>
      namedSetImmediate(() => {
        log.push("named");
        resolve();
      }),
    );
    await new Promise<void>((resolve) =>
      timersNamespace.setImmediate(() => {
        log.push("namespace");
        resolve();
      }),
    );
    assert.deepStrictEqual(log, ["named", "namespace"]);
  });
});

describe("enable() without apis", () => {
  it("mocks every API", (t) => {
    t.mock.timers.enable();
    const log: string[] = [];
    assert.strictEqual(Date.now(), 0);
    setTimeout(() => log.push(`timeout at ${Date.now()}`), 2);
    setImmediate(() => log.push("immediate"));
    const beat = setInterval(() => {
      log.push(`interval at ${Date.now()}`);
      clearInterval(beat);
    }, 1);
    const signal = AbortSignal.timeout(3);
    signal.addEventListener("abort", () => {
      const reason = signal.reason as { name: string; message: string };
      log.push(`abort ${reason.name}: ${reason.message}`);
    });
    t.mock.timers.tick(3);
    assert.strictEqual(signal.aborted, true);
    assert.deepStrictEqual(log, [
      "immediate",
      "interval at 3",
      "timeout at 3",
      "abort AbortError: This operation was aborted",
    ]);
  });

  it("[Symbol.dispose]() resets", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let fired = 0;
    setTimeout(() => fired++, 1);
    t.mock.timers[Symbol.dispose]();
    assert.strictEqual(failure(() => t.mock.timers.tick(1)).includes("enable MockTimers first"), true);
    assert.strictEqual(fired, 0);
  });

  it("mocks nothing with an empty apis list", (t) => {
    t.mock.timers.enable({ apis: [] });
    assert.strictEqual(Date.now() > 1e12, true);
    t.mock.timers.tick(1);
  });
});
