import { keyedHelperName } from "./stable-names.js";
import { dynUndefinedExpr, numLit, varRef } from "../../ir/build.js";
import * as ts from "../ts7/adapter.js";
import { isJsSourceFile } from "../program.js";
import {
  BOOL,
  canBoxFuncIntoDyn,
  DYN,
  F64,
  isUnitType,
  STRING,
  VOID,
  type IrExpr,
  type IrStmt,
  type IrType,
  type SrcLoc,
  typeKey,
} from "../../ir/ir.js";
import { buildFunctionAdapter } from "./coercions/builders.js";
import { lowerOptionalNumber } from "./lower-exprs.js";
import type { Lowerer } from "./lowerer.js";

/** setTimeout invokes its callback with NO arguments, but @types/node's
 * generic signature admits callbacks DECLARED with parameters — the
 * `setTimeout(resolve, ms)` sleep idiom, where Promise<unknown>'s
 * resolve is (value: unknown) => void, i.e. func(dyn)=>void. That one
 * shape adapts through an interned wrapper closure that calls the
 * callback with the dyn undefined — exactly what JS's zero-argument
 * invocation delivers (resolve(undefined) fulfills with undefined).
 * Zero-param callbacks pass through; any other parameterized callback
 * fences (a value for its parameter would have to be invented). */
export function adaptZeroArgTimerCallback(
  lowerer: Lowerer,
  cb: IrExpr,
  node: ts.Node,
  loc: SrcLoc,
): IrExpr {
  // A REST-marked callback is not the zero-param ABI even with an empty
  // fixed-param list — `setTimeout(function(){ arguments }, 0)` infers
  // func(...dyn[])=>void (the variadic `arguments` form), and passing it
  // through unadapted hands the libCall a shape it does not accept (the
  // 12-settimeout-arguments ICE). It adapts below like any other
  // parameterized callback: boxed through the checked-dynamic boundary
  // when boxable, the named fence otherwise.
  if (
    cb.type.kind !== "func" ||
    (cb.type.params.length === 0 && !cb.type.rest && cb.type.ret.kind === "void")
  )
    return cb;
  // A zero-param callback whose RETURN isn't void (`setTimeout(push, 1)`
  // where push answers boolean|undefined; async callbacks — func()=>
  // promise): JS ignores a timer callback's return value, so the shape
  // adapts through an interned return-dropping wrapper that calls the
  // callback and discards the result (a returned promise is Node's own
  // fire-and-forget — rejections take the unhandled-rejection path,
  // exactly as if the async callback ran under the timer directly).
  if (cb.type.params.length === 0 && !cb.type.rest) {
    const fromT = cb.type;
    const toT: IrType = { kind: "func", params: [], ret: VOID };
    const key = `timer.dropret:${typeKey(fromT)}`;
    const existing = lowerer.arrHofHelpers.get(key);
    const name = existing ?? keyedHelperName(lowerer, "%timer.dropret", key);
    if (!existing) {
      lowerer.arrHofHelpers.set(key, name);
      lowerer.liftedFns.push(
        ...buildFunctionAdapter(
          name,
          fromT,
          toT,
          [],
          [],
          [
            {
              kind: "exprStmt",
              expr: {
                kind: "callValue",
                callee: { kind: "varRef", localId: "f.0", type: fromT, loc },
                // The wrapper is the callback the timer calls, so it runs
                // with the timer's receiver on the ambient stack; the call
                // forwards it so the original callback reads the same one.
                receiver: { kind: "libCall", fn: "dyn.this", args: [], type: DYN, loc },
                args: [],
                type: fromT.ret,
                loc,
              },
              loc,
            },
          ],
          loc,
        ),
      );
    }
    return { kind: "call", callee: name, args: [cb], type: toT, loc };
  }
  const fromT = cb.type;
  const toT0: IrType = { kind: "func", params: [], ret: VOID };
  if (
    fromT.rest ||
    fromT.params.length !== 1 ||
    fromT.params[0]!.kind !== "dyn" ||
    fromT.ret.kind !== "void"
  ) {
    // Any other BOXABLE signature rides the checked-dynamic function
    // boundary instead: box the closure (dynFrom), adapt to () => void
    // (dynCheck) — the thunk delivers JS's zero-argument invocation
    // (each param sees undefined; a param type undefined fails checks
    // throws the catchable TypeError, the SEMANTICS.md 117 stance).
    // The JS-inferred mustCall wrapper (func(dyn,dyn)=>dyn) lands here.
    if (
      canBoxFuncIntoDyn(
        fromT,
        (id) => lowerer.shapes.get(id),
        (id) => lowerer.unions.get(id),
      )
    ) {
      const boxed: IrExpr = { kind: "dynFrom", value: cb, type: DYN, loc };
      return { kind: "dynCheck", value: boxed, type: toT0, loc };
    }
    lowerer.noLowering(
      "setTimeout with a callback that takes arguments",
      node,
      "the callback is invoked with no arguments — wrap it: setTimeout(() => cb(...), ms)",
    );
  }
  const toT: IrType = { kind: "func", params: [], ret: VOID };
  const key = `timer.droparg:${typeKey(fromT)}`;
  const existing = lowerer.arrHofHelpers.get(key);
  const name = existing ?? keyedHelperName(lowerer, "%timer.droparg", key);
  if (!existing) {
    lowerer.arrHofHelpers.set(key, name);
    lowerer.liftedFns.push(
      ...buildFunctionAdapter(
        name,
        fromT,
        toT,
        [],
        [],
        [
          {
            kind: "exprStmt",
            expr: {
              kind: "callValue",
              callee: { kind: "varRef", localId: "f.0", type: fromT, loc },
              // As in the return-dropping wrapper: the callback sees the
              // receiver the timer called the wrapper with.
              receiver: { kind: "libCall", fn: "dyn.this", args: [], type: DYN, loc },
              args: [dynUndefinedExpr(loc)],
              type: VOID,
              loc,
            },
            loc,
          },
        ],
        loc,
      ),
    );
  }
  return { kind: "call", callee: name, args: [cb], type: toT, loc };
}

/** The trailing-argument timer forms — `setTimeout(cb, ms, ...args)`,
 * `setInterval(cb, ms, ...args)`, `setImmediate(cb, ...args)` — invoke
 * the callback WITH those arguments (Node passes them through). The
 * callback and every argument box into dyn and an interned per-arity
 * thunk delivers the dynCall at fire time: JS's exact call semantics
 * (per-argument checks against the callee's declared signature, extras
 * ignored, a non-function callee throwing the catchable TypeError).
 * Non-boxable callbacks fence. */
export function timerStyleCallback(
  lowerer: Lowerer,
  callArgs: readonly ts.Expression[],
  what: string,
  loc: SrcLoc,
): IrExpr {
  // The shared callback adaptation for timer-shaped surfaces whose
  // trailing arguments start right after the callback (setImmediate,
  // process.nextTick): zero-arg callbacks pass through, boxable
  // parameterized ones ride the checked-dynamic boundary, trailing
  // call arguments ride the interned per-arity dyn thunk.
  return callArgs.length > 1
    ? makeTimerArgsThunk(lowerer, callArgs[0]!, callArgs.slice(1), what, loc)
    : adaptZeroArgTimerCallback(lowerer, lowerer.lowerExpr(callArgs[0]!), callArgs[0]!, loc);
}

function makeTimerArgsThunk(
  lowerer: Lowerer,
  cbNode: ts.Expression,
  argNodes: readonly ts.Expression[],
  what: string,
  loc: SrcLoc,
): IrExpr {
  const cbLowered = lowerer.lowerExpr(cbNode);
  let boxedCb: IrExpr;
  if (cbLowered.type.kind === "dyn") {
    boxedCb = cbLowered;
  } else if (
    cbLowered.type.kind === "func" &&
    canBoxFuncIntoDyn(
      cbLowered.type,
      (id) => lowerer.shapes.get(id),
      (id) => lowerer.unions.get(id),
    )
  ) {
    boxedCb = { kind: "dynFrom", value: cbLowered, type: DYN, loc };
  } else {
    lowerer.noLowering(
      `${what} with trailing arguments and a '${lowerer.fmt(cbLowered.type)}' callback`,
      cbNode,
      "the callback must be a boxable function (or wrap it: () => cb(...))",
    );
  }
  const args = argNodes.map((a) => lowerer.lowerExprExpecting(a, DYN));
  const n = args.length;
  const toT: IrType = { kind: "func", params: [], ret: VOID };
  const key = `timer.argsthunk:${n}`;
  const existing = lowerer.arrHofHelpers.get(key);
  const name = existing ?? keyedHelperName(lowerer, "%timer.argsthunk", key);
  if (!existing) {
    lowerer.arrHofHelpers.set(key, name);
    const impl = `${name}.impl`;
    const capIds = ["f.0", ...args.map((_, i) => `a${i}.0`)];
    const capNames = ["f", ...args.map((_, i) => `a${i}`)];
    lowerer.liftedFns.push({
      name: impl,
      params: [],
      returnType: VOID,
      captures: capIds.map((id, i) => ({ localId: id, name: capNames[i]!, type: DYN })),
      locals: capIds.map((id, i) => ({
        id,
        name: capNames[i]!,
        type: DYN,
        mutable: false,
        boxed: true,
      })),
      body: [
        {
          kind: "exprStmt",
          expr: {
            kind: "dynCall",
            callee: { kind: "varRef", localId: "f.0", type: DYN, loc },
            calleeName: "callback",
            receiver: { kind: "libCall", fn: "dyn.this", args: [], type: DYN, loc },
            args: args.map(
              (_, i) => ({ kind: "varRef", localId: `a${i}.0`, type: DYN, loc }) as IrExpr,
            ),
            type: DYN,
            loc,
          },
          loc,
        },
      ],
      loc,
    });
    lowerer.liftedFns.push({
      name,
      params: capIds.map((id, i) => ({ localId: id, name: capNames[i]!, type: DYN })),
      returnType: toT,
      locals: capIds.map((id, i) => ({
        id,
        name: capNames[i]!,
        type: DYN,
        mutable: false,
        boxed: true,
      })),
      body: [
        {
          kind: "return",
          value: { kind: "closure", fnName: impl, captures: capIds, type: toT, loc },
          loc,
        },
      ],
      loc,
    });
  }
  return { kind: "call", callee: name, args: [boxedCb, ...args], type: toT, loc };
}

/** The timer surface's member names — the ambient globals AND the
 * node:timers module's exports (one set: Node's timers module re-exports
 * the globals). */
export const TIMER_MODULE_MEMBERS: ReadonlySet<string> = new Set([
  "setTimeout",
  "clearTimeout",
  "setInterval",
  "clearInterval",
  "setImmediate",
  "clearImmediate",
]);

/** Node tolerates clearTimeout/clearInterval/clearImmediate of anything
 * that is not a live handle — null, undefined, plain objects, or no
 * argument at all are no-ops without an error. The SYNTACTICALLY side-effect-free
 * spellings of those (the shapes Node's own tests use) lower to the
 * dropped VOID no-op; an expression that must evaluate keeps the typed
 * path. Null when the argument might be a real handle. */
function tolerantClearNoop(lowerer: Lowerer, expr: ts.CallExpression, loc: SrcLoc): IrExpr | null {
  const noop: IrExpr = { kind: "libCall", fn: "timers.clearNoop", args: [], type: VOID, loc };
  if (expr.arguments.nodes.length === 0) return noop;
  if (expr.arguments.nodes.length !== 1) return null;
  let arg = expr.arguments.nodes[0]!;
  // `{} as never` / parenthesized spellings: the cast changes no value.
  while (ts.isAsExpression(arg) || ts.isTypeAssertion(arg) || ts.isParenthesizedExpression(arg))
    arg = arg.expression;
  if (arg.kind === ts.SyntaxKind.NullKeyword) return noop;
  if (ts.isObjectLiteralExpression(arg) && arg.properties.nodes.length === 0) return noop;
  if (ts.isIdentifier(arg)) {
    const t = lowerer.mapTypeOf(lowerer.typeOf(arg));
    if (t && (t.kind === "nullT" || t.kind === "undefinedT")) return noop;
    if (arg.text === "undefined") return noop;
  }
  return null;
}

/** A clear's handle as the f64 id it passes to the runtime. A handle that
 * may be undefined or null (`let timer: Timeout | undefined`) passes 0
 * when absent: no timer has id 0, so the clear does nothing, as Node's
 * clearTimeout(undefined) does. Other handle types are returned as they
 * are. */
function optionalTimerHandle(lowerer: Lowerer, handle: IrExpr, loc: SrcLoc): IrExpr {
  if (handle.type.kind !== "union") return handle;
  const arms = lowerer.unions.get(handle.type.unionId)?.arms ?? [];
  const present = arms.filter((arm) => !isUnitType(arm));
  if (present.length !== 1 || present[0]!.kind !== "f64") return handle;
  return { kind: "nullish", left: handle, right: numLit(0, loc), type: F64, loc };
}

const MOCKABLE_TIMER_FNS: ReadonlySet<string> = new Set([
  "timers.setTimeout",
  "timers.setTimeoutHandle",
  "timers.setInterval",
  "timers.clearTimeout",
  "timers.clearInterval",
  "timers.setImmediate",
  "timers.clearImmediate",
]);

/** Whether a timer call's callee is an ESM named or namespace import of
 * node:timers (destructured bindings included): Node's mock.timers leaves
 * those bindings alone and replaces the globals. */
function isRealTimerCallee(lowerer: Lowerer, callee: ts.Expression): boolean {
  if (ts.isIdentifier(callee)) return lowerer.builtinImportOf(callee)?.module === "timers";
  if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) {
    const sym = lowerer.checker.getSymbolAtLocation(callee.expression);
    const decl = sym ? sym.declarations[0] : undefined;
    return decl !== undefined && ts.isNamespaceImport(decl);
  }
  return false;
}

/** Marks a lowered timer call `realTimer` when its callee is a binding
 * mock.timers does not replace. A call whose delay is stored first returns a
 * `seqExpr` around the call, so the mark goes on the call inside it. */
function markRealTimerCall(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  lowered: IrExpr | null,
): IrExpr | null {
  const call = lowered?.kind === "seqExpr" ? lowered.result : lowered;
  if (call?.kind !== "libCall" || !MOCKABLE_TIMER_FNS.has(call.fn)) return lowered;
  if (!isRealTimerCallee(lowerer, expr.expression)) return lowered;
  const marked: IrExpr = { ...call, realTimer: true };
  return lowered?.kind === "seqExpr" ? { ...lowered, result: marked } : marked;
}

/** One timer call by MEMBER NAME — the shared lowering behind the ambient
 * globals, the node:timers named/destructured imports, and the namespace
 * form (`timers.setTimeout(...)`). Null when the member isn't a lowered
 * timer function (the caller's fence machinery takes over). */
export function lowerTimersMemberCall(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  member: string,
  loc: SrcLoc,
): IrExpr | null {
  return markRealTimerCall(lowerer, expr, lowerTimerCall(lowerer, expr, member, loc));
}

function lowerTimerCall(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  member: string,
  loc: SrcLoc,
): IrExpr | null {
  // Delayed timers share callback adaptation and the 1ms default. Trailing
  // arguments are captured now and delivered when the callback fires.
  if (member === "setTimeout" || member === "setInterval") {
    if (expr.arguments.nodes.length === 0) {
      lowerer.noLowering(
        `${member} with 0 arguments`,
        expr,
        `the supported form is ${member}(callback, ms?, ...args)`,
      );
    }
    const cb = withTimerThis(
      lowerer,
      expr.arguments.nodes[0]!,
      expr.arguments.nodes.length > 2
        ? makeTimerArgsThunk(
            lowerer,
            expr.arguments.nodes[0]!,
            expr.arguments.nodes.slice(2),
            member,
            loc,
          )
        : adaptZeroArgTimerCallback(
            lowerer,
            lowerer.lowerExpr(expr.arguments.nodes[0]!),
            expr.arguments.nodes[0]!,
            loc,
          ),
      loc,
    );
    // An omitted delay is NaN, Node's undefined: the loop clamps it to
    // 1ms, and mock.timers queues it to run at the next tick.
    let warned = false;
    let throwingDelay = false;
    // An element read past the end is undefined in Node, which warns
    // nothing; here it reads as NaN, so the runtime skips the NaN warning.
    let delayNode = expr.arguments.nodes[1];
    while (delayNode !== undefined && ts.isParenthesizedExpression(delayNode))
      delayNode = delayNode.expression;
    const delayKind =
      (isRealTimerCallee(lowerer, expr.expression) ? 2 : member === "setInterval" ? 1 : 0) +
      (delayNode !== undefined && ts.isElementAccessExpression(delayNode) ? 4 : 0);
    let ms: IrExpr =
      expr.arguments.nodes.length >= 2
        ? lowerer.lowerExpr(expr.arguments.nodes[1]!)
        : { kind: "numLit", value: NaN, type: F64, loc };
    if (ms.type.kind === "union" && !hasBoolArm(lowerer, ms.type)) {
      // A delay that may be undefined: an optional `ms?: number` passed on,
      // or an element read (`delays[0]`) whose storage keeps the
      // out-of-range undefined. Node converts the delay with ToNumber
      // (`after *= 1`), so undefined is NaN, the omitted delay.
      ms = lowerOptionalNumber(lowerer, ms, loc, expr.arguments.nodes[1]);
      // The defined arm is never the undefined, so an element read's NaN
      // there warns.
      if (ms.type.kind === "f64") warned = warnOnDefinedDelay(ms, delayKind & 3, loc);
    }
    // Any other delay that is not a number (a boolean such as execa's
    // `forceKillAfterTimeout = true` default, a BigInt, a string, another
    // union) converts through the checked-dynamic path below.
    if (ms.type.kind !== "f64" && ms.type.kind !== "dyn" && lowerer.dynConvertible(ms.type)) {
      ms = lowerer.coerceToExpected(ms, DYN);
    }
    if (ms.type.kind === "dyn") {
      // An untyped delay converts as Node's `after *= 1` does: ToNumber,
      // with the TypeError a BigInt throws there. Undefined stays the
      // omitted delay (Node's `after === undefined` branch), tested before
      // the conversion, so a NaN after it warns, element reads included.
      const tmp = lowerer.declareHiddenLocal("%timerDelay", DYN);
      const stable: IrExpr = { kind: "varRef", localId: tmp.id, type: DYN, loc };
      const converted: IrExpr = {
        kind: "dynCheck",
        value: {
          kind: "libCall",
          fn: "dyn.arithmetic",
          args: [
            stable,
            { kind: "dynFrom", value: numLit(1, loc), type: DYN, loc },
            { kind: "strLit", value: "*", type: STRING, loc },
          ],
          type: DYN,
          loc,
        },
        type: F64,
        loc,
      };
      ms = {
        kind: "seqExpr",
        stmts: [{ kind: "varDecl", localId: tmp.id, init: ms, loc }],
        result: {
          kind: "ternary",
          cond: { kind: "dynTest", test: "undefined", value: stable, type: BOOL, loc },
          then: { kind: "numLit", value: NaN, type: F64, loc },
          else_: userDelay(converted, delayKind & 3, loc),
          type: F64,
          loc,
        },
        type: F64,
        loc,
      };
      warned = true;
      throwingDelay = true;
    }
    // A delay Node sets to 1 emits its Timeout warning; a literal delay in
    // range needs no check, and an omitted delay is undefined, which warns
    // nothing.
    if (
      !warned &&
      expr.arguments.nodes.length >= 2 &&
      ms.type.kind === "f64" &&
      !(ms.kind === "numLit" && ms.value >= 1 && ms.value <= 2147483647)
    ) {
      ms = userDelay(ms, delayKind, loc);
    }
    // A delay conversion that can throw (a BigInt) runs after the callback
    // is built: the callback and the converted delay wait in hidden locals,
    // so a throw leaves only the callback's local, which the frame
    // releases.
    let callback = cb;
    const callbackFirst: IrStmt[] = [];
    if (throwingDelay) {
      const held = lowerer.declareHiddenLocal("%timerCallback", cb.type);
      const delay = lowerer.declareHiddenLocal("%timerDelayMs", F64);
      callbackFirst.push(
        { kind: "varDecl", localId: held.id, init: cb, loc },
        { kind: "varDecl", localId: delay.id, init: ms, loc },
      );
      callback = varRef(held.id, cb.type, loc);
      ms = varRef(delay.id, F64, loc);
    }
    const scheduled = (call: IrExpr): IrExpr =>
      callbackFirst.length === 0
        ? call
        : { kind: "seqExpr", stmts: callbackFirst, result: call, type: call.type, loc };
    if (member === "setInterval") {
      return scheduled({
        kind: "libCall",
        fn: "timers.setInterval",
        args: [callback, ms],
        type: F64,
        loc,
      });
    }
    // The use position decides the shape: a Timeout handle (mapped to
    // f64) when the call is USED (assigned, `.unref()`d, cleared) — the
    // clearable-handle timer; plain void in statement position (the
    // historic fire-and-forget setTimeout, no clear surface). Both ride
    // the same heap; only the handle form can be unref'd/cleared.
    const resultT = lowerer.mapTypeOf(lowerer.typeOf(expr));
    // A callback bound to its handle needs one, also in statement
    // position.
    const bindsThis = cb.kind === "libCall" && cb.fn === "timers.thisCallback";
    if (bindsThis || (resultT?.kind === "f64" && !ts.isExpressionStatement(expr.parent))) {
      return scheduled({
        kind: "libCall",
        fn: "timers.setTimeoutHandle",
        args: [callback, ms],
        type: F64,
        loc,
      });
    }
    return scheduled({
      kind: "libCall",
      fn: "timers.setTimeout",
      args: [callback, ms],
      type: VOID,
      loc,
    });
  }
  // clearTimeout(handle): shares the interval clear (the handle ids
  // share one space). An optional handle clears nothing when absent.
  if (member === "clearTimeout") {
    const noop = tolerantClearNoop(lowerer, expr, loc);
    if (noop) return noop;
    if (expr.arguments.nodes.length !== 1) {
      lowerer.noLowering(`clearTimeout with ${expr.arguments.nodes.length} arguments`, expr);
    }
    const handle = optionalTimerHandle(lowerer, untypedTimerHandle(lowerer, expr, loc), loc);
    if (handle.type.kind !== "f64") {
      lowerer.noLowering(
        `clearTimeout of '${lowerer.fmt(handle.type)}' handles`,
        expr.arguments.nodes[0]!,
        "the handle is the Timeout setTimeout returned, or undefined or null",
      );
    }
    return { kind: "libCall", fn: "timers.clearTimeout", args: [handle], type: VOID, loc };
  }
  if (member === "clearInterval") {
    const noop = tolerantClearNoop(lowerer, expr, loc);
    if (noop) return noop;
    if (expr.arguments.nodes.length !== 1) {
      lowerer.noLowering(`clearInterval with ${expr.arguments.nodes.length} arguments`, expr);
    }
    const handle = optionalTimerHandle(lowerer, untypedTimerHandle(lowerer, expr, loc), loc);
    if (handle.type.kind !== "f64") {
      lowerer.noLowering(
        `clearInterval of '${lowerer.fmt(handle.type)}' handles`,
        expr.arguments.nodes[0]!,
        "the handle is the Timeout setInterval returned, or undefined or null",
      );
    }
    return { kind: "libCall", fn: "timers.clearInterval", args: [handle], type: VOID, loc };
  }
  // setImmediate/clearImmediate: Node's check-phase pair. The handle is
  // the f64 immediate id (its own space — clearTimeout of an Immediate
  // no-ops, like Node); the callback adapts like setTimeout's.
  if (member === "setImmediate") {
    if (expr.arguments.nodes.length === 0) {
      lowerer.noLowering(
        "setImmediate with 0 arguments",
        expr,
        "the supported form is setImmediate(callback, ...args)",
      );
    }
    const cb = withTimerThis(
      lowerer,
      expr.arguments.nodes[0]!,
      expr.arguments.nodes.length > 1
        ? makeTimerArgsThunk(
            lowerer,
            expr.arguments.nodes[0]!,
            expr.arguments.nodes.slice(1),
            "setImmediate",
            loc,
          )
        : adaptZeroArgTimerCallback(
            lowerer,
            lowerer.lowerExpr(expr.arguments.nodes[0]!),
            expr.arguments.nodes[0]!,
            loc,
          ),
      loc,
    );
    return { kind: "libCall", fn: "timers.setImmediate", args: [cb], type: F64, loc };
  }
  if (member === "clearImmediate") {
    const noop = tolerantClearNoop(lowerer, expr, loc);
    if (noop) return noop;
    if (expr.arguments.nodes.length !== 1) {
      lowerer.noLowering(`clearImmediate with ${expr.arguments.nodes.length} arguments`, expr);
    }
    const handle = optionalTimerHandle(lowerer, untypedTimerHandle(lowerer, expr, loc), loc);
    if (handle.type.kind !== "f64") {
      lowerer.noLowering(
        `clearImmediate of '${lowerer.fmt(handle.type)}' handles`,
        expr.arguments.nodes[0]!,
        "the handle is the Immediate setImmediate returned, or undefined or null",
      );
    }
    return { kind: "libCall", fn: "timers.clearImmediate", args: [handle], type: VOID, loc };
  }
  return null;
}

/** The handle argument of a clear call. A checked-dynamic handle in
 * JavaScript (a timer callback's `this`, an untyped binding) clears when it
 * holds a number, the handle's representation; any other value clears
 * nothing, as Node's clear functions ignore values that are not timers. */
function untypedTimerHandle(lowerer: Lowerer, expr: ts.CallExpression, loc: SrcLoc): IrExpr {
  const handle = lowerer.lowerExpr(expr.arguments.nodes[0]!);
  if (handle.type.kind !== "dyn" || !isJsSourceFile(ts.getSourceFileOfNode(expr))) return handle;
  const stored = lowerer.declareHiddenLocal("%timer.clear", DYN);
  const ref = varRef(stored.id, DYN, loc);
  return {
    kind: "seqExpr",
    stmts: [{ kind: "varDecl", localId: stored.id, init: handle, loc }],
    result: {
      kind: "ternary",
      cond: { kind: "dynTest", test: "number", value: ref, type: BOOL, loc },
      then: lowerer.coerceInto(expr.arguments.nodes[0]!, ref, F64),
      else_: numLit(0, loc),
      type: F64,
      loc,
    },
    type: F64,
    loc,
  };
}

/** A JavaScript timer callback that may read `this` runs with `this`
 * bound to its handle, as Node calls it with the Timeout or Immediate
 * (scr_timer_this_callback). Arrows, and function expressions and
 * declarations that never read `this` in the body or in a parameter
 * initializer, keep the plain callback; an identifier resolves through a
 * `const` binding to its initializer, so a stored arrow or function is
 * classified the same way. Any other value (test/common's mustCall
 * wrapper, which forwards `this`) is bound. TypeScript files keep plain
 * callbacks: a plain function's `this` is refused there. */
function withTimerThis(lowerer: Lowerer, node: ts.Expression, cb: IrExpr, loc: SrcLoc): IrExpr {
  if (!isJsSourceFile(ts.getSourceFileOfNode(node)) || !callbackMayReadThis(lowerer, node))
    return cb;
  const fnT: IrType = { kind: "func", params: [], ret: VOID };
  const callable: IrExpr =
    cb.type.kind === "func" ? cb : { kind: "dynCheck", value: cb, type: fnT, loc };
  return { kind: "libCall", fn: "timers.thisCallback", args: [callable], type: fnT, loc };
}

function callbackMayReadThis(lowerer: Lowerer, node: ts.Expression): boolean {
  let callback = unparenthesized(node);
  const seen = new Set<ts.Node>();
  for (;;) {
    if (ts.isArrowFunction(callback)) return false;
    if (ts.isFunctionExpression(callback)) return ownThisIn(callback);
    if (!ts.isIdentifier(callback)) return true;
    const declaration = lowerer.resolveValueSymbol(callback)?.valueDeclaration;
    if (declaration && ts.isFunctionDeclaration(declaration) && declaration.body)
      return ownThisIn(declaration);
    // A `const` binding holds one value, so the callback is its initializer:
    // an arrow stored that way keeps the module's `this` like any other
    // arrow, and a function expression is classified by its own body.
    if (
      !declaration ||
      !ts.isVariableDeclaration(declaration) ||
      !declaration.initializer ||
      (ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const) === 0 ||
      seen.has(declaration)
    )
      return true;
    seen.add(declaration);
    callback = unparenthesized(declaration.initializer);
  }
}

function unparenthesized(node: ts.Expression): ts.Expression {
  let expression = node;
  while (ts.isParenthesizedExpression(expression)) expression = expression.expression;
  return expression;
}

/** Whether a function reads its own `this`: in its body, or in the
 * initializer of a parameter, which runs at entry with the same receiver
 * (`function (x = this) {}` called with no arguments). */
function ownThisIn(fn: ts.FunctionExpression | ts.FunctionDeclaration): boolean {
  if ((fn.parameters?.nodes ?? []).some((parameter) => readsOwnThis(parameter))) return true;
  return fn.body !== undefined && readsOwnThis(fn.body);
}

/** Whether `node` reads the enclosing function's `this`: a `this` outside
 * nested non-arrow functions and classes, which bind their own. */
function readsOwnThis(node: ts.Node): boolean {
  if (node.kind === ts.SyntaxKind.ThisKeyword) return true;
  if (
    (ts.isFunctionLike(node) && !ts.isArrowFunction(node)) ||
    ts.isClassDeclaration(node) ||
    ts.isClassExpression(node)
  )
    return false;
  return ts.forEachChild(node, (child) => (readsOwnThis(child) ? true : undefined)) === true;
}

/** `timers.userDelay(ms, kind)`: the delay, after the warning Node's
 * Timeout constructor emits when it sets the delay to 1. `kind` is 0 for
 * the global setTimeout, 1 for the global setInterval (mock.timers mocks
 * both) and 2 for a node:timers import (which it leaves alone), plus 4 for
 * a delay read from an array element. */
function userDelay(ms: IrExpr, kind: number, loc: SrcLoc): IrExpr {
  return { kind: "libCall", fn: "timers.userDelay", args: [ms, numLit(kind, loc)], type: F64, loc };
}

/** An optional delay (lowerOptionalNumber's undefined-or-number ternary):
 * only the defined arm warns, since Node sets an undefined delay to 1
 * without a warning. Answers whether the check was placed. */
function warnOnDefinedDelay(ms: IrExpr, kind: number, loc: SrcLoc): boolean {
  const choice = ms.kind === "seqExpr" ? ms.result : ms;
  if (choice.kind !== "ternary") return false;
  choice.else_ = userDelay(choice.else_, kind, loc);
  return true;
}

function hasBoolArm(lowerer: Lowerer, type: IrType): boolean {
  return (
    type.kind === "union" &&
    (lowerer.unions.get(type.unionId)?.arms.some((arm) => arm.kind === "bool") ?? false)
  );
}
