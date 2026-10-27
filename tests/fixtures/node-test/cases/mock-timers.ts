// mock.timers on the module's `mock` and on t.mock, for setTimeout and
// setInterval: enable({ apis, now }), tick, runAll, reset and setTime, the
// order due timers run in (equal, zero, negative, fractional and omitted
// delays), clears, handle methods, Node's errors, and the reset of
// t.mock.timers when its test ends. Node replaces the globals, so calls
// through ESM named and namespace imports of node:timers and
// node:timers/promises keep the loop's timers.
import { describe, it, mock, test } from "node:test";
import * as assert from "node:assert";
import * as timersNamespace from "node:timers";
import { setTimeout as namedSetTimeout } from "node:timers";
import { setTimeout as sleep } from "node:timers/promises";

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
const NOT_ENABLED =
  "Error ERR_INVALID_STATE Invalid state: You should enable MockTimers first by calling the .enable function";
const negative = (n: string) =>
  `TypeError ERR_INVALID_ARG_VALUE The argument 'time' ${n}. Received 'positive integer'`;

describe("order", () => {
  it("runs due timers by run time, then creation", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const log: string[] = [];
    setTimeout(() => log.push("omitted"));
    setTimeout(() => log.push("zero"), 0);
    setTimeout(() => log.push("negative"), -5);
    setTimeout(() => log.push("fraction"), 0.5);
    setTimeout(() => log.push("ten a"), 10);
    setTimeout(() => log.push("five"), 5);
    setTimeout(() => log.push("ten b"), 10);
    t.mock.timers.tick(0);
    log.push("tick 0");
    t.mock.timers.tick(1);
    log.push("tick 1");
    t.mock.timers.tick(9);
    assert.deepStrictEqual(log, [
      "omitted",
      "negative",
      "zero",
      "tick 0",
      "fraction",
      "tick 1",
      "five",
      "ten a",
      "ten b",
    ]);
  });

  it("runs timers scheduled by a callback once they are due", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const log: string[] = [];
    setTimeout(() => {
      log.push("outer");
      setTimeout(() => log.push("inner 0"), 0);
      setTimeout(() => log.push("inner 5"), 5);
    }, 10);
    t.mock.timers.tick(10);
    log.push("after 10");
    t.mock.timers.tick(5);
    log.push("after 15");
    t.mock.timers.tick();
    assert.deepStrictEqual(log, ["outer", "inner 0", "after 10", "inner 5", "after 15"]);
  });

  it("passes the trailing arguments", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const log: string[] = [];
    setTimeout((a: string, b: number) => log.push(`${a} ${b}`), 1, "x", 2);
    t.mock.timers.tick(1);
    assert.deepStrictEqual(log, ["x 2"]);
  });
});

describe("intervals", () => {
  it("repeats until cleared", (t) => {
    t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
    const log: string[] = [];
    let n = 0;
    const handle = setInterval(() => {
      n++;
      log.push(`interval ${n}`);
      if (n === 3) clearInterval(handle);
    }, 10);
    setTimeout(() => log.push("timeout 25"), 25);
    t.mock.timers.tick(100);
    assert.deepStrictEqual(log, ["interval 1", "interval 2", "timeout 25", "interval 3"]);
  });

  it("fires once per elapsed period", (t) => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    let n = 0;
    const handle = setInterval(() => n++, 3);
    t.mock.timers.tick(10);
    assert.strictEqual(n, 3);
    clearInterval(handle);
    t.mock.timers.tick(10);
    assert.strictEqual(n, 3);
  });

  it("clears from another callback", (t) => {
    t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
    let n = 0;
    const handle = setInterval(() => n++, 4);
    setTimeout(() => clearInterval(handle), 9);
    t.mock.timers.tick(20);
    assert.strictEqual(n, 2);
  });

  it("leaves intervals alone when only setTimeout is mocked", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let n = 0;
    await new Promise<void>((resolve) => {
      const handle = setInterval(() => {
        n++;
        clearInterval(handle);
        resolve();
      }, 5);
    });
    assert.strictEqual(n, 1);
  });
});

describe("runAll", () => {
  it("ticks to the last queued timer", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const log: string[] = [];
    setTimeout(() => {
      log.push("a");
      setTimeout(() => log.push("b"), 100);
    }, 10);
    setTimeout(() => log.push("c"), 20);
    t.mock.timers.runAll();
    log.push("first runAll");
    t.mock.timers.runAll();
    log.push("second runAll");
    t.mock.timers.runAll();
    assert.deepStrictEqual(log, ["a", "c", "first runAll", "b", "second runAll"]);
  });
});

describe("clock", () => {
  it("starts at now and moves with setTime", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"], now: 1000 });
    const log: string[] = [];
    setTimeout(() => log.push("a"), 10);
    t.mock.timers.setTime(5000);
    setTimeout(() => log.push("b"), 10);
    t.mock.timers.tick(1);
    log.push("tick 1");
    t.mock.timers.tick(9);
    t.mock.timers.setTime();
    setTimeout(() => log.push("c"), 1);
    t.mock.timers.tick(1);
    assert.deepStrictEqual(log, ["a", "tick 1", "b", "c"]);
  });

  it("takes now from a Date", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"], now: new Date(2000) });
    const log: string[] = [];
    setTimeout(() => log.push("a"), 10);
    t.mock.timers.setTime(2005);
    t.mock.timers.tick(4);
    log.push("tick 4");
    t.mock.timers.tick(1);
    assert.deepStrictEqual(log, ["tick 4", "a"]);
  });
});

describe("handles", () => {
  it("ref, unref and refresh leave a mock timer as it is", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let fired = 0;
    const handle = setTimeout(() => fired++, 5);
    assert.strictEqual(handle.hasRef(), true);
    assert.strictEqual(handle.unref().hasRef(), true);
    assert.strictEqual(handle.ref().hasRef(), true);
    handle.refresh();
    t.mock.timers.tick(5);
    t.mock.timers.tick(5);
    assert.strictEqual(fired, 1);
  });

  it("clearTimeout of a mock timer", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let fired = 0;
    const handle = setTimeout(() => fired++, 5);
    clearTimeout(handle);
    t.mock.timers.tick(10);
    assert.strictEqual(fired, 0);
  });

  it("a real timer made before enable keeps running", async (t) => {
    let fired = 0;
    const done = new Promise<void>((resolve) => {
      const real = setTimeout(() => {
        fired++;
        resolve();
      }, 5);
      t.mock.timers.enable({ apis: ["setTimeout"] });
      // The mocked clearTimeout leaves the real timer armed.
      clearTimeout(real);
      assert.strictEqual(real.hasRef(), true);
    });
    await done;
    assert.strictEqual(fired, 1);
  });
});

describe("errors", () => {
  it("throws Node's errors", (t) => {
    const got: string[] = [];
    got.push(failure(() => t.mock.timers.tick(1)));
    got.push(failure(() => t.mock.timers.runAll()));
    got.push(failure(() => t.mock.timers.setTime(-1)));
    got.push(failure(() => t.mock.timers.setTime(5)));
    got.push(failure(() => t.mock.timers.enable({ apis: ["setTimeout"], now: -1 })));
    got.push(failure(() => t.mock.timers.enable({ apis: ["setTimeout"], now: NaN })));
    got.push(failure(() => t.mock.timers.reset()));
    t.mock.timers.enable({ apis: ["setTimeout"] });
    got.push(failure(() => t.mock.timers.enable({ apis: ["setTimeout"] })));
    got.push(failure(() => t.mock.timers.tick(-1.5)));
    got.push(failure(() => t.mock.timers.tick(-Infinity)));
    got.push(failure(() => t.mock.timers.tick(0)));
    assert.deepStrictEqual(got, [
      NOT_ENABLED,
      NOT_ENABLED,
      negative("-1"),
      NOT_ENABLED,
      negative("-1"),
      "TypeError ERR_INVALID_ARG_VALUE The argument 'now' epoch must be a positive integer received NaN. Received NaN",
      "no throw",
      "Error ERR_INVALID_STATE Invalid state: MockTimers is already enabled!",
      negative("-1.5"),
      negative("-Infinity"),
      "no throw",
    ]);
  });

  it("a throwing callback stays queued", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let runs = 0;
    setTimeout(() => {
      runs++;
      if (runs === 1) throw new Error("boom");
    }, 5);
    assert.throws(() => t.mock.timers.tick(5), { message: "boom" });
    t.mock.timers.tick(0);
    t.mock.timers.tick(0);
    assert.strictEqual(runs, 2);
  });
});

describe("imports", () => {
  it("globalThis.setTimeout is mocked", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const log: string[] = [];
    globalThis.setTimeout(() => log.push("timeout"), 5);
    t.mock.timers.tick(5);
    assert.deepStrictEqual(log, ["timeout"]);
  });

  it("named and namespace imports keep the loop's timers", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const log: string[] = [];
    await Promise.all([
      sleep(5).then(() => {
        log.push("named promise");
      }),
      new Promise<void>((resolve) =>
        namedSetTimeout(() => {
          log.push("named");
          resolve();
        }, 2),
      ),
      new Promise<void>((resolve) =>
        timersNamespace.setTimeout(() => {
          log.push("namespace");
          resolve();
        }, 3),
      ),
    ]);
    t.mock.timers.tick(10);
    assert.deepStrictEqual(log, ["named", "namespace", "named promise"]);
  });
});

describe("trackers", () => {
  it("leaves t.mock.timers enabled", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    setTimeout(() => {
      throw new Error("never runs");
    }, 1);
  });

  it("the previous test's timers were reset", async () => {
    let fired = false;
    await new Promise<void>((resolve) =>
      setTimeout(() => {
        fired = true;
        resolve();
      }, 1),
    );
    assert.strictEqual(fired, true);
  });

  it("t.mock takes setTimeout over from mock and gives it back", (t) => {
    const log: string[] = [];
    mock.timers.enable({ apis: ["setTimeout"] });
    setTimeout(() => log.push("module"), 5);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    setTimeout(() => log.push("test"), 5);
    mock.timers.tick(5);
    log.push("module ticked");
    t.mock.timers.tick(5);
    t.mock.timers.reset();
    setTimeout(() => log.push("module again"), 1);
    mock.timers.tick(1);
    mock.timers.reset();
    assert.deepStrictEqual(log, ["module", "module ticked", "test", "module again"]);
  });

  it("mock.reset() resets mock.timers", () => {
    mock.timers.enable({ apis: ["setInterval"] });
    mock.reset();
    assert.strictEqual(failure(() => mock.timers.tick(1)), NOT_ENABLED);
  });
});

test("timers outside node:test bodies", () => {
  // A fresh enable after reset starts the clock at 0 again.
  mock.timers.enable({ apis: ["setTimeout"], now: 100 });
  mock.timers.reset();
  mock.timers.enable({ apis: ["setTimeout"] });
  const log: string[] = [];
  setTimeout(() => log.push("at 1"), 1);
  mock.timers.tick(1);
  mock.timers.reset();
  assert.deepStrictEqual(log, ["at 1"]);
});
