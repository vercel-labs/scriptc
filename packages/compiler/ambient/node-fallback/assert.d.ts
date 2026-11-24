/// <reference path="./assert-strict.d.ts" />

declare module "assert" {
  function assert(value: unknown, message?: string | Error): void;
  namespace assert {
    interface AssertionErrorOptions {
      message?: string | undefined;
      actual?: unknown;
      expected?: unknown;
      operator?: string | undefined;
      stackStartFn?: Function | undefined;
      diff?: "simple" | "full" | undefined;
    }
    class AssertionError extends Error {
      constructor(options: AssertionErrorOptions);
      actual: unknown;
      expected: unknown;
      generatedMessage: boolean;
      code: "ERR_ASSERTION";
      operator: string;
    }
    function ok(value: unknown, message?: string | Error): void;
    function strictEqual(actual: unknown, expected: unknown, message?: string | Error): void;
    function notStrictEqual(actual: unknown, expected: unknown, message?: string | Error): void;
    function deepStrictEqual(actual: unknown, expected: unknown, message?: string | Error): void;
    function notDeepStrictEqual(actual: unknown, expected: unknown, message?: string | Error): void;
    function partialDeepStrictEqual(
      actual: unknown,
      expected: unknown,
      message?: string | Error,
    ): void;
    function equal(actual: unknown, expected: unknown, message?: string | Error): void;
    function notEqual(actual: unknown, expected: unknown, message?: string | Error): void;
    function deepEqual(actual: unknown, expected: unknown, message?: string | Error): void;
    function notDeepEqual(actual: unknown, expected: unknown, message?: string | Error): void;
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
    interface AssertOptions {
      diff?: "simple" | "full" | undefined;
      strict?: boolean | undefined;
      skipPrototype?: boolean | undefined;
    }
    type AssertMethodNames =
      | "deepEqual"
      | "deepStrictEqual"
      | "doesNotMatch"
      | "doesNotReject"
      | "doesNotThrow"
      | "equal"
      | "fail"
      | "ifError"
      | "match"
      | "notDeepEqual"
      | "notDeepStrictEqual"
      | "notEqual"
      | "notStrictEqual"
      | "ok"
      | "partialDeepStrictEqual"
      | "rejects"
      | "strictEqual"
      | "throws";
    interface Assert extends Pick<typeof assert, AssertMethodNames> {}
    interface AssertStrict extends Pick<typeof strict, AssertMethodNames> {}
    const Assert: {
      new (options?: AssertOptions & { strict?: true | undefined }): AssertStrict;
      new (options: AssertOptions): Assert;
    };
  }
  export = assert;
}

declare module "node:assert" {
  import assert = require("assert");
  export = assert;
}
