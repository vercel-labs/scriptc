import { lowerReadlineCursorCall } from "./builtins/readline.js";
import { lowerMonitorEventLoopDelayCall } from "./builtins/performance.js";
import {
  lowerEnvironmentData,
  lowerReceiveMessageOnPort,
  lowerUncloneable,
  lowerUntransferable,
} from "./builtins/workers.js";
import * as ts from "../ts7/adapter.js";
import { dynUndefinedExpr } from "../../ir/build.js";
import { DYN, type IrExpr, type SrcLoc } from "../../ir/ir.js";
import { lowerEventsEmitterHelper, lowerEventsOnce } from "./lower-event-emitter.js";
import type { Lowerer } from "./lowerer.js";
import { lowerTimersMemberCall } from "./lower-timers.js";
import { lowerStreamModuleCall } from "./lower-stream.js";
import { lowerCallbackPromisify } from "./builtins/promisify-callback.js";
import { lowerNodeModuleCall } from "./builtins/module-resolution.js";
import { builtinModuleFnOf, builtinFenceHintOf } from "./surfaces.js";
import { resultIsDiscarded } from "./call-position.js";
import { locOf, requireSpecOf } from "../program.js";

/** `events.addAbortListener(signal, listener)`: the runtime registers the
 * once/resist-stop-propagation abort listener (or queues the call for an
 * aborted signal) and answers the disposer; the Disposable is a fresh
 * object carrying it under Symbol.dispose. */
export function lowerAddAbortListener(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  loc: SrcLoc,
): IrExpr {
  const args = expr.arguments.nodes;
  if (args.length > 2 || args.some(ts.isSpreadElement)) {
    lowerer.noLowering(`addAbortListener with this argument list`, expr);
  }
  const values = [0, 1].map((i) =>
    args[i] ? lowerer.lowerExprExpecting(args[i]!, DYN) : dynUndefinedExpr(loc),
  );
  const key: IrExpr = {
    kind: "dynFrom",
    value: {
      kind: "libCall",
      fn: "sym.wellKnown",
      args: [{ kind: "strLit", value: "dispose", type: { kind: "string" }, loc }],
      type: { kind: "symbol" },
      loc,
    },
    type: DYN,
    loc,
  };
  const dispose: IrExpr = {
    kind: "libCall",
    fn: "events.addAbortListener",
    args: values,
    type: DYN,
    loc,
  };
  return { kind: "dynObjLit", fields: [{ key, value: dispose }], type: DYN, loc };
}

/** graceful-fs's `gracefulify(fsModule)` (graceful-fs is served as node:fs —
 * builtin-modules.ts): it patches a module object with the retry queue,
 * which statically lowered fs calls never consult, so the call statement
 * is a no-op. The argument still evaluates unless it is a plain reference
 * (the patched module, typically `require("fs")` or a namespace binding).
 * The returned module object has no representation; other positions
 * fence. */
function lowerGracefulify(lowerer: Lowerer, expr: ts.CallExpression, loc: SrcLoc): IrExpr {
  const args = expr.arguments.nodes;
  if (!resultIsDiscarded(expr) || args.length !== 1 || ts.isSpreadElement(args[0]!)) {
    lowerer.noLowering(
      "gracefulify",
      expr,
      "graceful-fs compiles as node:fs; gracefulify(fsModule) lowers as a statement whose result is unused",
    );
  }
  let arg: ts.Expression = args[0]!;
  while (ts.isParenthesizedExpression(arg)) arg = arg.expression;
  const plain =
    ts.isIdentifier(arg) ||
    (ts.isCallExpression(arg) && requireSpecOf(arg) !== null) ||
    (ts.isPropertyAccessExpression(arg) && ts.isIdentifier(arg.expression));
  if (plain) return { kind: "seqExpr", stmts: [], result: dynUndefinedExpr(loc), type: DYN, loc };
  return {
    kind: "seqExpr",
    stmts: [{ kind: "exprStmt", expr: lowerer.lowerExpr(arg), loc: locOf(arg) }],
    result: dynUndefinedExpr(loc),
    type: DYN,
    loc,
  };
}

/** Named imports, namespace members and callable aliases share validation
 * and dispatch. Resolve diagnostic provenance only if no handler accepts. */
export function lowerBuiltinCall(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  bi: { module: string; member: string },
  loc: SrcLoc,
  namespaceMember?: ts.MemberName,
): IrExpr {
  if (bi.module === "child_process" && (bi.member === "execFile" || bi.member === "exec")) {
    return lowerer.lowerExecFileCall(expr, loc, bi.member === "exec");
  }
  if (bi.module === "events" && bi.member === "addAbortListener") {
    return lowerAddAbortListener(lowerer, expr, loc);
  }
  if (bi.module === "events" && bi.member === "once") return lowerEventsOnce(lowerer, expr, loc);
  if (bi.module === "perf_hooks" && bi.member === "monitorEventLoopDelay") {
    return lowerMonitorEventLoopDelayCall(lowerer, expr);
  }
  if (bi.module === "events") {
    const helper = lowerEventsEmitterHelper(lowerer, expr, bi.member, loc);
    if (helper) return helper;
  }
  if (bi.module === "timers") {
    const timersServed = lowerTimersMemberCall(lowerer, expr, bi.member, loc);
    if (timersServed) return timersServed;
  }
  const served = lowerer.lowerNetModuleCall(expr, bi, loc);
  if (served) return served;
  const dgramServed = lowerer.lowerDgramDnsModuleCall(expr, bi, loc);
  if (dgramServed) return dgramServed;
  const assertServed = lowerer.lowerAssertModuleCall(expr, bi, loc);
  if (assertServed) return assertServed;
  const testServed = lowerer.lowerNodeTestModuleCall(expr, bi, loc);
  if (testServed) return testServed;
  const utilServed = lowerer.lowerUtilModuleCall(expr, bi, loc);
  if (utilServed) return utilServed;
  if (bi.module === "util" && bi.member === "promisify") {
    const promisified = lowerCallbackPromisify(lowerer, expr, loc);
    if (promisified) return promisified;
  }
  const streamServed = lowerStreamModuleCall(lowerer, expr, bi, loc);
  if (streamServed) return streamServed;
  const fsTs = lowerer.lowerFsToUnixTimestampCall(expr, bi, loc);
  if (fsTs) return fsTs;
  const fsLadder = lowerer.lowerFsLadderCall(expr, bi, loc);
  if (fsLadder) return fsLadder;
  const cryptoServed = lowerer.lowerCryptoModuleCall(expr, bi, loc);
  if (cryptoServed) return cryptoServed;
  const timersInterval = lowerer.lowerTimersPromisesSetInterval(expr, bi, loc);
  if (timersInterval) return timersInterval;
  const nodeModuleServed = lowerNodeModuleCall(lowerer, expr, bi, loc);
  if (nodeModuleServed) return nodeModuleServed;
  if (bi.module === "readline") {
    const cursorServed = lowerReadlineCursorCall(lowerer, expr, bi.member, loc);
    if (cursorServed) return cursorServed;
  }
  if (bi.module === "worker_threads" && bi.member === "receiveMessageOnPort") {
    return lowerReceiveMessageOnPort(lowerer, expr);
  }
  if (
    bi.module === "worker_threads" &&
    (bi.member === "setEnvironmentData" || bi.member === "getEnvironmentData")
  ) {
    return lowerEnvironmentData(lowerer, expr, bi.member);
  }
  if (
    bi.module === "worker_threads" &&
    (bi.member === "markAsUntransferable" || bi.member === "isMarkedAsUntransferable")
  ) {
    return lowerUntransferable(lowerer, expr, bi.member);
  }
  if (bi.module === "worker_threads" && bi.member === "markAsUncloneable") {
    return lowerUncloneable(lowerer, expr);
  }
  if (bi.module === "fs" && bi.member === "gracefulify")
    return lowerGracefulify(lowerer, expr, loc);
  const builtinFn = builtinModuleFnOf(lowerer, bi.module, bi.member);
  if (!builtinFn) {
    lowerer.noLowering(
      `${bi.module}.${bi.member}`,
      expr,
      builtinFenceHintOf(bi.module, bi.member),
      namespaceMember
        ? lowerer.checker.getSymbolAtLocation(namespaceMember)
        : ts.isIdentifier(expr.expression)
          ? lowerer.resolveValueSymbol(expr.expression)
          : undefined,
    );
  }
  return lowerer.lowerBuiltinModuleCall(expr, bi, builtinFn, loc);
}
