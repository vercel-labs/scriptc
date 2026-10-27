import * as ts from "../../ts7/adapter.js";
import { type Lowerer } from "../lowerer.js";
import { locOf } from "../../program.js";
import { generatorMeta } from "../call-signatures.js";
import {
  BOOL,
  DYN,
  F64,
  type IrExpr,
  type IrFunction,
  type IrLocal,
  type IrType,
  type SrcLoc,
  UNDEFINED_T,
  VOID,
  isUnitType,
} from "../../../ir/ir.js";
import { genResultRecord } from "../../type-mapper.js";
import { builtinImportOf } from "./module-bindings.js";

/** The async generator type of a timers/promises setInterval call. The
 * fallback declarations type it AsyncGenerator<T>; @types/node types it
 * NodeJS.AsyncIterator<T>, which maps to no IR type, so the yielded type
 * comes from its type argument. */
function timersPromisesIntervalType(
  lowerer: Lowerer,
  expr: ts.CallExpression,
): (IrType & { kind: "generator" }) | null {
  const callType = lowerer.typeOf(expr);
  const mapped = lowerer.mapTypeOf(callType);
  if (mapped?.kind === "generator" && mapped.async) return mapped;
  const arg = lowerer.checker.getTypeArguments(callType as ts.TypeReference)[0];
  const yieldT = arg ? lowerer.mapTypeOf(arg) : null;
  if (!yieldT || yieldT.kind === "void" || isUnitType(yieldT)) return null;
  if (!genResultRecord(yieldT, VOID, lowerer.shapes, lowerer.unions)) return null;
  return { kind: "generator", async: true, yieldT, retT: VOID, nextT: UNDEFINED_T };
}

/** A timers/promises setInterval call, the head a `for await` loop
 * consumes as an async generator. */
export function isTimersPromisesIntervalCall(
  lowerer: Lowerer,
  node: ts.Expression,
): node is ts.CallExpression {
  if (!ts.isCallExpression(node) || node.questionDotToken) return false;
  const callee = node.expression;
  const bi = ts.isIdentifier(callee)
    ? builtinImportOf(lowerer, callee)
    : ts.isPropertyAccessExpression(callee) && !callee.questionDotToken
      ? lowerer.builtinMemberOf(callee)
      : null;
  return bi?.module === "timers/promises" && bi.member === "setInterval";
}

/** timers/promises.setInterval(delay, value), the first Node API built on
 * the generic async-generator protocol. The supported form has an explicit
 * value and no AbortSignal options. It lowers to a generated typed async
 * generator whose loop awaits the existing promise timeout then yields the
 * retained value; creating the iterator remains lazy. */
export function lowerTimersPromisesSetInterval(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  bi: { module: string; member: string },
  loc: SrcLoc,
): IrExpr | null {
  if (bi.module !== "timers/promises" || bi.member !== "setInterval") return null;
  if (expr.arguments.nodes.some(ts.isSpreadElement)) {
    lowerer.unsupported("SC1090", expr, "spread arguments");
  }
  if (expr.arguments.nodes.length !== 2) {
    lowerer.noLowering(
      `timers/promises.setInterval with ${expr.arguments.nodes.length} arguments`,
      expr,
      "the lowered form is setInterval(delay, value) with an explicit yielded value; AbortSignal options are not supported yet",
    );
  }
  const delayNode = expr.arguments.nodes[0]!;
  const valueNode = expr.arguments.nodes[1]!;
  const delay = lowerer.lowerExpr(delayNode);
  const ms =
    delay.kind === "unitLit"
      ? ({ kind: "numLit", value: 1, type: F64, loc } satisfies IrExpr)
      : lowerer.coerceInto(delayNode, delay, F64);
  const value = lowerer.lowerExpr(valueNode);
  const genT = timersPromisesIntervalType(lowerer, expr);
  if (genT === null) lowerer.badType(expr, lowerer.typeOf(expr));
  const yielded = lowerer.coerceInto(valueNode, value, genT.yieldT);
  const fnName = lowerer.closureName(loc, "_tpInterval");
  const msParam: IrLocal = { id: "%tp.ms", name: "delay", type: F64, mutable: false };
  const valueParam: IrLocal = { id: "%tp.value", name: "value", type: genT.yieldT, mutable: false };
  const promiseVoid: IrType = { kind: "promise", inner: VOID };
  const msRef = (): IrExpr => ({ kind: "varRef", localId: msParam.id, type: F64, loc });
  const valueRef = (): IrExpr => ({
    kind: "varRef",
    localId: valueParam.id,
    type: genT.yieldT,
    loc,
  });
  const fn: IrFunction = {
    name: fnName,
    params: [
      { localId: msParam.id, name: msParam.name, type: msParam.type },
      { localId: valueParam.id, name: valueParam.name, type: valueParam.type },
    ],
    returnType: VOID,
    locals: [msParam, valueParam],
    async: true,
    generator: generatorMeta(lowerer, genT),
    body: [
      {
        kind: "while",
        cond: { kind: "boolLit", value: true, type: BOOL, loc },
        body: [
          {
            kind: "exprStmt",
            expr: {
              kind: "awaitExpr",
              value: {
                kind: "libCall",
                fn: "tp.setTimeout",
                args: [msRef()],
                type: promiseVoid,
                loc,
              },
              type: VOID,
              loc,
            },
            loc,
          },
          {
            kind: "exprStmt",
            expr: { kind: "yieldExpr", value: valueRef(), type: VOID, loc },
            loc,
          },
        ],
        loc,
      },
    ],
    loc,
  };
  lowerer.liftedFns.push(fn);
  return { kind: "call", callee: fnName, args: [ms, yielded], type: genT, loc };
}

/** True when `node`'s checker type is the timer `Timeout` handle (the
 * fallback's `Timeout` or @types/node's `NodeJS.Timeout`) — provenance,
 * not name, so a user's own `Timeout` never matches. The handle maps to
 * f64, so the method calls below can't tell it from a plain number by IR
 * type alone; this is the discriminator. */
function isTimerHandleTyped(
  lowerer: Lowerer,
  node: ts.Expression,
  name: "Timeout" | "Immediate",
): boolean {
  const t = lowerer.checker.getTypeAtLocation(node);
  const sym = t.getAliasSymbol() ?? t.getSymbol();
  if (sym === undefined || ts.symbolName(sym) !== name) return false;
  return sym.declarations.some(
    (d) =>
      // An interface in the fallback and @types/node 22+, a class in
      // @types/node 20 and older.
      (ts.isInterfaceDeclaration(d) || ts.isClassDeclaration(d)) &&
      lowerer.isStdlibFile(ts.getSourceFileOfNode(d)),
  );
}
function isTimeoutTyped(lowerer: Lowerer, node: ts.Expression): boolean {
  return isTimerHandleTyped(lowerer, node, "Timeout");
}

/** `t.unref()` / `t.ref()` / `t.hasRef()` on a Timeout handle — loop-
 * liveness bookkeeping over the numeric timer id (the handle is f64).
 * unref/ref return the handle for chaining (Node); hasRef returns a
 * bool. `refresh` and the rest of @types/node's Timeout surface fence.
 * Null when the receiver isn't a Timeout handle. */
export function lowerTimeoutMethodCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  // `t.unref?.()` (the defensive optional CALL — mdns's timer.unref?.())
  // is the plain call: the method always exists on a Timeout handle. A
  // `t?.unref()` receiver guard is real narrowing and stays with the
  // chain machinery.
  if (access.questionDotToken) return null;
  const isTimeout = isTimeoutTyped(lowerer, access.expression);
  const isImmediate = !isTimeout && isTimerHandleTyped(lowerer, access.expression, "Immediate");
  if (!isTimeout && !isImmediate) return null;
  if (!lowerer.isStdlibMember(access)) return null;
  const name = access.name.text;
  const loc = locOf(call);
  if ((name === "unref" || name === "ref") && call.arguments.nodes.length === 0) {
    const handle = lowerer.lowerExprExpecting(access.expression, F64);
    const fn = isImmediate
      ? name === "unref"
        ? "timers.immediateUnref"
        : "timers.immediateRef"
      : name === "unref"
        ? "timers.unref"
        : "timers.ref";
    // Returns the handle for chaining (`setTimeout(...).unref()` — Node
    // returns the Timeout/Immediate); the libCall yields the f64 back.
    return { kind: "libCall", fn, args: [handle], type: F64, loc };
  }
  if (name === "hasRef" && call.arguments.nodes.length === 0) {
    const handle = lowerer.lowerExprExpecting(access.expression, F64);
    const fn = isImmediate ? "timers.immediateHasRef" : "timers.hasRef";
    return { kind: "libCall", fn, args: [handle], type: BOOL, loc };
  }
  if (name === "refresh" && call.arguments.nodes.length === 0 && !isImmediate) {
    // Re-arms to now + the original delay; yields the handle back for
    // chaining, like unref/ref.
    const handle = lowerer.lowerExprExpecting(access.expression, F64);
    return { kind: "libCall", fn: "timers.refresh", args: [handle], type: F64, loc };
  }
  lowerer.noLowering(
    `${isImmediate ? "Immediate" : "Timeout"}.${name}`,
    call,
    isImmediate
      ? "unref(), ref(), and hasRef() are the supported Immediate methods"
      : "unref(), ref(), hasRef(), and refresh() are the supported Timeout methods",
    lowerer.checker.getSymbolAtLocation(access.name),
  );
}

// node:timers/promises — setTimeout([delay[, value[, options]]]) and
// setImmediate([value[, options]]): promises the shared timer heap and the
// immediate queue settle. The omitted delay completes to Node's 1ms floor
// (scr_timer_coerce_ms clamps anyway; the literal keeps the emitted call
// self-describing). A resolve value travels as an already-resolved promise
// of its own type, whose settlement the result copies when it fires. The
// options object takes `ref` and `signal`; with a signal the runtime
// clears the timer and rejects with an AbortError when it aborts.
export function lowerTimersPromisesCall(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  bi: { module: string; member: string },
  loc: SrcLoc,
): IrExpr | null {
  const promiseVoid: IrType = { kind: "promise", inner: VOID };
  if (bi.member === "scheduler.wait" || bi.member === "scheduler.yield")
    return lowerSchedulerCall(lowerer, expr, bi.member, loc);
  if (bi.member !== "setTimeout" && bi.member !== "setImmediate") return null;
  const timeout = bi.member === "setTimeout";
  const [valueNode, optionsNode] = timeout ? expr.arguments.nodes.slice(1) : expr.arguments.nodes;
  const ms: IrExpr | null = !timeout
    ? null
    : expr.arguments.nodes[0]
      ? lowerer.lowerExprExpecting(expr.arguments.nodes[0], F64)
      : { kind: "numLit", value: 1, type: F64, loc };
  if (valueNode === undefined) {
    return timeout
      ? { kind: "libCall", fn: "tp.setTimeout", args: [ms!], type: promiseVoid, loc }
      : { kind: "libCall", fn: "tp.setImmediate", args: [], type: promiseVoid, loc };
  }
  const resultT = lowerer.mapTypeOf(lowerer.typeOf(expr));
  const inner = resultT?.kind === "promise" ? resultT.inner : null;
  if (inner === null) {
    lowerer.noLowering(
      `timers/promises ${bi.member} with a resolve value of this type`,
      valueNode,
      "the resolve value's type must be representable",
    );
    return null;
  }
  // An undefined resolve value settles the void promise; awaiting it
  // yields undefined either way.
  const voidValue = inner.kind === "void" || isUnitType(inner);
  const value: IrExpr = voidValue
    ? {
        kind: "seqExpr",
        stmts: [lowerer.lowerExprStatement(valueNode)],
        result: { kind: "intrinsic", name: "promise.resolve", args: [], type: promiseVoid, loc },
        type: promiseVoid,
        loc,
      }
    : {
        kind: "intrinsic",
        name: "promise.resolve",
        args: [lowerer.lowerExprExpecting(valueNode, inner)],
        type: resultT!,
        loc,
      };
  const { ref, signal } = timersPromisesOptions(lowerer, bi.member, optionsNode, loc);
  if (signal !== null) {
    return {
      kind: "libCall",
      fn: timeout ? "tp.setTimeoutSignal" : "tp.setImmediateSignal",
      args: timeout ? [ms!, value, ref, signal] : [value, ref, signal],
      type: voidValue ? promiseVoid : resultT!,
      loc,
    };
  }
  return {
    kind: "libCall",
    fn: timeout ? "tp.setTimeoutValue" : "tp.setImmediateValue",
    args: timeout ? [ms!, value, ref] : [value, ref],
    type: voidValue ? promiseVoid : resultT!,
    loc,
  };
}

/** scheduler.wait(delay[, options]) and scheduler.yield(): Node's Scheduler
 * methods return setTimeout(delay, undefined, options) and setImmediate(),
 * so both settle a void promise from the same timer heap and immediate
 * queue. The options object takes `ref` and `signal` as setTimeout's does. */
function lowerSchedulerCall(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  member: "scheduler.wait" | "scheduler.yield",
  loc: SrcLoc,
): IrExpr {
  const promiseVoid: IrType = { kind: "promise", inner: VOID };
  if (member === "scheduler.yield")
    return { kind: "libCall", fn: "tp.setImmediate", args: [], type: promiseVoid, loc };
  // The scheduler.wait libCalls emit timers/promises setTimeout's runtime
  // calls; mock.timers mocks scheduler.wait and leaves setTimeout's named
  // and namespace imports real. An omitted delay is NaN, Node's undefined.
  const [delayNode, optionsNode] = expr.arguments.nodes;
  const ms: IrExpr = delayNode
    ? lowerer.lowerExprExpecting(delayNode, F64)
    : { kind: "numLit", value: NaN, type: F64, loc };
  if (optionsNode === undefined)
    return { kind: "libCall", fn: "tp.schedulerWait", args: [ms], type: promiseVoid, loc };
  const { ref, signal } = timersPromisesOptions(lowerer, member, optionsNode, loc);
  const value: IrExpr = {
    kind: "intrinsic",
    name: "promise.resolve",
    args: [],
    type: promiseVoid,
    loc,
  };
  return {
    kind: "libCall",
    fn: signal === null ? "tp.schedulerWaitValue" : "tp.schedulerWaitSignal",
    args: signal === null ? [ms, value, ref] : [ms, value, ref, signal],
    type: promiseVoid,
    loc,
  };
}

/** The `ref` (true when absent) and `signal` (null when absent) options of
 * a timers/promises options object literal, in source order. Options that
 * are not an object literal fence. */
function timersPromisesOptions(
  lowerer: Lowerer,
  member: string,
  optionsNode: ts.Expression | undefined,
  loc: SrcLoc,
): { ref: IrExpr; signal: IrExpr | null } {
  const absent: IrExpr = { kind: "boolLit", value: true, type: BOOL, loc };
  if (optionsNode === undefined) return { ref: absent, signal: null };
  if (!ts.isObjectLiteralExpression(optionsNode)) {
    lowerer.noLowering(
      `timers/promises ${member} options that are not an object literal`,
      optionsNode,
      "pass the options as an object literal: { ref, signal }",
    );
    return { ref: absent, signal: null };
  }
  let ref: IrExpr = absent;
  let signal: IrExpr | null = null;
  for (const prop of optionsNode.properties.nodes) {
    const name = prop.name && ts.isIdentifier(prop.name) ? prop.name.text : null;
    if (
      name === "signal" &&
      (ts.isPropertyAssignment(prop) || ts.isShorthandPropertyAssignment(prop))
    ) {
      signal = lowerer.lowerExprExpecting(
        ts.isPropertyAssignment(prop) ? prop.initializer : (prop.name as ts.Identifier),
        DYN,
      );
    } else if (name === "ref" && ts.isPropertyAssignment(prop)) {
      ref = lowerer.lowerExprExpecting(prop.initializer, BOOL);
    } else {
      lowerer.noLowering(
        `timers/promises ${member} options other than ref and signal`,
        prop,
        "the lowered options object takes ref: boolean and signal: AbortSignal",
      );
    }
  }
  return { ref, signal };
}
