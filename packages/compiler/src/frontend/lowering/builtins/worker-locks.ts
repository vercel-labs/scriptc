/* node:worker_threads' Web Locks manager — `locks.request` and `locks.query`
 * (scr_worker_locks.c).
 *
 * `locks` is a module member, not a module-level function, so its calls are
 * lowered at the call site rather than through the module-call dispatch:
 * when the callee is a property access on the builtins member
 * `worker_threads.locks`, `request` and `query` answer the runtime's
 * entries and every other member refuses by name. */
import * as ts from "../../ts7/adapter.js";
import { locOf } from "../../program.js";
import { withoutParentheses } from "../../outer-expressions.js";
import { dynUndefinedExpr } from "../../../ir/build.js";
import { DYN, STRING, type IrExpr } from "../../../ir/ir.js";

/** Both entries answer a promise of a checked-dynamic value (Node resolves
 * them with the callback's result and with the lock snapshot). */
const PROMISE_DYN = { kind: "promise", inner: DYN } as const;
import { type Lowerer } from "../lowerer.js";
import { builtinImportOf } from "./module-bindings.js";

/** True when `node` names the builtins member `worker_threads.locks`,
 * through a named import binding (`import { locks } from ...`) or the
 * module namespace (`worker_threads.locks`, `workerThreads.locks`). */
function isLocksMember(lowerer: Lowerer, node: ts.Expression): boolean {
  const expr = withoutParentheses(node);
  if (ts.isIdentifier(expr)) {
    const binding = builtinImportOf(lowerer, expr);
    return binding !== null && binding.module === "worker_threads" && binding.member === "locks";
  }
  if (ts.isPropertyAccessExpression(expr) && !expr.questionDotToken) {
    const qualifier = withoutParentheses(expr.expression);
    if (!ts.isIdentifier(qualifier)) return false;
    const binding = builtinImportOf(lowerer, qualifier);
    // A namespace import binds the module itself; the member read then
    // resolves through the module's own inventory.
    return (
      binding !== null &&
      binding.module === "worker_threads" &&
      binding.member === "locks" &&
      expr.name.text === "locks"
    );
  }
  return false;
}

/** `locks.request(name[, options], callback)` and `locks.query()`. */
export function lowerLocksMethodCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  if (access.questionDotToken) return null;
  if (!isLocksMember(lowerer, access.expression)) return null;
  const loc = locOf(call);
  const method = access.name.text;
  const args = call.arguments.nodes;
  if (method === "query") {
    if (args.length !== 0 || args.some((arg) => ts.isSpreadElement(arg))) {
      lowerer.noLowering("locks.query with arguments", call, "use locks.query()");
    }
    lowerer.usesWorkers = true;
    return { kind: "libCall", fn: "worker.locksQuery", args: [], type: PROMISE_DYN, loc };
  }
  if (method === "request") {
    if (args.length < 2 || args.length > 3 || args.some((arg) => ts.isSpreadElement(arg))) {
      lowerer.noLowering(
        "locks.request with these arguments",
        call,
        "use locks.request(name, callback) or locks.request(name, options, callback)",
      );
    }
    /* Node converts the name with DOMString first; the compiler's STRING
     * expectation is that conversion, including its Symbol TypeError. */
    const name = lowerer.lowerExprExpecting(args[0]!, STRING);
    const options =
      args.length === 3 ? lowerer.lowerExprExpecting(args[1]!, DYN) : dynUndefinedExpr(loc);
    const callback = lowerer.lowerExprExpecting(args[args.length - 1]!, DYN);
    /* The manager lives in the worker runtime unit, so the program links it
     * the way any other worker_threads call does. */
    lowerer.usesWorkers = true;
    return {
      kind: "libCall",
      fn: "worker.locksRequest",
      args: [name, options, callback],
      type: PROMISE_DYN,
      loc,
    };
  }
  return lowerer.noLowering(
    `locks.${method}`,
    call,
    "locks.request and locks.query are the supported members",
  );
}
