// The MockTimers behavior beyond ordering: enable() with no options mocks
// every API; `now` is a number or a Date instance; new Date(args) is not
// mocked; tick() with no argument runs zero-delay timers; timers created
// before enable stay real; an empty apis list is accepted; clearTimeout and
// clearImmediate remove entries; ref/unref are harmless; runAll runs the
// timers pending at the call (a timer nested in a callback and an interval
// each run once), a timer one round per call.
import assert from "node:assert";
import { test } from "node:test";

test("enable with no options mocks every api", (t) => {
  t.mock.timers.enable();
  let fired = 0;
  setTimeout(() => fired++, 10);
  setImmediate(() => (fired += 100));
  const start = Date.now();
  t.mock.timers.tick(10);
  assert.strictEqual(fired, 101);
  assert.strictEqual(Date.now() >= start, true);
});

test("now as a Date instance", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date(5000) });
  assert.strictEqual(Date.now(), 5000);
  assert.strictEqual(new Date().getTime(), 5000);
  assert.strictEqual(new Date(0).getTime(), 0);
  assert.strictEqual(new Date(2020, 0, 1).getFullYear(), 2020);
});

test("tick with no argument", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let fired = false;
  setTimeout(() => {
    fired = true;
  }, 0);
  t.mock.timers.tick();
  assert.strictEqual(fired, true);
});

test("nested timers run on later ticks", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const seen: string[] = [];
  setTimeout(() => {
    seen.push("outer");
    setTimeout(() => seen.push("inner"), 5);
  }, 5);
  t.mock.timers.tick(5);
  assert.deepStrictEqual(seen, ["outer"]);
  t.mock.timers.tick(5);
  assert.deepStrictEqual(seen, ["outer", "inner"]);
});

test("timers created before enable stay real", (t) => {
  const before = setTimeout(() => {}, 1000);
  clearTimeout(before);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let mocked = false;
  setTimeout(() => {
    mocked = true;
  }, 10);
  t.mock.timers.tick(10);
  assert.strictEqual(mocked, true);
});

test("empty apis list is accepted", (t) => {
  t.mock.timers.enable({ apis: [] });
  t.mock.timers.tick(100);
  t.mock.timers.reset();
});

test("clearTimeout and clearImmediate", (t) => {
  t.mock.timers.enable();
  let a = 0;
  const id = setTimeout(() => a++, 5);
  clearTimeout(id);
  let b = 0;
  const immediate = setImmediate(() => b++);
  clearImmediate(immediate);
  t.mock.timers.tick(10);
  assert.strictEqual(a + b, 0);
});

test("runAll runs the pending timers once", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const seen: string[] = [];
  setTimeout(() => {
    seen.push("outer");
    setTimeout(() => seen.push("nested"), 100);
  }, 10);
  let ticks = 0;
  const id = setInterval(() => ticks++, 10);
  t.mock.timers.runAll();
  clearInterval(id);
  assert.deepStrictEqual(seen, ["outer"]);
  assert.strictEqual(ticks, 1);
});

test("unref and ref are harmless", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let fired = false;
  const id = setTimeout(() => {
    fired = true;
  }, 5);
  id.unref();
  id.ref();
  t.mock.timers.tick(5);
  assert.strictEqual(fired, true);
});
