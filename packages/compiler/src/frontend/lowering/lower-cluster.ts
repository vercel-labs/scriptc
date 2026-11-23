import { boolLit, dynUndefinedExpr } from "../../ir/build.js";
/* node:cluster (scr_cluster.c) — the spoke module of the cluster surface:
 * the module's value reads (isPrimary/isWorker/isMaster, schedulingPolicy
 * and its SCHED_* constants, settings, workers, worker), its calls
 * (fork/setupPrimary/setupMaster/disconnect), and the cluster object's
 * on/once/off event registration. Worker instances are checked-dynamic
 * handles (type-mapper maps cluster.Worker to DYN), so worker.send,
 * worker.disconnect, worker.isConnected, worker.isDead, worker.kill and
 * worker.on/once are ordinary checked-dynamic member calls that the runtime
 * unit answers; this file does not lower them. */
import * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js";
import { locOf } from "../program.js";
import { resultIsDiscarded } from "./call-position.js";
import {
  BOOL,
  DYN,
  F64,
  type IrExpr,
  type IrLibFn,
  type SrcLoc,
  STRING,
  VOID,
} from "../../ir/ir.js";

/** The cluster module's supported EVENT names. Node's cluster object is an
 * EventEmitter; these are the events its primary emits. */
const CLUSTER_EVENTS = new Set([
  "fork",
  "online",
  "listening",
  "message",
  "disconnect",
  "exit",
  "setup",
]);

const CLUSTER_EVENT_HINT =
  '"fork", "online", "listening", "message", "disconnect", "exit", and "setup" are the supported cluster events (as literals)';

/** True when `expr` names the cluster module namespace (a namespace or
 * default import binding, an inline require, or a traced alias). */
export function isClusterNamespace(lowerer: Lowerer, expr: ts.Expression): boolean {
  return lowerer.builtinNamespaceModuleOf(expr) === "cluster";
}

/** One cluster module member as a VALUE: the runtime-read booleans and
 * objects. Null for a member the module does not serve. */
export function clusterMemberValue(lowerer: Lowerer, member: string, loc: SrcLoc): IrExpr | null {
  lowerer.clusterUsed = true;
  const simple: Record<string, IrLibFn> = {
    isPrimary: "cluster.isPrimary",
    isWorker: "cluster.isWorker",
    isMaster: "cluster.isPrimary",
  };
  const fn = Object.hasOwn(simple, member) ? simple[member] : undefined;
  if (fn !== undefined) return { kind: "libCall", fn, args: [], type: BOOL, loc };
  switch (member) {
    case "schedulingPolicy":
      return { kind: "libCall", fn: "cluster.schedulingPolicy", args: [], type: F64, loc };
    case "SCHED_NONE":
      return { kind: "numLit", value: 1, type: F64, loc };
    case "SCHED_RR":
      return { kind: "numLit", value: 2, type: F64, loc };
    case "settings":
      return { kind: "libCall", fn: "cluster.settings", args: [], type: DYN, loc };
    case "workers":
      return { kind: "libCall", fn: "cluster.workers", args: [], type: DYN, loc };
    case "worker":
      return { kind: "libCall", fn: "cluster.worker", args: [], type: DYN, loc };
    default:
      return null;
  }
}

function requireStatementPosition(lowerer: Lowerer, call: ts.CallExpression, what: string): void {
  if (resultIsDiscarded(call)) return;
  lowerer.unsupported(
    "SC1090",
    call,
    `using the result of ${what} (result chaining has no lowering — call it as its own statement)`,
  );
}

/** The cluster module's function calls: fork, setupPrimary/setupMaster, and
 * disconnect. Everything else the module declares fences. */
export function lowerClusterModuleCall(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  bi: { module: string; member: string },
  loc: SrcLoc,
): IrExpr | null {
  if (bi.module !== "cluster") return null;
  lowerer.clusterUsed = true;
  const args = expr.arguments.nodes;
  if (args.some(ts.isSpreadElement)) {
    lowerer.noLowering(`cluster.${bi.member} with a spread argument`, expr);
  }
  if (bi.member === "fork") {
    if (args.length > 1) {
      lowerer.noLowering(
        `cluster.fork with ${args.length} arguments`,
        expr,
        "the supported form is fork([env])",
      );
    }
    const env =
      args.length === 1 ? lowerer.lowerExprExpecting(args[0]!, DYN) : dynUndefinedExpr(loc);
    return { kind: "libCall", fn: "cluster.fork", args: [env], type: DYN, loc };
  }
  if (bi.member === "setupPrimary" || bi.member === "setupMaster") {
    if (args.length > 1) {
      lowerer.noLowering(
        `cluster.${bi.member} with ${args.length} arguments`,
        expr,
        "the supported form is setupPrimary([settings])",
      );
    }
    const options =
      args.length === 1 ? lowerer.lowerExprExpecting(args[0]!, DYN) : dynUndefinedExpr(loc);
    requireStatementPosition(lowerer, expr, `cluster.${bi.member}()`);
    return { kind: "libCall", fn: "cluster.setup", args: [options], type: VOID, loc };
  }
  if (bi.member === "disconnect") {
    if (args.length > 1) {
      lowerer.noLowering(
        `cluster.disconnect with ${args.length} arguments`,
        expr,
        "the supported form is disconnect([callback])",
      );
    }
    const callback =
      args.length === 1
        ? lowerer.coerceToExpected(lowerer.lowerExpr(args[0]!), DYN)
        : dynUndefinedExpr(loc);
    requireStatementPosition(lowerer, expr, "cluster.disconnect()");
    return { kind: "libCall", fn: "cluster.disconnect", args: [callback], type: VOID, loc };
  }
  lowerer.noLowering(
    `cluster.${bi.member}(...)`,
    expr,
    "fork, setupPrimary/setupMaster, and disconnect are the lowered cluster module functions",
  );
}

/** Method calls on the cluster namespace: on/once/off (the cluster object's
 * events). The listener crosses as its checked-dynamic function; the unit
 * calls it with Node's event arguments, and a typed listener's checked
 * adapter converts them at the boundary. */
export function lowerClusterMethodCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  if (!isClusterNamespace(lowerer, access.expression)) return null;
  lowerer.clusterUsed = true;
  const name = access.name.text;
  const args = call.arguments.nodes;
  if (name === "on" || name === "once" || name === "addListener") {
    if (args.length !== 2 || ts.isSpreadElement(args[0]!) || ts.isSpreadElement(args[1]!)) {
      lowerer.noLowering(`cluster.${name} with this argument shape`, call);
    }
    const loc = locOf(call);
    const eventType = lowerer.typeOf(args[0]!);
    const event = eventType.isStringLiteralType() ? eventType.value : null;
    if (event === null || !CLUSTER_EVENTS.has(event)) {
      lowerer.noLowering(`cluster.${name}(...)`, call, CLUSTER_EVENT_HINT);
    }
    const listener = lowerer.coerceToExpected(lowerer.lowerExpr(args[1]!), DYN);
    // Node's on() answers the cluster object for chaining; the chained
    // value is not modeled.
    requireStatementPosition(lowerer, call, `cluster.${name}()`);
    return {
      kind: "libCall",
      fn: "cluster.on",
      args: [
        { kind: "strLit", value: event, type: STRING, loc },
        listener,
        boolLit(name === "once", loc),
      ],
      type: VOID,
      loc,
    };
  }
  if (name === "off" || name === "removeListener") {
    if (args.length !== 2 || ts.isSpreadElement(args[0]!) || ts.isSpreadElement(args[1]!)) {
      lowerer.noLowering(`cluster.${name} with this argument shape`, call);
    }
    if (!resultIsDiscarded(call)) {
      lowerer.unsupported(
        "SC1090",
        call,
        `using the result of cluster.${name}() (call it as its own statement)`,
      );
    }
    const loc = locOf(call);
    const eventType = lowerer.typeOf(args[0]!);
    const event = eventType.isStringLiteralType() ? eventType.value : null;
    if (event === null || !CLUSTER_EVENTS.has(event)) {
      lowerer.noLowering(`cluster.${name}(...)`, call, CLUSTER_EVENT_HINT);
    }
    const listener = lowerer.coerceToExpected(lowerer.lowerExpr(args[1]!), DYN);
    return {
      kind: "libCall",
      fn: "cluster.off",
      args: [{ kind: "strLit", value: event, type: STRING, loc }, listener],
      type: VOID,
      loc,
    };
  }
  return null;
}
