/// <reference path="./assert.d.ts" />

/* node:assert/strict — the same surface with the loose names bound to the
 * strict comparisons (equal IS strictEqual, ...), exactly Node's aliasing;
 * the module object is callable like assert's. */
declare module "assert/strict" {
  function strict(value: unknown, message?: string | Error): void;
  namespace strict {
    function ok(value: unknown, message?: string | Error): void;
    function equal(actual: unknown, expected: unknown, message?: string | Error): void;
    function notEqual(actual: unknown, expected: unknown, message?: string | Error): void;
    function deepEqual(actual: unknown, expected: unknown, message?: string | Error): void;
    function notDeepEqual(actual: unknown, expected: unknown, message?: string | Error): void;
    function strictEqual(actual: unknown, expected: unknown, message?: string | Error): void;
    function notStrictEqual(actual: unknown, expected: unknown, message?: string | Error): void;
    function deepStrictEqual(actual: unknown, expected: unknown, message?: string | Error): void;
    function notDeepStrictEqual(actual: unknown, expected: unknown, message?: string | Error): void;
    function partialDeepStrictEqual(
      actual: unknown,
      expected: unknown,
      message?: string | Error,
    ): void;
    function fail(message?: string | Error): never;
    /** @deprecated since v10.0.0 - use fail([message]) or other assert functions instead. */
    function fail(
      actual: unknown,
      expected: unknown,
      message?: string | Error,
      operator?: string,
      stackStartFn?: Function,
    ): never;
    function throws(fn: () => unknown, expected?: unknown, message?: string | Error): void;
    function doesNotThrow(fn: () => unknown, expected?: unknown, message?: string | Error): void;
    function rejects(
      fn: (() => Promise<unknown>) | Promise<unknown>,
      expected?: unknown,
      message?: string | Error,
    ): Promise<void>;
    function doesNotReject(
      fn: (() => Promise<unknown>) | Promise<unknown>,
      expected?: unknown,
      message?: string | Error,
    ): Promise<void>;
    function match(value: string, regExp: RegExp, message?: string | Error): void;
    function doesNotMatch(value: string, regExp: RegExp, message?: string | Error): void;
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
