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
  /* Node's callback form: a test or hook that takes (context, done) finishes
   * when it calls done. */
  type DoneFn = (result?: unknown) => void;
  type TestFn = (t: TestContext, done: DoneFn) => void | Promise<void>;
  type SuiteFn = (s: SuiteContext) => void;
  type HookFn = (c: TestContext | SuiteContext, done: DoneFn) => void | Promise<void>;
  /* The describe/suite callback's context, and the before/after hook
   * context of a suite. */
  interface SuiteContext {
    readonly name: string;
    readonly fullName: string;
    readonly filePath: string | undefined;
    readonly attempt: number;
    readonly passed: boolean;
    readonly signal: AbortSignal;
    diagnostic(message: string): void;
    log(message: string, data?: unknown): void;
  }
  interface TestContextPlanOptions {
    /* `true` waits indefinitely for the plan, `false` (the default) checks
     * as soon as the body finishes, a number is the maximum wait. */
    wait?: boolean | number | undefined;
  }
  interface TestOptions {
    skip?: boolean | string;
    todo?: boolean | string;
    only?: boolean;
    concurrency?: number | boolean;
    timeout?: number;
    /* Aborts the run: the test (or the suite and the tests in it) is
     * cancelled with the signal's reason. */
    signal?: AbortSignal;
    plan?: number;
    /* The test passes only if it throws; a reason string behaves as true.
     * Node's matcher forms (RegExp, function, object, Error, { label, match })
     * are not lowered. */
    expectFailure?: boolean | string;
    /* Labels carried by the test and its descendant suites' tests. Values
     * must be non-empty strings; they are lowercased and de-duplicated, and
     * a suite's tags are inherited by every test it contains. */
    tags?: readonly string[];
  }
  interface TestContext {
    readonly name: string;
    readonly fullName: string;
    readonly filePath: string | undefined;
    readonly attempt: number;
    readonly passed: boolean;
    readonly workerId: number | undefined;
    readonly tags: readonly string[];
    /* Aborted when the test times out, is cancelled, or finishes. */
    readonly signal: AbortSignal;
    /* Node's ERR_TEST_FAILURE wrapper over the failure, its `cause` the
     * value the test threw; null while the test has not failed. */
    readonly error: Error | null;
    readonly assert: TestContextAssert;
    readonly mock: MockTracker;
    test(name?: string, fn?: TestFn): Promise<void>;
    test(name?: string, options?: TestOptions, fn?: TestFn): Promise<void>;
    test(options?: TestOptions, fn?: TestFn): Promise<void>;
    test(fn?: TestFn): Promise<void>;
    skip(message?: string): void;
    todo(message?: string): void;
    diagnostic(message: string): void;
    log(message: string, data?: unknown): void;
    plan(count: number, options?: TestContextPlanOptions): void;
    runOnly(shouldRunOnlyTests: boolean): void;
    waitFor<T>(condition: () => T, options?: TestContextWaitForOptions): Promise<Awaited<T>>;
    after(fn: HookFn): void;
    before(fn: HookFn): void;
    beforeEach(fn: HookFn): void;
    afterEach(fn: HookFn): void;
  }
  interface TestContextWaitForOptions {
    interval?: number | undefined;
    timeout?: number | undefined;
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
    function expectFailure(name?: string, fn?: TestFn): Promise<void>;
    function expectFailure(name?: string, options?: TestOptions, fn?: TestFn): Promise<void>;
    function expectFailure(options?: TestOptions, fn?: TestFn): Promise<void>;
    function expectFailure(fn?: TestFn): Promise<void>;
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
    function expectFailure(name?: string, fn?: SuiteFn): void;
    function expectFailure(name?: string, options?: TestOptions, fn?: SuiteFn): void;
    function expectFailure(options?: TestOptions, fn?: SuiteFn): void;
    function expectFailure(fn?: SuiteFn): void;
  }
  const suite: typeof describe;
  function before(fn: HookFn): void;
  function after(fn: HookFn): void;
  function beforeEach(fn: HookFn): void;
  function afterEach(fn: HookFn): void;
  function expectFailure(name?: string, fn?: TestFn): Promise<void>;
  function expectFailure(name?: string, options?: TestOptions, fn?: TestFn): Promise<void>;
  function expectFailure(options?: TestOptions, fn?: TestFn): Promise<void>;
  function expectFailure(fn?: TestFn): Promise<void>;
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
  interface MockMethodOptions extends MockFunctionOptions {
    /* The property is treated as a getter (or a setter); the two are
     * mutually exclusive. */
    getter?: boolean;
    setter?: boolean;
  }
  interface MockTracker {
    fn<F extends Function = (...args: any[]) => undefined>(original?: F): Mock<F>;
    /* The { times } option: the implementation serves that many calls and
     * the next one runs the original. */
    fn<F extends Function = (...args: any[]) => undefined>(
      original: F | undefined,
      options: MockFunctionOptions,
    ): Mock<F>;
    fn<F extends Function = (...args: any[]) => undefined, Implementation extends Function = F>(
      original?: F,
      implementation?: Implementation,
    ): Mock<F | Implementation>;
    fn<F extends Function = (...args: any[]) => undefined, Implementation extends Function = F>(
      original: F | undefined,
      implementation: Implementation | undefined,
      options: MockFunctionOptions,
    ): Mock<F | Implementation>;
    method<MockedObject extends object, MethodName extends FunctionPropertyNames<MockedObject>>(
      object: MockedObject,
      methodName: MethodName,
      options?: MockMethodOptions,
    ): MockedObject[MethodName] extends Function ? Mock<MockedObject[MethodName]> : never;
    method<
      MockedObject extends object,
      MethodName extends FunctionPropertyNames<MockedObject>,
      Implementation extends Function,
    >(
      object: MockedObject,
      methodName: MethodName,
      implementation: Implementation,
      options?: MockMethodOptions,
    ): MockedObject[MethodName] extends Function
      ? Mock<MockedObject[MethodName] | Implementation>
      : never;
    getter<MockedObject extends object, MethodName extends keyof MockedObject>(
      object: MockedObject,
      methodName: MethodName,
      implementation: (...args: any[]) => MockedObject[MethodName],
      options?: MockFunctionOptions,
    ): Mock<() => MockedObject[MethodName]>;
    setter<MockedObject extends object, MethodName extends keyof MockedObject>(
      object: MockedObject,
      methodName: MethodName,
      implementation: (value: MockedObject[MethodName]) => void,
      options?: MockFunctionOptions,
    ): Mock<(value: MockedObject[MethodName]) => void>;
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
  /* The module-level snapshot registry: setDefaultSnapshotSerializers
   * covers the list every snapshot assertion without its own serializers
   * uses, as Node's serializer chain does. setResolveSnapshotPath has no
   * lowering yet. */
  const snapshot: {
    setDefaultSnapshotSerializers(serializers: ReadonlyArray<(value: any) => any>): void;
    setResolveSnapshotPath(fn: (path: string) => string): void;
  };
  export {
    test,
    it,
    describe,
    suite,
    before,
    after,
    beforeEach,
    afterEach,
    expectFailure,
    mock,
    assert,
    getTestContext,
    run,
    snapshot,
    TestContext,
    SuiteContext,
    TestOptions,
    TestContextWaitForOptions,
    Mock,
    MockFunctionContext,
    MockFunctionCall,
    MockTracker,
    MockTimers,
    MockTimersOptions,
  };
  export default test;
}
