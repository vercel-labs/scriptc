// @exit: 1
// Failures from thrown non-Error values print as Node inspects them: a
// string quoted, a number and a boolean as written, negative zero as -0,
// and records, arrays, null and undefined as util.inspect renders them.
import { test } from "node:test";

test("throws a string", () => {
  throw "plain string";
});
test("throws a string with a quote", () => {
  throw "it's quoted";
});
test("throws a number", () => {
  throw 42;
});
test("throws negative zero", () => {
  throw -0;
});
test("throws a boolean", () => {
  throw false;
});
test("throws a record", () => {
  throw { code: 42, nested: { list: [1, 2] } };
});
test("throws an array", () => {
  throw [1, "two", { three: 3 }];
});
test("throws null", () => {
  throw null;
});
test("throws undefined", () => {
  throw undefined;
});
