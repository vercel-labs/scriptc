import { arrayOf, BOOL, DYN, F64, STRING, TESTCTX_T, VOID } from "../ir.js";
import { defineLibFnSignatures } from "./shared.js";

/** The test builtin call slots. */
export const testSignatures = defineLibFnSignatures({
  // node:test (scr_test.c). Bodies are program-dependent closures (0 or
  // 1 testCtx param, void or Promise<void> result — the spoke pinned the
  // shape): null slots. sub's result is the settled Promise<void> the
  // await consumes.
  /** node:test (scr_test.c — linked only when one of these appears on
   * the IR; moduleUsesNodeTest is the switch, and the main epilogue asks
   * scr_test_exit_code() for the process's exit status). Strings are
   * BORROWED, callbacks MOVE. register/suite/hook attach to the runner
   * tree (register: name, mode 0|1|2 run/skip/todo, directive message ""
   * = none, cb or absent via registerEmpty, flags 1 async | 2 takes-ctx
   * | 4 only | 32 an explicit only: false, "file:line:col"); suite runs its body AT registration
   * (Node's collection phase). sub is t.test — runs the subtest INLINE
   * on the runner fiber and returns the settled promise the await
   * consumes. ctxSkip/ctxTodo mark the running test; ctxDiagnostic
   * queues an ℹ line; ctxName reads t.name. Every registration keeps
   * the loop-run emitted (usesTimers) so the runner fiber drains. */
  // The trailing three are the { plan, timeout, concurrency } options (plan
  // -1 without one; timeout read under flag 8; concurrency read under flag
  // 16, -1 for true). An out-of-range timeout or concurrency throws. The
  // last argument is the { tags } list (a dyn array of strings, undefined
  // without the option).
  "test.register": {
    argTypes: [STRING, F64, STRING, null, F64, STRING, F64, F64, F64, DYN, DYN],
    result: VOID,
  },
  "test.registerEmpty": {
    argTypes: [STRING, F64, STRING, F64, STRING, F64, F64, F64, DYN, DYN],
    result: VOID,
  },
  // The suite body takes no parameters or its SuiteContext (flag 2).
  "test.suite": {
    argTypes: [STRING, F64, STRING, null, STRING, F64, F64, F64, DYN, DYN],
    result: VOID,
  },
  // The trailing string is the hook call's "file:line:col".
  "test.hook": { argTypes: [F64, null, F64, STRING], result: VOID },
  "test.sub": {
    argTypes: [TESTCTX_T, STRING, F64, STRING, null, F64, STRING, F64, F64, F64, DYN, DYN],
    result: { kind: "promise", inner: VOID },
  },
  "test.subEmpty": {
    argTypes: [TESTCTX_T, STRING, F64, STRING, F64, STRING, F64, F64, F64, DYN, DYN],
    result: VOID,
  },
  "test.ctxSkip": { argTypes: [TESTCTX_T, STRING], result: VOID },
  "test.ctxTodo": { argTypes: [TESTCTX_T, STRING], result: VOID },
  "test.ctxDiagnostic": { argTypes: [TESTCTX_T, STRING], result: VOID },
  "test.ctxLog": { argTypes: [TESTCTX_T, STRING], result: VOID },
  // t.signal: the test's AbortSignal handle (created on first read; the
  // abortSignal runtime feature links the unit), and t.error: Node's
  // ERR_TEST_FAILURE wrapper over the failure, or null.
  "test.ctxSignal": { argTypes: [TESTCTX_T], result: DYN },
  "test.ctxError": { argTypes: [TESTCTX_T], result: DYN },
  /** mock.getter/mock.setter's descriptor along the prototype chain, and
   * Node's check that it carries the mocked accessor. */
  "test.accessorDescriptor": { argTypes: [DYN, DYN], result: DYN },
  "test.accessorRequire": { argTypes: [DYN, BOOL], result: VOID },
  /** node:test's assert.register(name, fn) and the call of a registered
   * assertion on a TestContext (its arguments a dyn array). */
  "test.assertRegister": { argTypes: [STRING, DYN], result: VOID },
  "test.ctxCustomAssert": { argTypes: [TESTCTX_T, STRING, DYN], result: DYN },
  // t.tags: the flattened tag set (a frozen array of strings).
  "test.ctxTags": { argTypes: [TESTCTX_T], result: arrayOf(STRING) },
  "test.ctxName": { argTypes: [TESTCTX_T], result: STRING },
  "test.ctxFullName": { argTypes: [TESTCTX_T], result: STRING },
  // t.passed, and t.workerId's Number(NODE_TEST_WORKER_ID) with 0 for
  // undefined.
  "test.ctxPassed": { argTypes: [TESTCTX_T], result: BOOL },
  "test.workerId": { argTypes: [], result: F64 },
  // getTestContext(): whether a test, suite or hook is running in the
  // current async context, and that context.
  "test.hasContext": { argTypes: [], result: BOOL },
  "test.context": { argTypes: [], result: TESTCTX_T },
  // t.before/t.after/t.beforeEach/t.afterEach (which: 0 before, 1 after,
  // 2 beforeEach, 3 afterEach); a throwing t.before is captured on the test.
  "test.ctxHook": { argTypes: [TESTCTX_T, F64, null, F64], result: VOID },
  // t.plan(count[, { wait }]) — hasWait says whether the options object
  // carried the property; the count of one t.assert call follows.
  "test.ctxPlan": { argTypes: [TESTCTX_T, F64, BOOL, F64, BOOL], result: VOID },
  "test.ctxRunOnly": { argTypes: [TESTCTX_T, BOOL], result: VOID },
  "test.ctxWaitFor": { argTypes: [TESTCTX_T, DYN, BOOL, F64, BOOL, F64], result: DYN },
  "test.ctxCount": { argTypes: [TESTCTX_T], result: VOID },
  // The first `t.assert` read fixes this context's assertion set (Node
  // builds the test's assertion object from the registry at that moment).
  "test.ctxAssertTouch": { argTypes: [TESTCTX_T], result: VOID },
  // The mock trackers: the module's `mock` and t.mock keep each mock's
  // restore closure (moved) for restoreAll and reset.
  // mock.fn's and mock.method's { times }: Node's non-negative-integer
  // validation, which throws ERR_OUT_OF_RANGE and answers the count.
  "test.mockTimes": { argTypes: [F64], result: F64 },
  "test.mockTrack": { argTypes: [{ kind: "func", params: [], ret: VOID }], result: VOID },
  "test.mockRestoreAll": { argTypes: [], result: VOID },
  "test.mockReset": { argTypes: [], result: VOID },
  "test.ctxMockTrack": {
    argTypes: [TESTCTX_T, { kind: "func", params: [], ret: VOID }],
    result: VOID,
  },
  "test.ctxMockRestoreAll": { argTypes: [TESTCTX_T], result: VOID },
  "test.ctxMockReset": { argTypes: [TESTCTX_T], result: VOID },
  // mock.timers on the module's `mock` and on t.mock. enable takes one
  // code per listed API ('T' setTimeout, 'I' setInterval), the `now`
  // value and its flags (1 given, 2 from a Date). enable, tick, runAll and
  // setTime throw Node's errors; tick and runAll run timer callbacks.
  // t.assert.snapshot and fileSnapshot: the escaped, wrapped serialized
  // value, and the stored value it is compared with (snapshot: the test,
  // the value, the snapshot file; fileSnapshot: the value, the path).
  // Both read or, in update mode, record; missing and unreadable
  // snapshots throw Node's ERR_INVALID_STATE.
  "test.snapshotValue": { argTypes: [STRING], result: STRING },
  "test.ctxSnapshot": { argTypes: [TESTCTX_T, STRING, STRING], result: STRING },
  "test.fileSnapshot": { argTypes: [STRING, STRING], result: STRING },
  // Node's serializeValue over a dyn array of serializers (undefined for
  // the default JSON.stringify(value, null, 2)); a throw becomes Node's
  // "The provided serializers did not generate a string." ERR_INVALID_STATE.
  "test.snapshotSerialize": { argTypes: [DYN, DYN], result: DYN },
  // snapshot.setDefaultSnapshotSerializers(serializers): the list is a
  // checked-dynamic array of serializer functions.
  "test.snapshotSetDefaultSerializers": { argTypes: [DYN], result: VOID },
  // snapshot.setResolveSnapshotPath(fn): a (path: string) => string closure
  // moves in; test.snapshotPath asks a test file's snapshot path (+1).
  "test.snapshotSetResolvePath": { argTypes: [null], result: VOID },
  "test.snapshotPath": { argTypes: [STRING], result: STRING },
  "test.mockTimersEnable": { argTypes: [STRING, F64, F64], result: VOID },
  "test.mockTimersTick": { argTypes: [F64], result: VOID },
  "test.mockTimersRunAll": { argTypes: [], result: VOID },
  "test.mockTimersReset": { argTypes: [], result: VOID },
  "test.mockTimersSetTime": { argTypes: [F64], result: VOID },
  "test.ctxMockTimersEnable": { argTypes: [TESTCTX_T, STRING, F64, F64], result: VOID },
  "test.ctxMockTimersTick": { argTypes: [TESTCTX_T, F64], result: VOID },
  "test.ctxMockTimersRunAll": { argTypes: [TESTCTX_T], result: VOID },
  "test.ctxMockTimersReset": { argTypes: [TESTCTX_T], result: VOID },
  "test.ctxMockTimersSetTime": { argTypes: [TESTCTX_T, F64], result: VOID },
});
