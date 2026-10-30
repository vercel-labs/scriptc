/// <reference path="./assert.d.ts" />

/* node:assert — the static assertion surface. The module object IS a
 * callable function (`assert(x)` is `assert.ok(x)`), so the declaration
 * is the callable-namespace `export =` shape and BOTH `import assert
 * from "node:assert"` and `const assert = require("assert")` bind the
 * callable; named imports take the members. Failures throw
 * AssertionError (name "AssertionError", code "ERR_ASSERTION" — catch and
 * read .name/.message/.code). strictEqual/deepStrictEqual compare with
 * Object.is over scalars; deepStrictEqual compares composites
 * structurally per their static types. The messages here are plain
 * strings (Node accepts Errors — that form fences per site), and the
 * shallow legacy pair (equal/notEqual) follows Node's == coercions for
 * primitive and primitive-union operands, including Node v24's NaN
 * exception. deepEqual/notDeepEqual remain declared-but-fenced;
 * assert/strict's loose names alias the strict forms and lower. */
/* node:test — the in-process test runner (prefix-only in Node too:
 * require("test") is MODULE_NOT_FOUND). test/it register tests (sync and
 * async bodies, skip/todo/only options and method twins), describe/suite
 * group them (bodies run at registration, Node's collection phase),
 * before/after/beforeEach/afterEach hook the enclosing suite, and the
 * TestContext argument carries subtests (t.test), t.skip/t.todo,
 * t.diagnostic, and t.assert. mock/run/snapshot are DECLARED so real
 * suites typecheck but fence at their use sites (no lowering). */
declare module "node:test" {
  type TestFn = (t: TestContext) => void | Promise<void>;
  type SuiteFn = (s: SuiteContext) => void;
  type HookFn = (c: TestContext | SuiteContext) => void | Promise<void>;
  /* The describe/suite callback's context, and the before/after hook
   * context of a suite. */
  interface SuiteContext {
    readonly name: string;
    readonly fullName: string;
    readonly filePath: string | undefined;
    readonly attempt: number;
    readonly passed: boolean;
    diagnostic(message: string): void;
  }
  interface TestOptions {
    skip?: boolean | string;
    todo?: boolean | string;
    only?: boolean;
    concurrency?: number | boolean;
    timeout?: number;
    plan?: number;
  }
  interface TestContext {
    readonly name: string;
    readonly fullName: string;
    readonly filePath: string | undefined;
    readonly attempt: number;
    readonly passed: boolean;
    readonly workerId: number | undefined;
    readonly tags: readonly string[];
    readonly assert: TestContextAssert;
    readonly mock: MockTracker;
    test(name?: string, fn?: TestFn): Promise<void>;
    test(name?: string, options?: TestOptions, fn?: TestFn): Promise<void>;
    test(options?: TestOptions, fn?: TestFn): Promise<void>;
    test(fn?: TestFn): Promise<void>;
    skip(message?: string): void;
    todo(message?: string): void;
    diagnostic(message: string): void;
    plan(count: number): void;
    after(fn: HookFn): void;
    before(fn: HookFn): void;
    beforeEach(fn: HookFn): void;
    afterEach(fn: HookFn): void;
  }
  interface AssertSnapshotOptions {
    readonly serializers?: ReadonlyArray<(value: any) => any> | undefined;
  }
  interface TestContextAssert {
    snapshot(value: any, options?: AssertSnapshotOptions): void;
    fileSnapshot(value: any, path: string, options?: AssertSnapshotOptions): void;
    ok(value: unknown, message?: string): void;
    strictEqual(actual: unknown, expected: unknown, message?: string): void;
    notStrictEqual(actual: unknown, expected: unknown, message?: string): void;
    deepStrictEqual(actual: unknown, expected: unknown, message?: string): void;
    notDeepStrictEqual(actual: unknown, expected: unknown, message?: string): void;
    equal(actual: unknown, expected: unknown, message?: string): void;
    notEqual(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    notDeepEqual(actual: unknown, expected: unknown, message?: string): void;
    fail(message?: string): never;
    throws(fn: () => unknown, expected?: unknown, message?: string): void;
    match(value: string, regExp: RegExp, message?: string): void;
    doesNotMatch(value: string, regExp: RegExp, message?: string): void;
  }
  /* The name, options and function are each optional, as in Node: a test
   * without a name takes the function's name, or "<anonymous>". */
  function test(name?: string, fn?: TestFn): Promise<void>;
  function test(name?: string, options?: TestOptions, fn?: TestFn): Promise<void>;
  function test(options?: TestOptions, fn?: TestFn): Promise<void>;
  function test(fn?: TestFn): Promise<void>;
  namespace test {
    function skip(name?: string, fn?: TestFn): Promise<void>;
    function skip(name?: string, options?: TestOptions, fn?: TestFn): Promise<void>;
    function skip(options?: TestOptions, fn?: TestFn): Promise<void>;
    function skip(fn?: TestFn): Promise<void>;
    function todo(name?: string, fn?: TestFn): Promise<void>;
    function todo(name?: string, options?: TestOptions, fn?: TestFn): Promise<void>;
    function todo(options?: TestOptions, fn?: TestFn): Promise<void>;
    function todo(fn?: TestFn): Promise<void>;
    function only(name?: string, fn?: TestFn): Promise<void>;
    function only(name?: string, options?: TestOptions, fn?: TestFn): Promise<void>;
    function only(options?: TestOptions, fn?: TestFn): Promise<void>;
    function only(fn?: TestFn): Promise<void>;
  }
  const it: typeof test;
  function describe(name?: string, fn?: SuiteFn): void;
  function describe(name?: string, options?: TestOptions, fn?: SuiteFn): void;
  function describe(options?: TestOptions, fn?: SuiteFn): void;
  function describe(fn?: SuiteFn): void;
  namespace describe {
    function skip(name?: string, fn?: SuiteFn): void;
    function skip(name?: string, options?: TestOptions, fn?: SuiteFn): void;
    function skip(options?: TestOptions, fn?: SuiteFn): void;
    function skip(fn?: SuiteFn): void;
    function todo(name?: string, fn?: SuiteFn): void;
    function todo(name?: string, options?: TestOptions, fn?: SuiteFn): void;
    function todo(options?: TestOptions, fn?: SuiteFn): void;
    function todo(fn?: SuiteFn): void;
    function only(name?: string, fn?: SuiteFn): void;
    function only(name?: string, options?: TestOptions, fn?: SuiteFn): void;
    function only(options?: TestOptions, fn?: SuiteFn): void;
    function only(fn?: SuiteFn): void;
  }
  const suite: typeof describe;
  function before(fn: HookFn): void;
  function after(fn: HookFn): void;
  function beforeEach(fn: HookFn): void;
  function afterEach(fn: HookFn): void;
  /* The mock function surface: mock.fn, mock.method and their t.mock
   * twins, the tracker's restoreAll and reset, and the calls log and the
   * implementation controls on fn.mock. */
  interface MockFunctionCall<
    F extends Function,
    ReturnType = F extends (...args: any) => infer T ? T : unknown,
    Args = F extends (...args: infer Y) => any ? Y : unknown[],
  > {
    arguments: Args;
    error: unknown | undefined;
    result: ReturnType | undefined;
    this: unknown;
  }
  interface MockFunctionContext<F extends Function> {
    readonly calls: MockFunctionCall<F>[];
    callCount(): number;
    mockImplementation(implementation: F): void;
    mockImplementationOnce(implementation: F, onCall?: number): void;
    resetCalls(): void;
    restore(): void;
  }
  type Mock<F extends Function> = F & { mock: MockFunctionContext<F> };
  interface MockFunctionOptions {
    times?: number;
  }
  type FunctionPropertyNames<T> = {
    [K in keyof T]: T[K] extends Function ? K : never;
  }[keyof T];
  interface MockTracker {
    fn<F extends Function = (...args: any[]) => undefined>(original?: F): Mock<F>;
    fn<F extends Function = (...args: any[]) => undefined, Implementation extends Function = F>(
      original?: F,
      implementation?: Implementation,
    ): Mock<F | Implementation>;
    method<MockedObject extends object, MethodName extends FunctionPropertyNames<MockedObject>>(
      object: MockedObject,
      methodName: MethodName,
      options?: MockFunctionOptions,
    ): MockedObject[MethodName] extends Function ? Mock<MockedObject[MethodName]> : never;
    method<
      MockedObject extends object,
      MethodName extends FunctionPropertyNames<MockedObject>,
      Implementation extends Function,
    >(
      object: MockedObject,
      methodName: MethodName,
      implementation: Implementation,
      options?: MockFunctionOptions,
    ): MockedObject[MethodName] extends Function
      ? Mock<MockedObject[MethodName] | Implementation>
      : never;
    reset(): void;
    restoreAll(): void;
    readonly timers: MockTimers;
  }
  interface MockTimersOptions {
    apis: ReadonlyArray<"setInterval" | "setTimeout" | "setImmediate" | "Date">;
    now?: number | Date | undefined;
  }
  interface MockTimers {
    enable(options?: MockTimersOptions): void;
    setTime(milliseconds?: number): void;
    reset(): void;
    tick(milliseconds?: number): void;
    runAll(): void;
    [Symbol.dispose](): void;
  }
  const mock: MockTracker;
  /* The context of the test, suite or hook running in the current async
   * context; undefined outside one. */
  function getTestContext(): TestContext | SuiteContext | undefined;
  /* Declared for typechecking only — every use fences (no lowering).
   * `assert` is the module-level custom-assertion registry (v24's
   * `const { assert } = require('node:test')`), not TestContext.assert. */
  const assert: { register(name: string, fn: (...args: unknown[]) => unknown): void };
  function run(options?: unknown): unknown;
  function snapshot(...args: unknown[]): unknown;
  export {
    test,
    it,
    describe,
    suite,
    before,
    after,
    beforeEach,
    afterEach,
    mock,
    assert,
    getTestContext,
    run,
    snapshot,
    TestContext,
    SuiteContext,
    TestOptions,
    Mock,
    MockFunctionContext,
    MockFunctionCall,
    MockTracker,
    MockTimers,
    MockTimersOptions,
  };
  export default test;
}
