import { InternalCompilerError } from "../../errors.js";
import type { LibCallExpr, LlValue, LlvmEmitterContext } from "./expr-context.js";
import { abiValue, callRuntime, finishRuntimeCall, ptr } from "./lib-abi.js";

export function emitTestLibCall(host: LlvmEmitterContext, e: LibCallExpr): LlValue {
  const args = e.args.map((arg) => host.emitExpr(arg)),
    a = args.map((arg) => abiValue(host, arg));
  host.usesTimers = true;
  switch (e.fn) {
    case "test.register":
      host.toHeap(args[3]!);
      return finishRuntimeCall(host, e, "scr_test_register", a);
    case "test.registerEmpty":
      return finishRuntimeCall(host, e, "scr_test_register", [
        ...a.slice(0, 3),
        ptr(),
        ...a.slice(3),
      ]);
    case "test.suite":
      host.toHeap(args[3]!);
      return finishRuntimeCall(host, e, "scr_test_suite", a);
    case "test.hook":
      host.toHeap(args[1]!);
      return finishRuntimeCall(host, e, "scr_test_hook", a);
    case "test.sub":
      host.toHeap(args[4]!);
      return finishRuntimeCall(host, e, "scr_test_sub", a);
    case "test.subEmpty": {
      const promise = callRuntime(host, "scr_test_sub", "ptr", [
        ...a.slice(0, 4),
        ptr(),
        ...a.slice(4),
      ]);
      host.emitPendingCheck();
      callRuntime(host, "scr_promise_release", "void", [ptr(promise)]);
      return { name: "", type: e.type };
    }
    case "test.ctxSkip":
      return finishRuntimeCall(host, e, "scr_test_ctx_skip", a);
    case "test.ctxTodo":
      return finishRuntimeCall(host, e, "scr_test_ctx_todo", a);
    case "test.ctxDiagnostic":
      return finishRuntimeCall(host, e, "scr_test_ctx_diagnostic", a);
    case "test.ctxName":
      return finishRuntimeCall(host, e, "scr_test_ctx_name", a);
    case "test.ctxFullName":
      return finishRuntimeCall(host, e, "scr_test_ctx_full_name", a);
    case "test.ctxPassed":
      return finishRuntimeCall(host, e, "scr_test_ctx_passed", a);
    case "test.workerId":
      return finishRuntimeCall(host, e, "scr_test_worker_id", a);
    case "test.hasContext":
      return finishRuntimeCall(host, e, "scr_test_has_context", a);
    case "test.context":
      return finishRuntimeCall(host, e, "scr_test_context", a);
    case "test.ctxHook":
      host.toHeap(args[2]!);
      return finishRuntimeCall(host, e, "scr_test_ctx_hook", a);
    case "test.ctxPlan":
      return finishRuntimeCall(host, e, "scr_test_ctx_plan", a);
    case "test.ctxCount":
      return finishRuntimeCall(host, e, "scr_test_ctx_count", a);
    case "test.mockTrack":
      host.toHeap(args[0]!);
      return finishRuntimeCall(host, e, "scr_test_mock_track", a);
    case "test.mockRestoreAll":
      return finishRuntimeCall(host, e, "scr_test_mock_restore_all", a);
    case "test.mockReset":
      return finishRuntimeCall(host, e, "scr_test_mock_reset", a);
    case "test.ctxMockTrack":
      host.toHeap(args[1]!);
      return finishRuntimeCall(host, e, "scr_test_ctx_mock_track", a);
    case "test.ctxMockRestoreAll":
      return finishRuntimeCall(host, e, "scr_test_ctx_mock_restore_all", a);
    case "test.ctxMockReset":
      return finishRuntimeCall(host, e, "scr_test_ctx_mock_reset", a);
    case "test.snapshotValue":
      return finishRuntimeCall(host, e, "scr_test_snapshot_value", a);
    case "test.ctxSnapshot":
      return finishRuntimeCall(host, e, "scr_test_ctx_snapshot", a);
    case "test.fileSnapshot":
      return finishRuntimeCall(host, e, "scr_test_file_snapshot", a);
    case "test.snapshotSerialize":
      return finishRuntimeCall(host, e, "scr_test_snapshot_serialize", a);
    case "test.mockTimersEnable":
      return finishRuntimeCall(host, e, "scr_test_mock_timers_enable", a);
    case "test.mockTimersTick":
      return finishRuntimeCall(host, e, "scr_test_mock_timers_tick", a);
    case "test.mockTimersRunAll":
      return finishRuntimeCall(host, e, "scr_test_mock_timers_run_all", a);
    case "test.mockTimersReset":
      return finishRuntimeCall(host, e, "scr_test_mock_timers_reset", a);
    case "test.mockTimersSetTime":
      return finishRuntimeCall(host, e, "scr_test_mock_timers_set_time", a);
    case "test.ctxMockTimersEnable":
      return finishRuntimeCall(host, e, "scr_test_ctx_mock_timers_enable", a);
    case "test.ctxMockTimersTick":
      return finishRuntimeCall(host, e, "scr_test_ctx_mock_timers_tick", a);
    case "test.ctxMockTimersRunAll":
      return finishRuntimeCall(host, e, "scr_test_ctx_mock_timers_run_all", a);
    case "test.ctxMockTimersReset":
      return finishRuntimeCall(host, e, "scr_test_ctx_mock_timers_reset", a);
    case "test.ctxMockTimersSetTime":
      return finishRuntimeCall(host, e, "scr_test_ctx_mock_timers_set_time", a);
    default:
      throw new InternalCompilerError(`unhandled test call ${e.fn}`);
  }
}
