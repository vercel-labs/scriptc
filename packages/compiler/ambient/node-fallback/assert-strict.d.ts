/// <reference path="./assert.d.ts" />

/* node:assert/strict — the same surface with the loose names bound to the
 * strict comparisons (equal IS strictEqual, ...), exactly Node's aliasing;
 * the module object is callable like assert's. */
declare module "assert/strict" {
  function strict(value: unknown, message?: string): void;
  namespace strict {
    function ok(value: unknown, message?: string): void;
    function equal(actual: unknown, expected: unknown, message?: string): void;
    function notEqual(actual: unknown, expected: unknown, message?: string): void;
    function deepEqual(actual: unknown, expected: unknown, message?: string): void;
    function notDeepEqual(actual: unknown, expected: unknown, message?: string): void;
    function strictEqual(actual: unknown, expected: unknown, message?: string): void;
    function notStrictEqual(actual: unknown, expected: unknown, message?: string): void;
    function deepStrictEqual(actual: unknown, expected: unknown, message?: string): void;
    function notDeepStrictEqual(actual: unknown, expected: unknown, message?: string): void;
    function partialDeepStrictEqual(actual: unknown, expected: unknown, message?: string): void;
    function fail(message?: string): never;
    function throws(fn: () => unknown, expected?: unknown, message?: string): void;
    function doesNotThrow(fn: () => unknown, expected?: unknown, message?: string): void;
    function rejects(
      fn: (() => Promise<unknown>) | Promise<unknown>,
      expected?: unknown,
      message?: string,
    ): Promise<void>;
    function doesNotReject(
      fn: (() => Promise<unknown>) | Promise<unknown>,
      expected?: unknown,
      message?: string,
    ): Promise<void>;
    function match(value: string, regExp: RegExp, message?: string): void;
    function doesNotMatch(value: string, regExp: RegExp, message?: string): void;
    function ifError(value: unknown): void;
    const strict: typeof import("assert/strict");
    type AssertOptions = import("assert").AssertOptions;
    type Assert = import("assert").Assert;
    type AssertStrict = import("assert").AssertStrict;
    const Assert: typeof import("assert").Assert;
  }
  export = strict;
}

declare module "node:assert/strict" {
  import strict = require("assert/strict");
  export = strict;
}
