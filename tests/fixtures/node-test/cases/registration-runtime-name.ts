// Helpers that register tests and suites with the function they were given:
// Node names each from fn.name at run time, or "<anonymous>" when the
// function has no name.
import { describe, suite, test } from "node:test";

function register(body: () => void): void {
  test(body);
}

function registerEmpty(body: () => void): void {
  test("", body);
}

function registerDescribe(body: () => void): void {
  describe(body);
}

function registerSuite(body: () => void): void {
  suite(body);
}

register(function innerName() {});
register(() => {});
registerEmpty(function namedViaEmpty() {});
registerDescribe(function suiteName() {});
registerSuite(function suiteTwo() {});

test("a later test", () => {});
