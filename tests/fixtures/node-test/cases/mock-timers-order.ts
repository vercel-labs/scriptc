import assert from "node:assert";
import { test } from "node:test";

test("setTimeout order, args and nesting", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const order: string[] = [];
  setTimeout((a: number, b: string) => {
    order.push(`a${a}${b}`);
    setTimeout(() => { order.push("nested"); }, 5);
  }, 10, 1, "x");
  setTimeout(() => { order.push("b"); }, 10);
  setTimeout(() => { order.push("c"); }, 5);
  t.mock.timers.tick(5);
  assert.deepStrictEqual(order, ["c"]);
  t.mock.timers.tick(5);
  assert.deepStrictEqual(order, ["c", "a1x", "b"]);
  t.mock.timers.tick(5);
  assert.deepStrictEqual(order, ["c", "a1x", "b", "nested"]);
});

test("intervals and clearInterval", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let n = 0;
  const id = setInterval(() => { n++; }, 10);
  t.mock.timers.tick(35);
  assert.strictEqual(n, 3);
  clearInterval(id);
  t.mock.timers.tick(50);
  assert.strictEqual(n, 3);
});

test("runAll runs pending timers in order", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const seen: number[] = [];
  setTimeout(() => { seen.push(1); }, 100);
  setTimeout(() => { seen.push(2); }, 50);
  t.mock.timers.runAll();
  assert.deepStrictEqual(seen, [2, 1]);
});

test("setImmediate", (t) => {
  t.mock.timers.enable({ apis: ["setImmediate"] });
  const seen: string[] = [];
  setImmediate(() => { seen.push("imm"); });
  assert.deepStrictEqual(seen, []);
  t.mock.timers.tick(0);
  assert.deepStrictEqual(seen, ["imm"]);
});

test("Date and setTime", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1000 });
  assert.strictEqual(Date.now(), 1000);
  t.mock.timers.setTime(5000);
  assert.strictEqual(Date.now(), 5000);
  assert.strictEqual(new Date().getTime(), 5000);
});

test("Date and setTimeout advance together", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  const seen: number[] = [];
  setTimeout(() => { seen.push(Date.now()); }, 100);
  t.mock.timers.tick(100);
  assert.deepStrictEqual(seen, [100]);
  t.mock.timers.setTime(300);
  assert.strictEqual(Date.now(), 300);
});

test("enable twice is invalid state", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  assert.throws(() => t.mock.timers.enable({ apis: ["setTimeout"] }), { code: "ERR_INVALID_STATE" });
});
