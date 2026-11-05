/// <reference path="./assert-strict.d.ts" />

declare module "assert" {
  function assert(value: unknown, message?: string): void;
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
    function ok(value: unknown, message?: string): void;
    function strictEqual(actual: unknown, expected: unknown, message?: string): void;
    function notStrictEqual(actual: unknown, expected: unknown, message?: string): void;
    function deepStrictEqual(actual: unknown, expected: unknown, message?: string): void;
    function notDeepStrictEqual(actual: unknown, expected: unknown, message?: string): void;
    function partialDeepStrictEqual(actual: unknown, expected: unknown, message?: string): void;
    function equal(actual: unknown, expected: unknown, message?: string): void;
    function notEqual(actual: unknown, expected: unknown, message?: string): void;
    function deepEqual(actual: unknown, expected: unknown, message?: string): void;
    function notDeepEqual(actual: unknown, expected: unknown, message?: string): void;
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
