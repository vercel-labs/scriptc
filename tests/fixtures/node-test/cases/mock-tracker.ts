// MockTracker.restoreAll and reset: every mock the tracker made goes back to
// its original and is forgotten, so a second call is a no-op; a forgotten
// mock can still be used and restored itself. The module's `mock` and a
// test's t.mock are cancelled.
import assert from "node:assert";
import { mock, test } from "node:test";

test("restoreAll restores every mock and forgets them", () => {
  const obj = { a: () => "a", b: () => "b" };
  const a = mock.method(obj, "a", () => "A");
  const b = mock.method(obj, "b", () => "B");
  const f = mock.fn((x: number) => x + 1);
  f.mock.mockImplementation((x) => x + 2);
  assert.strictEqual(`${obj.a()}${obj.b()}${f(1)}`, "AB3");
  mock.restoreAll();
  assert.strictEqual(`${obj.a()}${obj.b()}${f(1)}`, "ab2");
  // A forgotten mock is still usable and restores itself.
  assert.strictEqual(obj.a(), "a");
  a.mock.restore();
  assert.strictEqual(obj.a(), "a");
  mock.restoreAll();
});

test("reset restores every mock and forgets them", () => {
  const obj = { a: () => "a" };
  const a = mock.method(obj, "a", () => "A");
  assert.strictEqual(obj.a(), "A");
  mock.reset();
  assert.strictEqual(obj.a(), "a");
  a.mock.restore();
  mock.reset();
});

const shared = { a: () => "a" };

test("t.mock is reset when the test ends", (t) => {
  t.mock.method(shared, "a", () => "A");
  const f = t.mock.fn(() => 1);
  f.mock.mockImplementation(() => 2);
  assert.strictEqual(`${shared.a()}${f()}`, "A2");
});

test("t.mock mocks were restored", () => {
  assert.strictEqual(shared.a(), "a");
});

test("restoreAll on t.mock", (t) => {
  const obj = { a: () => "a" };
  t.mock.method(obj, "a", () => "A");
  assert.strictEqual(obj.a(), "A");
  t.mock.restoreAll();
  assert.strictEqual(obj.a(), "a");
  t.mock.reset();
});
