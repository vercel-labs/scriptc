import { boolLit, countedFor, numLit, varRef } from "../../../ir/build.js";
import { transformStmtList } from "../../../ir/traverse.js";
import type { ScrDiagnostic } from "../../../diagnostics/diagnostic.js";
import { InternalCompilerError } from "../../../errors.js";
import { canAssertClassValue, checkedClassAssertion } from "../class-assertions.js";
import * as ts from "../../ts7/adapter.js";
import { PoisonError, type Lowerer } from "../lowerer.js";
import {
  BOOL,
  DYN,
  F64,
  type IrExpr,
  type IrFunction,
  type IrLocal,
  type IrParam,
  type IrStmt,
  type IrType,
  STRING,
  type SrcLoc,
  UNDEFINED_T,
  VOID,
  arrayOf,
  funcOf,
  isSortValuesElement,
  isUnitType,
  typeEquals,
} from "../../../ir/ir.js";
import { isJsSourceFile, locOf } from "../../program.js";
import { buildArraySortFn } from "../lower-array-sort.js";
import {
  arrayIndexPresent,
  arrayValueRead,
  arrayValueStore,
  arrayValueType,
  currentArrayIndexPresent,
} from "../array-values.js";
import { typeKey } from "../../type-mapper.js";
import {
  lowerArrayCallback,
  requireProducedArrayElement,
  callbackArrayElement,
} from "./callback-arguments.js";
import {
  reverseArrayLoop,
  arrayLengthDeclaration,
  arrayCallbackParams,
  arrayCallbackLocals,
  callArrayCallback,
} from "./array-iteration.js";
import { dynamicReceiverThrows } from "./dynamic-receivers.js";
import { defaultAfterUndefined, lowerStaticallyUndefinedArgument } from "../optional-arguments.js";

/** `a.map(fn)` / `a.filter(fn)` / `a.forEach(fn)` desugar to a direct
 * call of a synthetic module function — one per method + element/result
 * type + callback-arity combination, interned — whose body is a plain
 * loop over EXISTING IR nodes (varDecl/for/arrayGet/callValue/push/
 * return). No new IR kinds, no backend or runtime involvement. JS
 * semantics: the length is read ONCE up front (Array.prototype.map/
 * filter/forEach cache it — elements appended by the callback are not
 * visited), elements are read fresh each iteration, callbacks run
 * left-to-right and receive whatever prefix of (element, index, array)
 * they declare. */
export function lowerArrayHofCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
  method: "map" | "filter" | "forEach",
  elem: IrType,
): IrExpr {
  const loc = locOf(call);
  const receiver = lowerer.lowerExpr(access.expression);
  const argNode = call.arguments[0];
  if (!argNode) lowerer.unsupported("SC1090", call, "this call form"); // tsc-guarded
  const booleanFilter =
    method === "filter" &&
    ts.isIdentifier(argNode) &&
    argNode.text === "Boolean" &&
    lowerer.isStdlibSymbol(lowerer.resolveValueSymbol(argNode) ?? undefined);
  const valueT = arrayValueType(lowerer, elem);
  if (booleanFilter) {
    if (valueT.kind === "union") lowerer.requireTruthyUnion(valueT.unionId, argNode);
    if (
      valueT.kind === "dyn" ||
      valueT.kind === "jsval" ||
      valueT.kind === "void" ||
      isUnitType(valueT)
    ) {
      lowerer.badType(argNode, lowerer.typeOf(argNode));
    }
  }
  const callback = booleanFilter
    ? { fnArg: truthyFilterCallback(lowerer, valueT, loc), arity: 1 }
    : lowerArrayCallback(lowerer, argNode, [valueT], arrayOf(elem));
  const { fnArg, arity } = callback;
  const fnRet = fnArg.type.ret;
  if (method === "map" && (fnRet.kind === "void" || fnRet.kind === "func")) {
    // The result array U[] is unrepresentable here (no void elements;
    // the map helper's closure-returning form has no fixture-backed
    // story yet).
    lowerer.badType(call, lowerer.typeOf(call));
  }
  if (method === "map") requireProducedArrayElement(lowerer, call, "'.map()'", fnRet);
  // JS applies ToBoolean to whatever the predicate answers, so a non-bool
  // result is not an error — the filter loop wraps the call in the same
  // toBool an `if` statement would apply. The island/dyn shapes, whose
  // truthiness needs the engine, and void, whose real answer the ABI has
  // already discarded, keep the fence. No separate
  // requireTruthyUnion call belongs here: its check (no dyn/caught arm)
  // IS filterPredicateOk's union branch, so it could never speak.
  if (method === "filter" && !filterPredicateOk(lowerer, fnRet)) {
    if (fnRet.kind === "void") {
      lowerer.unsupported(
        "SC1090",
        argNode,
        "'.filter()' with a void-returning predicate (the callback return value is erased before its truthiness can be tested)",
      );
    }
    lowerer.badType(argNode, lowerer.typeOf(argNode));
  }
  const outElem =
    method === "filter"
      ? filterResultElem(lowerer, call, argNode, elem, valueT, booleanFilter)
      : callbackArrayElement(lowerer, call, fnRet);
  // A filter that re-tags its elements keeps the single union-typed visit.
  const fast =
    booleanFilter || (method === "filter" && !typeEquals(outElem, elem))
      ? null
      : lowerFastCallback(lowerer, argNode, [valueT], 0, elem, arrayOf(elem), callback);
  const helper = arrayHofHelper(
    lowerer,
    method,
    elem,
    fnRet,
    arity,
    loc,
    outElem,
    callbackSite(fast ?? fnArg),
    fast?.type ?? null,
  );
  const resultType: IrType = method === "map" || method === "filter" ? arrayOf(outElem) : VOID;
  return {
    kind: "call",
    callee: helper,
    args: [receiver, fnArg, ...(fast ? [fast] : [])],
    type: resultType,
    loc,
  };
}

/** The checker-selected element of a filter result, with the same trust
 * boundary as the historical narrowing filter: an inferred inline type
 * predicate may prove one source arm; a written predicate annotation may
 * not. Boolean is safe when every discarded arm is a nullish unit. */
function filterResultElem(
  lowerer: Lowerer,
  call: ts.CallExpression,
  argNode: ts.Expression,
  elem: IrType,
  valueT: IrType,
  booleanFilter: boolean,
): IrType {
  const callT = lowerer.typeOf(call);
  const result = lowerer.mapTypeOf(callT);
  let outElem = result?.kind === "array" ? result.elem : elem;
  const access = ts.isPropertyAccessExpression(call.expression) ? call.expression : null;
  const checkerReceiver = access ? lowerer.mapTypeOf(lowerer.typeOf(access.expression)) : null;
  // Equal checker elements mean the filter introduces no new refinement.
  // Preserve the stored element layout even if an earlier predicate or
  // evolving-any analysis changed the receiver's flow type.
  if (
    result?.kind === "array" &&
    checkerReceiver?.kind === "array" &&
    typeEquals(result.elem, checkerReceiver.elem)
  ) {
    return elem;
  }
  if (!typeEquals(outElem, elem)) {
    const contextual = lowerer.mapTypeOf(lowerer.checker.getContextualType(call) ?? callT);
    if (contextual?.kind === "array" && typeEquals(contextual.elem, elem)) outElem = elem;
  }
  if (typeEquals(outElem, elem)) return elem;

  const annotateEscape =
    "keep the receiver's element type instead — annotate the callback's return ': boolean' " +
    "(the checker then skips the predicate) or annotate the result with the receiver's own " +
    "element type — and narrow the elements after";
  if (!booleanFilter) {
    if (!ts.isArrowFunction(argNode) && !ts.isFunctionExpression(argNode)) {
      lowerer.unsupported(
        "SC1090",
        argNode,
        `narrowing '.filter' through a callback VALUE (only an inline callback whose predicate ` +
          `the checker inferred can re-tag — ${annotateEscape})`,
      );
    }
    if (argNode.type) {
      lowerer.unsupported(
        "SC1090",
        argNode,
        `narrowing '.filter' with a hand-written type predicate (a written 'x is T' is an ` +
          `unchecked assertion nothing validates at runtime — ${annotateEscape})`,
      );
    }
  }
  const classRefinement =
    !booleanFilter && outElem.kind === "object" && canAssertClassValue(lowerer, valueT, outElem);
  if (
    !classRefinement &&
    (valueT.kind !== "union" || lowerer.armTag(valueT.unionId, outElem) < 0)
  ) {
    const multiArm = outElem.kind === "union";
    lowerer.unsupported(
      "SC1090",
      call,
      `'.filter' narrowing '${lowerer.fmt(elem)}' elements to ` +
        `${multiArm ? `the multi-arm '${lowerer.fmt(outElem)}'` : `'${lowerer.fmt(outElem)}'`} ` +
        `(${multiArm ? "only a SINGLE arm re-tags" : "only a single runtime arm re-tags"} — ${annotateEscape})`,
    );
  }
  if (booleanFilter && valueT.kind === "union") {
    const arms = lowerer.unions.get(valueT.unionId)?.arms ?? [];
    if (arms.some((arm) => !typeEquals(arm, outElem) && !isUnitType(arm))) {
      lowerer.unsupported(
        "SC1090",
        call,
        `'.filter(Boolean)' narrowing '${lowerer.fmt(elem)}' to '${lowerer.fmt(outElem)}' ` +
          "when another truthy arm could survive",
      );
    }
  }
  return outElem;
}

/** A native closure for the ambient Boolean callback. Reifying the
 * JavaScript constructor itself is unnecessary; Array#filter only observes
 * its one-argument ToBoolean result. */
function truthyFilterCallback(
  lowerer: Lowerer,
  valueT: IrType,
  loc: SrcLoc,
): IrExpr & { type: IrType & { kind: "func" } } {
  const fnT: IrType & { kind: "func" } = { kind: "func", params: [valueT], ret: BOOL };
  const key = `filterBoolean:${typeKey(valueT)}`;
  let name = lowerer.arrHofHelpers.get(key);
  if (!name) {
    name = `%arr.filterBoolean.${lowerer.arrHofHelpers.size}`;
    lowerer.arrHofHelpers.set(key, name);
    const value = varRef("v.0", valueT, loc);
    lowerer.liftedFns.push({
      name,
      params: [{ localId: "v.0", name: "v", type: valueT }],
      returnType: BOOL,
      locals: [{ id: "v.0", name: "v", type: valueT, mutable: false }],
      body: [{ kind: "return", value: { kind: "toBool", operand: value, type: BOOL, loc }, loc }],
      loc,
    });
  }
  return { kind: "closure", fnName: name, captures: [], type: fnT, loc };
}

/** The predicate result kinds `.filter()` accepts. JS applies ToBoolean to
 * whatever the callback answers, so a bool is not required: the scalars and
 * the reference kinds have constant or by-value answers, checked-dynamic
 * values ask their runtime kind, and a union is fine when every arm does.
 * void/jsval/caught stay out — see below. */
function filterPredicateOk(lowerer: Lowerer, ret: IrType): boolean {
  if (ret.kind === "bool") return true;
  // VOID is a TYPE erasure, not a runtime value: TS lets a value-returning
  // function sit in a void-returning slot (`const p: (n: number) => void =
  // (n) => n`), so the predicate's real answer can be truthy while the
  // compiled ABI has already discarded it. Treating void as constantly
  // falsy would silently answer [] where Node answers [1]. Fenced until
  // the returned value can be preserved through the void ABI.
  // A checked-dynamic value retains its runtime kind, so scr_dyn_truthy can
  // apply JavaScript ToBoolean exactly. Island and caught values stay out.
  if (ret.kind === "void") return false;
  if (ret.kind === "dyn") return true;
  if (ret.kind === "jsval" || ret.kind === "caught") return false;
  if (ret.kind === "union") {
    const def = lowerer.unions.get(ret.unionId);
    return def !== undefined && def.arms.every((a) => a.kind !== "dyn" && a.kind !== "caught");
  }
  return true;
}

/** The filter loop's condition: the predicate's result put through JS
 * ToBoolean. A bool answer is already the condition; everything else takes
 * the same `toBool` wrapper an `if` statement would apply (a union answer
 * routes through its interned per-arm truthy helper). */
function filterCond(call: IrExpr, fnRet: IrType, loc: SrcLoc): IrExpr {
  if (fnRet.kind === "bool") return call;
  // No constant-false arm here: void is fenced at the call site, and a
  // bare undefinedT/nullT return cannot arise (mapType sends `undefined`/
  // `void` returns to void and a standalone `null` return to the unit-ONLY
  // UNION, which routes through toBool below; ir/validate.ts rejects a
  // bare unit return type outright). filterPredicateOk already rejected
  // unsafe union arms (dyn/caught) at the call site, where a real node
  // exists for the diagnostic. A bare dyn value is handled directly by
  // the runtime's kind-aware ToBoolean.
  return { kind: "toBool", operand: call, type: BOOL, loc };
}

type CallbackType = IrType & { kind: "func" };

/** Nested HOFs inside a fast lowering keep their single union visit, so
 * duplication stays linear in nesting depth. */
let fastLoweringDepth = 0;

/** Array reads widen elements with undefined so holes and present
 * undefined stay observable, which makes every callback parameter a boxed
 * `T | undefined`. For an inline arrow over a plain element type, lower the
 * callback a second time with the element type itself. The helper then
 * splits each visit on the element state: a present value calls this fast
 * closure with the plain element (no union box, no per-use undefined
 * test), and a hole or present undefined calls the original closure with
 * the undefined arm. Both closures share the same capture boxes and body,
 * so every observable effect is the same; arrows have no own `this`,
 * `arguments` or self binding that could tell the two apart. Any refusal
 * in the second lowering is discarded and keeps the single visit. */
function lowerFastCallback(
  lowerer: Lowerer,
  argNode: ts.Expression,
  lead: IrType[],
  elemIndex: number,
  elem: IrType,
  arrT: IrType,
  slow: { fnArg: IrExpr & { type: CallbackType }; arity: number },
  bindUntyped = false,
  expectedReturn?: IrType,
): (IrExpr & { type: CallbackType }) | null {
  const valueT = lead[elemIndex];
  if (
    fastLoweringDepth > 0 ||
    slow.arity <= elemIndex ||
    !ts.isArrowFunction(argNode) ||
    isJsSourceFile(argNode.getSourceFile()) ||
    valueT?.kind !== "union" ||
    typeEquals(valueT, elem) ||
    elem.kind === "union" ||
    elem.kind === "dyn" ||
    elem.kind === "jsval" ||
    isUnitType(elem)
  )
    return null;
  const fastLead = lead.slice();
  fastLead[elemIndex] = elem;
  // The optional-read prepass binds an unannotated element parameter to
  // the array's runtime value type. Rebind it to the plain element for
  // this lowering only.
  const param = argNode.parameters[elemIndex];
  if (!param || param.initializer || param.dotDotDotToken || !ts.isIdentifier(param.name))
    return null;
  const symbol = param.type ? undefined : lowerer.checker.getSymbolAtLocation(param.name);
  const previousBinding = symbol ? lowerer.runtimeOptionalBindingTypes.get(symbol) : undefined;
  if (symbol) lowerer.runtimeOptionalBindingTypes.set(symbol, elem);
  const sink: ScrDiagnostic[] = [];
  const previousSink = lowerer.diagSink;
  lowerer.diagSink = sink;
  fastLoweringDepth++;
  let fast: { fnArg: IrExpr & { type: CallbackType }; arity: number };
  try {
    fast = lowerArrayCallback(lowerer, argNode, fastLead, arrT, bindUntyped, expectedReturn);
  } catch (e) {
    if (e instanceof PoisonError) return null;
    throw e;
  } finally {
    fastLoweringDepth--;
    lowerer.diagSink = previousSink;
    if (symbol) {
      if (previousBinding === undefined) lowerer.runtimeOptionalBindingTypes.delete(symbol);
      else lowerer.runtimeOptionalBindingTypes.set(symbol, previousBinding);
    }
  }
  const fastT = fast.fnArg.type;
  const slowT = slow.fnArg.type;
  if (
    fast.fnArg.kind !== "closure" ||
    fast.arity !== slow.arity ||
    !typeEquals(fastT.ret, slowT.ret) ||
    !fastT.params.every((param, i) => typeEquals(param, i === elemIndex ? elem : slowT.params[i]!))
  )
    return null;
  return fast.fnArg;
}

/** `a[i]` holds a value (array state 1): neither a hole nor a present
 * undefined. */
function presentValue(arr: IrExpr, index: IrExpr, loc: SrcLoc): IrExpr {
  return {
    kind: "bin",
    op: "===",
    left: { kind: "arrayState", arr, index, type: F64, loc },
    right: numLit(1, loc),
    type: BOOL,
    loc,
  };
}

/** Route a helper's callback calls through the split visit: every
 * `f(<arrayValueRead a[i]>, ...)` becomes
 * `state(a, i) === 1 ? fast(a[i], ...) : f(undefined, ...)`. The read is
 * the call's only effectful operand (the rest are the loop's index and
 * array locals), so evaluation order is unchanged. The fast closure is an
 * extra trailing parameter. */
function withFastCallback(fn: IrFunction, fastT: CallbackType | null, elem: IrType): IrFunction {
  if (!fastT) return fn;
  const isValueRead = (e: IrExpr): e is IrExpr & { kind: "ternary" } =>
    e.kind === "ternary" &&
    e.cond.kind === "bin" &&
    e.cond.op === "===" &&
    e.cond.left.kind === "arrayState" &&
    e.cond.right.kind === "numLit" &&
    e.cond.right.value === 1;
  const split = (e: IrExpr): { cond: IrExpr; fast: IrExpr; slow: IrExpr } | null => {
    if (e.kind !== "callValue" || e.callee.kind !== "varRef" || e.callee.localId !== "f.0")
      return null;
    const at = e.args.findIndex(isValueRead);
    if (at < 0) return null;
    const read = e.args[at]!;
    if (read.kind !== "ternary") return null;
    const condition = read.cond;
    if (condition.kind !== "bin") return null;
    const state = condition.left;
    if (state.kind !== "arrayState") return null;
    const fastArgs = e.args.slice();
    fastArgs[at] = {
      kind: "arrayGet",
      arr: state.arr,
      index: state.index,
      type: elem,
      loc: read.loc,
    };
    const slowArgs = e.args.slice();
    slowArgs[at] = read.else_;
    return {
      cond: read.cond,
      fast: { ...e, callee: varRef("fast.0", fastT, e.callee.loc), args: fastArgs },
      slow: { ...e, args: slowArgs },
    };
  };
  const body = transformStmtList(fn.body, {
    stmt: (stmt) => {
      if (stmt.kind !== "exprStmt") return stmt;
      const parts = split(stmt.expr);
      if (!parts) return stmt;
      return {
        kind: "if",
        cond: parts.cond,
        then: [{ kind: "exprStmt", expr: parts.fast, loc: stmt.loc }],
        else_: [{ kind: "exprStmt", expr: parts.slow, loc: stmt.loc }],
        loc: stmt.loc,
      };
    },
    expr: (expr) => {
      const parts = split(expr);
      if (!parts) return expr;
      return {
        kind: "ternary",
        cond: parts.cond,
        then: parts.fast,
        else_: parts.slow,
        type: expr.type,
        loc: expr.loc,
      };
    },
  });
  return {
    ...fn,
    params: [...fn.params, { localId: "fast.0", name: "fast", type: fastT }],
    locals: [...fn.locals, { id: "fast.0", name: "fast", type: fastT, mutable: true }],
    body,
  };
}

/** The interning suffix for a callback argument. A literal closure (an
 * inline arrow or function expression) gets a helper of its own, so the
 * helper's only incoming callback is one known function: the backend's
 * constant-callback census then calls it directly and LLVM can inline the
 * callback into the loop (TurboFan's builtin+callback inlining). Callback
 * values keep the shared, type-interned helper. */
function callbackSite(fnArg: IrExpr): string {
  return fnArg.kind === "closure" ? `@${fnArg.fnName}` : "";
}

/** Interned synthetic loop function for one (method, elem, fnRet, arity)
 * combo. Named `%arr.<method>.<n>` ('%' keeps it out of the user
 * namespace); rides `liftedFns` into the module like a lifted lambda (it
 * is a plain function — no captures). */
function arrayHofHelper(
  lowerer: Lowerer,
  method: "map" | "flatMap" | "filter" | "forEach",
  elem: IrType,
  fnRet: IrType,
  arity: number,
  loc: SrcLoc,
  outElem: IrType = fnRet,
  site = "",
  fastT: CallbackType | null = null,
): string {
  const key = `${method}:${typeKey(elem)}:${typeKey(fnRet)}:${arity}:${typeKey(outElem)}${site}${fastT ? ":split" : ""}`;
  const existing = lowerer.arrHofHelpers.get(key);
  if (existing) return existing;
  const name = `%arr.${method}.${lowerer.arrHofHelpers.size}`;
  lowerer.arrHofHelpers.set(key, name);
  const fn = buildArrayHofFn(lowerer, name, method, elem, fnRet, arity, loc, outElem, fastT);
  lowerer.liftedFns.push(fastT ? withFastCallback(fn, fastT, elem) : fn);
  return name;
}

/** The TS 5.2+ callable-union array rule: a `T[] | U[]` receiver exposes
 * common HOFs with a callback over `T | U`. The runtime value remains the
 * original concrete array arm — never a copied `(T | U)[]` — and an
 * arm-specific function adapter wraps the element and receiver arguments
 * into the union-wide callback ABI. That preserves sparse-array reads,
 * callback mutation, and the callback's third-argument identity. */
export function lowerArrayUnionHofCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
  receiverT: IrType & { kind: "union" },
): IrExpr | null {
  const method = access.name.text;
  if (method !== "map" && method !== "forEach") return null;
  if (!lowerer.isStdlibMember(access)) return null;
  const def = lowerer.unions.get(receiverT.unionId);
  if (!def || def.arms.length < 2 || !def.arms.every((arm) => arm.kind === "array")) return null;
  if (call.arguments.length !== 1 || !call.arguments[0]) return null;
  const arrays = def.arms as (IrType & { kind: "array" })[];
  const valueArms: IrType[] = [];
  const addValueArm = (type: IrType): boolean => {
    if (
      type.kind === "dyn" ||
      type.kind === "jsval" ||
      type.kind === "caught" ||
      type.kind === "void"
    )
      return false;
    if (type.kind === "union") {
      const inner = lowerer.unions.get(type.unionId);
      if (!inner) return false;
      for (const arm of inner.arms) {
        if (!valueArms.some((candidate) => typeEquals(candidate, arm))) valueArms.push(arm);
      }
      return true;
    }
    if (!valueArms.some((candidate) => typeEquals(candidate, type))) valueArms.push(type);
    return true;
  };
  for (const array of arrays) {
    if (!addValueArm(array.elem)) return null;
  }
  const valueT: IrType =
    valueArms.length === 1
      ? valueArms[0]!
      : { kind: "union", unionId: lowerer.unions.intern(valueArms) };
  const argNode = call.arguments[0]!;
  const { fnArg, arity } = lowerArrayCallback(lowerer, argNode, [valueT], receiverT);
  const fnRet = fnArg.type.ret;
  if (method === "map" && (fnRet.kind === "void" || fnRet.kind === "func")) {
    lowerer.badType(call, lowerer.typeOf(call));
  }
  if (method === "map") requireProducedArrayElement(lowerer, call, "'.map()'", fnRet);
  const outElem = method === "map" ? callbackArrayElement(lowerer, call, fnRet) : VOID;
  const resultT: IrType = method === "map" ? arrayOf(outElem) : VOID;
  for (const array of arrays) {
    const armFnT = funcOf(
      [arrayValueType(lowerer, array.elem), F64, array].slice(0, arity),
      fnRet,
    ) as IrType & { kind: "func" };
    if (!lowerer.cleanFuncAdaptable(fnArg.type, armFnT)) return null;
  }
  const helper = arrayUnionHofHelper(
    lowerer,
    method,
    receiverT,
    arrays,
    fnArg.type,
    arity,
    fnRet,
    outElem,
    locOf(call),
  );
  return {
    kind: "call",
    callee: helper,
    args: [
      lowerer.coerceInto(access.expression, lowerer.lowerExpr(access.expression), receiverT),
      fnArg,
    ],
    type: resultT,
    loc: locOf(call),
  };
}

function arrayUnionHofHelper(
  lowerer: Lowerer,
  method: "map" | "forEach",
  receiverT: IrType & { kind: "union" },
  arrays: (IrType & { kind: "array" })[],
  callbackT: IrType & { kind: "func" },
  arity: number,
  fnRet: IrType,
  outElem: IrType,
  loc: SrcLoc,
): string {
  const resultT: IrType = method === "map" ? arrayOf(outElem) : VOID;
  const key = `union:${method}:${receiverT.unionId}:${typeKey(callbackT)}:${typeKey(resultT)}`;
  const existing = lowerer.arrHofHelpers.get(key);
  if (existing) return existing;
  const name = `%arr.union.${lowerer.arrHofHelpers.size}`;
  lowerer.arrHofHelpers.set(key, name);
  const receiver = varRef("a.0", receiverT, loc);
  const callback = varRef("f.0", callbackT, loc);
  const branch = (array: IrType & { kind: "array" }): IrStmt[] => {
    const tag = lowerer.armTag(receiverT.unionId, array);
    const concrete: IrExpr = {
      kind: "unionNarrow",
      unionId: receiverT.unionId,
      tag,
      value: receiver,
      type: array,
      loc,
    };
    const armFnT = funcOf(
      [arrayValueType(lowerer, array.elem), F64, array].slice(0, arity),
      fnRet,
    ) as IrType & { kind: "func" };
    const adapted = lowerer.coerceToExpected(callback, armFnT);
    if (!typeEquals(adapted.type, armFnT)) {
      throw new InternalCompilerError("lowerer bug: union-array callback stopped adapting");
    }
    const callee = arrayHofHelper(lowerer, method, array.elem, fnRet, arity, loc, outElem);
    const invoke: IrExpr = { kind: "call", callee, args: [concrete, adapted], type: resultT, loc };
    return resultT.kind === "void"
      ? [
          { kind: "exprStmt", expr: invoke, loc },
          { kind: "return", value: null, loc },
        ]
      : [{ kind: "return", value: invoke, loc }];
  };
  let body = branch(arrays[arrays.length - 1]!);
  for (let i = arrays.length - 2; i >= 0; i--) {
    const array = arrays[i]!;
    body = [
      {
        kind: "if",
        cond: {
          kind: "unionIsTag",
          unionId: receiverT.unionId,
          tag: lowerer.armTag(receiverT.unionId, array),
          negated: false,
          value: receiver,
          type: BOOL,
          loc,
        },
        then: branch(array),
        else_: body,
        loc,
      },
    ];
  }
  lowerer.liftedFns.push({
    name,
    params: [
      { localId: "a.0", name: "a", type: receiverT },
      { localId: "f.0", name: "f", type: callbackT },
    ],
    returnType: resultT,
    locals: [
      { id: "a.0", name: "a", type: receiverT, mutable: false },
      { id: "f.0", name: "f", type: callbackT, mutable: false },
    ],
    body,
    loc,
  });
  return name;
}

/** The loop body of one synthetic array HOF, from existing IR nodes:
 *
 *   map:     out = []; n = a.length; for (i = 0; i < n; i++) out.push(f(a[i])); return out;
 *   filter:  out = []; n = a.length; for (...) { v = a[i]; if (f(v)) out.push(v); } return out;
 *   forEach: n = a.length; for (...) f(a[i]);
 *
 * `filter` reads the element once into `v` so the callback and the push
 * see the same value even if the callback mutates `a[i]` (JS-exact).
 * `arity` is the callback's declared parameter count (1–3): the loop
 * passes the index and the receiver itself after the element when the
 * callback names them, exactly the arguments JS supplies. */
function buildArrayHofFn(
  lowerer: Lowerer,
  name: string,
  method: "map" | "flatMap" | "filter" | "forEach",
  elem: IrType,
  fnRet: IrType,
  arity: number,
  loc: SrcLoc,
  outElem: IrType,
  fastT: CallbackType | null = null,
): IrFunction {
  const arrT = arrayOf(elem);
  const valueT = arrayValueType(lowerer, elem);
  const fnT = funcOf([arrayValueType(lowerer, elem), F64, arrT].slice(0, arity), fnRet);

  const locals = arrayCallbackLocals(arrT, fnT);
  const params = arrayCallbackParams(arrT, fnT);
  const callF = (arg: IrExpr): IrExpr => callArrayCallback(arrT, fnT, fnRet, arity, arg, loc);
  const getElem = arrayValueRead(
    lowerer,
    varRef("a.0", arrT, loc),
    varRef("i.0", F64, loc),
    elem,
    loc,
  );
  const hasElem: IrExpr = {
    kind: "arrayHas",
    arr: varRef("a.0", arrT, loc),
    index: varRef("i.0", F64, loc),
    type: BOOL,
    loc,
  };
  const readLen = arrayLengthDeclaration(arrT, loc);
  const forLoop = (body: IrStmt[]): IrStmt => countedFor(loc, varRef("n.0", F64, loc), () => body);

  let returnType: IrType;
  let body: IrStmt[];
  if (method === "map" || method === "flatMap") {
    const outT = arrayOf(outElem);
    locals.push(
      { id: "out.0", name: "out", type: outT, mutable: false },
      { id: "mapped.0", name: "mapped", type: fnRet, mutable: false },
    );
    returnType = outT;
    body = [
      {
        kind: "varDecl",
        localId: "out.0",
        init: { kind: "arrayLit", elems: [], type: outT, loc },
        loc,
      },
      readLen,
      ...(method === "map"
        ? [
            {
              kind: "arraySetLength",
              arr: varRef("out.0", outT, loc),
              length: varRef("n.0", F64, loc),
              loc,
            } satisfies IrStmt,
          ]
        : []),
      forLoop([
        {
          kind: "if",
          cond: hasElem,
          then: [
            { kind: "varDecl", localId: "mapped.0", init: callF(getElem), loc },
            arrayValueStore(
              lowerer,
              varRef("out.0", outT, loc),
              method === "map"
                ? varRef("i.0", F64, loc)
                : {
                    kind: "arrIntrinsic",
                    method: "length",
                    receiver: varRef("out.0", outT, loc),
                    args: [],
                    type: F64,
                    loc,
                  },
              varRef("mapped.0", fnRet, loc),
              outElem,
              loc,
            ),
          ],
          else_: null,
          loc,
        },
      ]),
      { kind: "return", value: varRef("out.0", outT, loc), loc },
    ];
  } else if (method === "filter" && fastT) {
    // Split visit (outElem === elem): a present value goes to the fast
    // callback as a plain element and is kept as-is; a present undefined
    // goes to the original callback and is kept as undefined.
    const outT = arrayOf(outElem);
    locals.push(
      { id: "out.0", name: "out", type: outT, mutable: false },
      { id: "e.0", name: "e", type: elem, mutable: false },
    );
    returnType = outT;
    const a = varRef("a.0", arrT, loc);
    const i = varRef("i.0", F64, loc);
    const outLength: IrExpr = {
      kind: "arrIntrinsic",
      method: "length",
      receiver: varRef("out.0", outT, loc),
      args: [],
      type: F64,
      loc,
    };
    const missing = (getElem as IrExpr & { kind: "ternary" }).else_;
    const callFast = (arg: IrExpr): IrExpr => ({
      kind: "callValue",
      callee: varRef("fast.0", fastT, loc),
      args: [arg, i, a].slice(0, arity),
      type: fnRet,
      loc,
    });
    body = [
      {
        kind: "varDecl",
        localId: "out.0",
        init: { kind: "arrayLit", elems: [], type: outT, loc },
        loc,
      },
      readLen,
      forLoop([
        {
          kind: "if",
          cond: hasElem,
          then: [
            {
              kind: "if",
              cond: presentValue(a, i, loc),
              then: [
                {
                  kind: "varDecl",
                  localId: "e.0",
                  init: { kind: "arrayGet", arr: a, index: i, type: elem, loc },
                  loc,
                },
                {
                  kind: "if",
                  cond: filterCond(callFast(varRef("e.0", elem, loc)), fnRet, loc),
                  then: [
                    arrayValueStore(
                      lowerer,
                      varRef("out.0", outT, loc),
                      outLength,
                      varRef("e.0", elem, loc),
                      outElem,
                      loc,
                    ),
                  ],
                  else_: null,
                  loc,
                },
              ],
              else_: [
                {
                  kind: "if",
                  cond: filterCond(callF(missing), fnRet, loc),
                  then: [
                    {
                      kind: "arraySetUndefined",
                      arr: varRef("out.0", outT, loc),
                      index: outLength,
                      loc,
                    },
                  ],
                  else_: null,
                  loc,
                },
              ],
              loc,
            },
          ],
          else_: null,
          loc,
        },
      ]),
      { kind: "return", value: varRef("out.0", outT, loc), loc },
    ];
  } else if (method === "filter") {
    const outT = arrayOf(outElem);
    locals.push(
      { id: "out.0", name: "out", type: outT, mutable: false },
      { id: "v.0", name: "v", type: valueT, mutable: false },
    );
    returnType = outT;
    const classView =
      !typeEquals(outElem, elem) && outElem.kind === "object"
        ? checkedClassAssertion(lowerer, varRef("v.0", valueT, loc), outElem, loc)
        : null;
    const retained = typeEquals(outElem, elem)
      ? varRef("v.0", valueT, loc)
      : classView !== null
        ? classView
        : valueT.kind === "union"
          ? {
              kind: "unionNarrow" as const,
              unionId: valueT.unionId,
              tag: lowerer.armTag(valueT.unionId, outElem),
              value: varRef("v.0", valueT, loc),
              type: outElem,
              loc,
            }
          : varRef("v.0", valueT, loc);
    body = [
      {
        kind: "varDecl",
        localId: "out.0",
        init: { kind: "arrayLit", elems: [], type: outT, loc },
        loc,
      },
      readLen,
      forLoop([
        {
          kind: "if",
          cond: hasElem,
          then: [
            { kind: "varDecl", localId: "v.0", init: getElem, loc },
            {
              kind: "if",
              // ToBoolean over the predicate's answer — inert when it already
              // returned bool, the per-union helper when it returned a union.
              cond: filterCond(callF(varRef("v.0", valueT, loc)), fnRet, loc),
              then: [
                arrayValueStore(
                  lowerer,
                  varRef("out.0", outT, loc),
                  {
                    kind: "arrIntrinsic",
                    method: "length",
                    receiver: varRef("out.0", outT, loc),
                    args: [],
                    type: F64,
                    loc,
                  },
                  retained,
                  outElem,
                  loc,
                ),
              ],
              else_: null,
              loc,
            },
          ],
          else_: null,
          loc,
        },
      ]),
      { kind: "return", value: varRef("out.0", outT, loc), loc },
    ];
  } else {
    returnType = VOID;
    body = [
      readLen,
      forLoop([
        {
          kind: "if",
          cond: hasElem,
          then: [{ kind: "exprStmt", expr: callF(getElem), loc }],
          else_: null,
          loc,
        },
      ]),
    ];
  }
  return { name, params, returnType, locals, body, loc };
}

/** `a.find(f)` / `a.findIndex(f)` / `a.findLast(f)` / `a.findLastIndex(f)`
 * / `a.some(f)` / `a.every(f)` — the early-return HOFs, same
 * desugar-to-loop machinery. some/every return bool from a short-circuit
 * loop; findIndex/findLastIndex return the first matching index or -1
 * (plain f64 — no union). find/findLast return `T | undefined` — the
 * checker's own result union —
 * with the found element wrapped into its arm and the miss producing the
 * undefined unit arm (for REF elements that arm is the unit instance, the
 * standard union machinery). The Last pair is the SAME loop walked
 * backwards (`i = n - 1; i >= 0; i--`), exactly the es2023 spec's
 * descending index walk. Predicate results use JavaScript ToBoolean. */
export function lowerArrayFindLikeCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
  method: "find" | "findIndex" | "findLast" | "findLastIndex" | "some" | "every",
  elem: IrType,
  bindUntyped = false,
): IrExpr {
  const loc = locOf(call);
  const receiver = lowerer.lowerExpr(access.expression);
  const arrT = arrayOf(elem);
  const argNode = call.arguments[0];
  if (!argNode) lowerer.unsupported("SC1090", call, "this call form"); // tsc-guarded
  const { fnArg, arity } = lowerArrayCallback(
    lowerer,
    argNode,
    [arrayValueType(lowerer, elem)],
    arrT,
    bindUntyped,
  );
  // JS takes the ToBoolean of the predicate's result — allowed wherever
  // that ToBoolean has a static answer (bool passes through; f64/string
  // by value; a truthy-answerable union by its arm — the
  // `packages.some((p) => p.scripts[name])` idiom, whose callback
  // returns the index read's `string | undefined`).
  const fnRet = fnArg.type.ret;
  const truthyRet =
    fnRet.kind === "bool" ||
    fnRet.kind === "f64" ||
    fnRet.kind === "string" ||
    fnRet.kind === "dyn" ||
    (fnRet.kind === "union" &&
      (lowerer.unions.get(fnRet.unionId)?.arms ?? []).every(
        (a) => a.kind !== "dyn" && a.kind !== "caught" && a.kind !== "jsval",
      ));
  if (!truthyRet) lowerer.badType(argNode, lowerer.typeOf(argNode));
  const last = method === "findLast" || method === "findLastIndex";
  if (
    method === "some" ||
    method === "every" ||
    method === "findIndex" ||
    method === "findLastIndex"
  ) {
    const fast = lowerFastCallback(
      lowerer,
      argNode,
      [arrayValueType(lowerer, elem)],
      0,
      elem,
      arrT,
      { fnArg, arity },
      bindUntyped,
    );
    const fastT = fast?.type ?? null;
    const helper =
      method === "findIndex" || method === "findLastIndex"
        ? findIndexHelper(
            lowerer,
            elem,
            fnRet,
            arity,
            last,
            loc,
            callbackSite(fast ?? fnArg),
            fastT,
          )
        : someEveryHelper(
            lowerer,
            method,
            elem,
            fnRet,
            arity,
            loc,
            callbackSite(fast ?? fnArg),
            fastT,
          );
    return {
      kind: "call",
      callee: helper,
      args: [receiver, fnArg, ...(fast ? [fast] : [])],
      type: method === "findIndex" || method === "findLastIndex" ? F64 : BOOL,
      loc,
    };
  }
  // find visits holes as undefined and can infer a predicate that selects
  // a subset of the element union. A result matching the receiver's flow
  // element inherits that earlier refinement. Otherwise only an inline,
  // inferred predicate proves a new narrowing; explicit assertions keep
  // the same refusal boundary as filter.
  const valueT = arrayValueType(lowerer, elem);
  const checkerReceiver = lowerer.mapTypeOf(lowerer.typeOf(access.expression));
  const checkerResult = lowerer.irTypeOf(call);
  const unchangedElement =
    checkerReceiver?.kind === "array" &&
    typeEquals(checkerResult, arrayValueType(lowerer, checkerReceiver.elem));
  const resultT = bindUntyped ? valueT : checkerResult;
  if (resultT.kind !== "union") lowerer.badType(call, lowerer.typeOf(call)); // defensive: T | undefined always maps to a union
  const undefTag = lowerer.armTag(resultT.unionId, UNDEFINED_T);
  if (undefTag < 0) lowerer.badType(call, lowerer.typeOf(call));
  let retag: string | null = null;
  if (!lowerer.coercibleValue(valueT, resultT)) {
    const inline = ts.isArrowFunction(argNode) || ts.isFunctionExpression(argNode);
    if (!unchangedElement && (!inline || argNode.type !== undefined)) {
      lowerer.unsupported(
        "SC1090",
        argNode,
        `narrowing '.${method}' requires an inline callback with an inferred predicate (annotate the return ': boolean' to keep the receiver's element type)`,
      );
    }
    const signature = inline ? lowerer.checker.getSignatureFromDeclaration(argNode) : undefined;
    const predicate = signature
      ? lowerer.checker.getTypePredicateOfSignature(signature)
      : undefined;
    if (
      (!unchangedElement && (!predicate || predicate.parameterIndex !== 0)) ||
      valueT.kind !== "union"
    ) {
      lowerer.unsupported(
        "SC1090",
        call,
        `'.${method}' result narrowing without a predicate over its element`,
      );
    }
    retag = lowerer.narrowedRetagHelper(call, valueT.unionId, resultT.unionId, loc);
    const present = lowerer.stripUndefinedArm(resultT);
    if (
      retag === null &&
      !(present.kind === "object" && canAssertClassValue(lowerer, valueT, present))
    )
      lowerer.unsupported(
        "SC1090",
        call,
        `'.${method}' narrowing to an incompatible result layout`,
      );
  }
  const helper = findHelper(
    lowerer,
    elem,
    resultT,
    undefTag,
    fnRet,
    arity,
    last,
    loc,
    retag,
    callbackSite(fnArg),
  );
  return { kind: "call", callee: helper, args: [receiver, fnArg], type: resultT, loc };
}

/** ToBoolean of a predicate result inside a synthesized HOF helper — the
 * ensureBool subset the find-like path admits (bool through; checked
 * values via dynTest; f64/string/truthy-answerable unions via toBool). */
function predicateToBoolean(e: IrExpr): IrExpr {
  if (e.type.kind === "bool") return e;
  if (e.type.kind === "dyn")
    return { kind: "dynTest", test: "truthy", value: e, type: BOOL, loc: e.loc };
  return { kind: "toBool", operand: e, type: BOOL, loc: e.loc };
}

/** The find loop, from existing IR nodes:
 *
 *   n = a.length;
 *   for (i = 0; i < n; i++) { v = a[i]; if (f(v)) return <v as result arm>; }
 *   return <undefined arm>;
 */
function findHelper(
  lowerer: Lowerer,
  elem: IrType,
  resultT: IrType & { kind: "union" },
  undefTag: number,
  fnRet: IrType,
  arity: number,
  last: boolean,
  loc: SrcLoc,
  retag: string | null,
  site = "",
): string {
  const method = last ? "findLast" : "find";
  const key = `${method}:${typeKey(elem)}:${typeKey(resultT)}:${typeKey(fnRet)}:${arity}${site}`;
  const existing = lowerer.arrHofHelpers.get(key);
  if (existing) return existing;
  const name = `%arr.${method}.${lowerer.arrHofHelpers.size}`;
  lowerer.arrHofHelpers.set(key, name);
  const arrT = arrayOf(elem);
  const fnT = funcOf([arrayValueType(lowerer, elem), F64, arrT].slice(0, arity), fnRet);

  const valueT = arrayValueType(lowerer, elem);
  const v = varRef("v.0", valueT, loc);
  const present = lowerer.stripUndefinedArm(resultT);
  // A successful inferred class predicate may select a descendant of a
  // stored base arm. Keep the value read before the callback mutated the array.
  const classView =
    retag === null && !lowerer.coercibleValue(valueT, resultT) && present.kind === "object"
      ? checkedClassAssertion(lowerer, v, present, loc)
      : null;
  const found: IrExpr =
    retag === null
      ? lowerer.coerceToExpected(classView ?? v, resultT)
      : { kind: "call", callee: retag, args: [v], type: resultT, loc };
  const miss: IrExpr = {
    kind: "unionWrap",
    unionId: resultT.unionId,
    tag: undefTag,
    value: { kind: "unitLit", unit: "undefined", type: UNDEFINED_T, loc },
    type: resultT,
    loc,
  };
  const visitBody: IrStmt[] = [
    {
      kind: "varDecl",
      localId: "v.0",
      init: arrayValueRead(lowerer, varRef("a.0", arrT, loc), varRef("i.0", F64, loc), elem, loc),
      loc,
    },
    {
      kind: "if",
      cond: predicateToBoolean(callArrayCallback(arrT, fnT, fnRet, arity, v, loc)),
      then: [{ kind: "return", value: found, loc }],
      else_: null,
      loc,
    },
  ];
  const visit: IrStmt[] = visitBody;
  const loop = last
    ? reverseArrayLoop(loc, visit)
    : countedFor(loc, varRef("n.0", F64, loc), () => visit);
  const body: IrStmt[] = [
    arrayLengthDeclaration(arrT, loc),
    loop,
    { kind: "return", value: miss, loc },
  ];
  lowerer.liftedFns.push({
    name,
    params: arrayCallbackParams(arrT, fnT),
    returnType: resultT,
    locals: [
      ...arrayCallbackLocals(arrT, fnT),
      { id: "v.0", name: "v", type: valueT, mutable: false },
    ],
    body,
    loc,
  });
  return name;
}

/** The findIndex/findLastIndex loop — find's index-returning sibling, no
 * union; findLastIndex is the identical loop walked backwards:
 *
 *   n = a.length; for (...) if (f(a[i], i, a)) return i;  return -1;
 */
function findIndexHelper(
  lowerer: Lowerer,
  elem: IrType,
  fnRet: IrType,
  arity: number,
  last: boolean,
  loc: SrcLoc,
  site = "",
  fastT: CallbackType | null = null,
): string {
  const method = last ? "findLastIndex" : "findIndex";
  const key = `${method}:${typeKey(elem)}:${typeKey(fnRet)}:${arity}${site}${fastT ? ":split" : ""}`;
  const existing = lowerer.arrHofHelpers.get(key);
  if (existing) return existing;
  const name = `%arr.${method}.${lowerer.arrHofHelpers.size}`;
  lowerer.arrHofHelpers.set(key, name);
  const arrT = arrayOf(elem);
  const fnT = funcOf([arrayValueType(lowerer, elem), F64, arrT].slice(0, arity), fnRet);

  const visit: IrStmt[] = [
    {
      kind: "if",
      cond: predicateToBoolean(
        callArrayCallback(
          arrT,
          fnT,
          fnRet,
          arity,
          arrayValueRead(lowerer, varRef("a.0", arrT, loc), varRef("i.0", F64, loc), elem, loc),
          loc,
        ),
      ),
      then: [{ kind: "return", value: varRef("i.0", F64, loc), loc }],
      else_: null,
      loc,
    },
  ];
  const loop = last
    ? reverseArrayLoop(loc, visit)
    : countedFor(loc, varRef("n.0", F64, loc), () => visit);
  const body: IrStmt[] = [
    arrayLengthDeclaration(arrT, loc),
    loop,
    { kind: "return", value: { kind: "numLit", value: -1, type: F64, loc }, loc },
  ];
  lowerer.liftedFns.push(
    withFastCallback(
      {
        name,
        params: arrayCallbackParams(arrT, fnT),
        returnType: F64,
        locals: [...arrayCallbackLocals(arrT, fnT)],
        body,
        loc,
      },
      fastT,
      elem,
    ),
  );
  return name;
}

/** The some/every loops — short-circuit early returns, JS-exact:
 *
 *   some:  n = a.length; for (...) if (f(a[i])) return true;  return false;
 *   every: n = a.length; for (...) if (!f(a[i])) return false; return true;
 */
function someEveryHelper(
  lowerer: Lowerer,
  method: "some" | "every",
  elem: IrType,
  fnRet: IrType,
  arity: number,
  loc: SrcLoc,
  site = "",
  fastT: CallbackType | null = null,
): string {
  const key = `${method}:${typeKey(elem)}:${typeKey(fnRet)}:${arity}${site}${fastT ? ":split" : ""}`;
  const existing = lowerer.arrHofHelpers.get(key);
  if (existing) return existing;
  const name = `%arr.${method}.${lowerer.arrHofHelpers.size}`;
  lowerer.arrHofHelpers.set(key, name);
  const arrT = arrayOf(elem);
  const fnT = funcOf([arrayValueType(lowerer, elem), F64, arrT].slice(0, arity), fnRet);
  const callF: IrExpr = predicateToBoolean(
    callArrayCallback(
      arrT,
      fnT,
      fnRet,
      arity,
      arrayValueRead(lowerer, varRef("a.0", arrT, loc), varRef("i.0", F64, loc), elem, loc),
      loc,
    ),
  );
  const body: IrStmt[] = [
    arrayLengthDeclaration(arrT, loc),
    countedFor(loc, varRef("n.0", F64, loc), () => [
      {
        kind: "if",
        cond: currentArrayIndexPresent(arrT, loc),
        then: [
          {
            kind: "if",
            cond:
              method === "some"
                ? callF
                : { kind: "unary", op: "!", operand: callF, type: BOOL, loc },
            then: [{ kind: "return", value: boolLit(method === "some", loc), loc }],
            else_: null,
            loc,
          },
        ],
        else_: null,
        loc,
      },
    ]),
    { kind: "return", value: boolLit(method !== "some", loc), loc },
  ];
  lowerer.liftedFns.push(
    withFastCallback(
      {
        name,
        params: arrayCallbackParams(arrT, fnT),
        returnType: BOOL,
        locals: [...arrayCallbackLocals(arrT, fnT)],
        body,
        loc,
      },
      fastT,
      elem,
    ),
  );
  return name;
}

/** `a.flatMap(f)` — map plus a one-level flatten. A callback returning
 * `U[]` appends the returned array's elements per receiver element; a
 * callback returning a non-array U doesn't flatten (JS pushes it as-is),
 * which IS map — those calls share map's interned helper. A union return
 * mixing array and non-array arms would need a per-value flatten decision
 * — fenced. */
export function lowerArrayFlatMapCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
  elem: IrType,
): IrExpr {
  const loc = locOf(call);
  const receiver = lowerer.lowerExpr(access.expression);
  const arrT = arrayOf(elem);
  const argNode = call.arguments[0];
  if (!argNode) lowerer.unsupported("SC1090", call, "this call form"); // tsc-guarded
  const { fnArg, arity } = lowerArrayCallback(
    lowerer,
    argNode,
    [arrayValueType(lowerer, elem)],
    arrT,
  );
  const fnRet = fnArg.type.ret;
  if (
    fnRet.kind === "dyn" ||
    fnRet.kind === "jsval" ||
    (fnRet.kind === "record" && lowerer.shapes.get(fnRet.shapeId)?.tuple)
  ) {
    return {
      kind: "dynInvoke",
      recv: { kind: "dynFrom", value: receiver, liveRef: true, type: DYN, loc },
      method: "flatMap",
      calleeName: access.getText(),
      args: [{ kind: "dynFrom", value: fnArg, type: DYN, loc }],
      type: DYN,
      loc,
    };
  }
  if (fnRet.kind === "union") {
    const def = lowerer.unions.get(fnRet.unionId);
    if (def?.arms.some((a) => a.kind === "array")) {
      lowerer.unsupported(
        "SC1090",
        argNode,
        "'.flatMap' callbacks returning a union with an array arm (whether one value flattens " +
          "would be a per-element decision — return an array from every path instead)",
      );
    }
  }
  if (fnRet.kind !== "array") {
    // Scalar results append densely; source holes do not produce output slots.
    if (fnRet.kind === "void" || fnRet.kind === "func") lowerer.badType(call, lowerer.typeOf(call));
    requireProducedArrayElement(lowerer, call, "'.flatMap()'", fnRet);
    const outElem = callbackArrayElement(lowerer, call, fnRet);
    const fast = lowerFastCallback(
      lowerer,
      argNode,
      [arrayValueType(lowerer, elem)],
      0,
      elem,
      arrT,
      { fnArg, arity },
    );
    const helper = arrayHofHelper(
      lowerer,
      "flatMap",
      elem,
      fnRet,
      arity,
      loc,
      outElem,
      callbackSite(fast ?? fnArg),
      fast?.type ?? null,
    );
    return {
      kind: "call",
      callee: helper,
      args: [receiver, fnArg, ...(fast ? [fast] : [])],
      type: arrayOf(outElem),
      loc,
    };
  }
  const fast = lowerFastCallback(lowerer, argNode, [arrayValueType(lowerer, elem)], 0, elem, arrT, {
    fnArg,
    arity,
  });
  const helper = flatMapHelper(
    lowerer,
    elem,
    fnRet,
    arity,
    loc,
    callbackSite(fast ?? fnArg),
    fast?.type ?? null,
  );
  return {
    kind: "call",
    callee: helper,
    args: [receiver, fnArg, ...(fast ? [fast] : [])],
    type: fnRet,
    loc,
  };
}

/** The flatMap loop (array-returning callback), from existing IR nodes:
 *
 *   out = []; n = a.length;
 *   for (i = 0; i < n; i++) {
 *     r = f(a[i]); m = r.length;
 *     for (j = 0; j < m; j++) out.push(r[j]);
 *   }
 *   return out;
 */
function flatMapHelper(
  lowerer: Lowerer,
  elem: IrType,
  fnRet: IrType & { kind: "array" },
  arity: number,
  loc: SrcLoc,
  site = "",
  fastT: CallbackType | null = null,
): string {
  const key = `flatMap:${typeKey(elem)}:${typeKey(fnRet)}:${arity}${site}${fastT ? ":split" : ""}`;
  const existing = lowerer.arrHofHelpers.get(key);
  if (existing) return existing;
  const name = `%arr.flatMap.${lowerer.arrHofHelpers.size}`;
  lowerer.arrHofHelpers.set(key, name);
  const arrT = arrayOf(elem);
  const inner = fnRet.elem;
  const fnT = funcOf([arrayValueType(lowerer, elem), F64, arrT].slice(0, arity), fnRet);

  const innerLoop: IrStmt = {
    kind: "for",
    init: { kind: "varDecl", localId: "j.0", init: numLit(0, loc), loc },
    cond: {
      kind: "bin",
      op: "<",
      left: varRef("j.0", F64, loc),
      right: varRef("m.0", F64, loc),
      type: BOOL,
      loc,
    },
    update: {
      kind: "assign",
      localId: "j.0",
      value: {
        kind: "bin",
        op: "+",
        left: varRef("j.0", F64, loc),
        right: numLit(1, loc),
        type: F64,
        loc,
      },
      loc,
    },
    body: [
      {
        kind: "if",
        cond: arrayIndexPresent(varRef("r.0", fnRet, loc), varRef("j.0", F64, loc), loc),
        then: [
          {
            kind: "varDecl",
            localId: "inner.0",
            init: arrayValueRead(
              lowerer,
              varRef("r.0", fnRet, loc),
              varRef("j.0", F64, loc),
              inner,
              loc,
            ),
            loc,
          },
          arrayValueStore(
            lowerer,
            varRef("out.0", fnRet, loc),
            {
              kind: "arrIntrinsic",
              method: "length",
              receiver: varRef("out.0", fnRet, loc),
              args: [],
              type: F64,
              loc,
            },
            varRef("inner.0", arrayValueType(lowerer, inner), loc),
            inner,
            loc,
          ),
        ],
        else_: null,
        loc,
      },
    ],
    loc,
  };
  const body: IrStmt[] = [
    {
      kind: "varDecl",
      localId: "out.0",
      init: { kind: "arrayLit", elems: [], type: fnRet, loc },
      loc,
    },
    arrayLengthDeclaration(arrT, loc),
    countedFor(loc, varRef("n.0", F64, loc), () => [
      {
        kind: "if",
        cond: currentArrayIndexPresent(arrT, loc),
        then: [
          {
            kind: "varDecl",
            localId: "r.0",
            init: callArrayCallback(
              arrT,
              fnT,
              fnRet,
              arity,
              arrayValueRead(lowerer, varRef("a.0", arrT, loc), varRef("i.0", F64, loc), elem, loc),
              loc,
            ),
            loc,
          },
          {
            kind: "varDecl",
            localId: "m.0",
            init: {
              kind: "arrIntrinsic",
              method: "length",
              receiver: varRef("r.0", fnRet, loc),
              args: [],
              type: F64,
              loc,
            },
            loc,
          },
          innerLoop,
        ],
        else_: null,
        loc,
      },
    ]),
    { kind: "return", value: varRef("out.0", fnRet, loc), loc },
  ];
  lowerer.liftedFns.push(
    withFastCallback(
      {
        name,
        params: arrayCallbackParams(arrT, fnT),
        returnType: fnRet,
        locals: [
          ...arrayCallbackLocals(arrT, fnT),
          { id: "out.0", name: "out", type: fnRet, mutable: false },
          { id: "r.0", name: "r", type: fnRet, mutable: false },
          { id: "m.0", name: "m", type: F64, mutable: false },
          { id: "j.0", name: "j", type: F64, mutable: true },
          { id: "inner.0", name: "inner", type: arrayValueType(lowerer, inner), mutable: false },
        ],
        body,
        loc,
      },
      fastT,
      elem,
    ),
  );
  return name;
}

/** `a.reduce(f)` / `a.reduce(f, init)` and reduceRight — both declared
 * forms. The accumulator type is the call's own checked result: U with an
 * initial value, the element type without one. The callback may declare
 * any prefix of (acc, element, index, array). Without an initial value an
 * empty receiver throws Node's exact TypeError at runtime. */
export function lowerArrayReduceCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
  method: "reduce" | "reduceRight",
  elem: IrType,
): IrExpr {
  const loc = locOf(call);
  const receiver = lowerer.lowerExpr(access.expression);
  const arrT = arrayOf(elem);
  const argNode = call.arguments[0];
  if (!argNode) lowerer.unsupported("SC1090", call, "this call form"); // tsc-guarded
  const hasInit = call.arguments.length === 2;
  const accT =
    lowerer.runtimeOptionalReduceTypes.get(call) ??
    (hasInit ? lowerer.irTypeOf(call) : arrayValueType(lowerer, elem));
  if (accT.kind === "void" || accT.kind === "func") lowerer.badType(call, lowerer.typeOf(call));
  const { fnArg, arity } = lowerArrayCallback(
    lowerer,
    argNode,
    [accT, arrayValueType(lowerer, elem)],
    arrT,
    false,
    accT,
  );
  const fast = lowerFastCallback(
    lowerer,
    argNode,
    [accT, arrayValueType(lowerer, elem)],
    1,
    elem,
    arrT,
    { fnArg, arity },
    false,
    accT,
  );
  const helper = reduceHelper(
    lowerer,
    method,
    elem,
    accT,
    fnArg.type.ret,
    arity,
    hasInit,
    loc,
    callbackSite(fast ?? fnArg),
    fast?.type ?? null,
  );
  const args: IrExpr[] = [receiver, fnArg];
  if (hasInit) args.push(lowerer.lowerExprExpecting(call.arguments[1]!, accT));
  // The fast closure is created last; making a closure has no observable
  // effect, so the initial value still evaluates right after the callback.
  if (fast) args.push(fast);
  return { kind: "call", callee: helper, args, type: accT, loc };
}

/** The reduce/reduceRight loops, from existing IR nodes:
 *
 *   with init:    acc = z; n = a.length; for (...) acc = f(acc, a[i]); return acc;
 *   without init: n = a.length;
 *                 if (n === 0) throw new TypeError("Reduce of empty array with no initial value");
 *                 acc = a[<first>]; for (<rest>) acc = f(acc, a[i]); return acc;
 *
 * reduce walks 0→n-1, reduceRight n-1→0; the seed without an initial
 * value is a[0] / a[n-1] and the loop starts one past it. The empty-array
 * TypeError message is Node's, byte for byte. */
function reduceHelper(
  lowerer: Lowerer,
  method: "reduce" | "reduceRight",
  elem: IrType,
  accT: IrType,
  fnRet: IrType,
  arity: number,
  hasInit: boolean,
  loc: SrcLoc,
  site = "",
  fastT: CallbackType | null = null,
): string {
  const key = `${method}:${typeKey(elem)}:${typeKey(accT)}:${typeKey(fnRet)}:${arity}:${hasInit ? "init" : "seed"}${site}${fastT ? ":split" : ""}`;
  const existing = lowerer.arrHofHelpers.get(key);
  if (existing) return existing;
  const name = `%arr.${method}.${lowerer.arrHofHelpers.size}`;
  lowerer.arrHofHelpers.set(key, name);
  const arrT = arrayOf(elem);
  const fnT = funcOf([accT, arrayValueType(lowerer, elem), F64, arrT].slice(0, arity), fnRet);

  const n = varRef("n.0", F64, loc);
  const i = varRef("i.0", F64, loc);
  const right = method === "reduceRight";
  const at = (index: IrExpr): IrExpr =>
    arrayValueRead(lowerer, varRef("a.0", arrT, loc), index, elem, loc);
  const locals: IrLocal[] = [
    { id: "a.0", name: "a", type: arrT, mutable: true },
    { id: "f.0", name: "f", type: fnT, mutable: true },
    ...(hasInit ? [{ id: "z.0", name: "z", type: accT, mutable: true } as IrLocal] : []),
    { id: "acc.0", name: "acc", type: accT, mutable: true },
    { id: "n.0", name: "n", type: F64, mutable: false },
    { id: "i.0", name: "i", type: F64, mutable: true },
  ];
  const params: IrParam[] = [
    { localId: "a.0", name: "a", type: arrT },
    { localId: "f.0", name: "f", type: fnT },
    ...(hasInit ? [{ localId: "z.0", name: "z", type: accT }] : []),
  ];
  const start: IrExpr = right
    ? { kind: "bin", op: "-", left: n, right: numLit(1, loc), type: F64, loc }
    : numLit(0, loc);
  const inRange: IrExpr = right
    ? { kind: "bin", op: ">=", left: i, right: numLit(0, loc), type: BOOL, loc }
    : { kind: "bin", op: "<", left: i, right: n, type: BOOL, loc };
  const advance: IrStmt = {
    kind: "assign",
    localId: "i.0",
    value: { kind: "bin", op: right ? "-" : "+", left: i, right: numLit(1, loc), type: F64, loc },
    loc,
  };
  const seedStmts: IrStmt[] = [
    { kind: "varDecl", localId: "i.0", init: start, loc },
    ...(hasInit
      ? [
          {
            kind: "varDecl",
            localId: "acc.0",
            init: varRef("z.0", accT, loc),
            loc,
          } satisfies IrStmt,
        ]
      : ([
          {
            kind: "while",
            cond: {
              kind: "ternary",
              cond: inRange,
              then: {
                kind: "unary",
                op: "!",
                operand: currentArrayIndexPresent(arrT, loc),
                type: BOOL,
                loc,
              },
              else_: boolLit(false, loc),
              type: BOOL,
              loc,
            },
            body: [advance],
            loc,
          },
          {
            kind: "if",
            cond: { kind: "unary", op: "!", operand: inRange, type: BOOL, loc },
            then: [
              {
                kind: "throw",
                value: {
                  kind: "libCall",
                  fn: "error.new",
                  args: [
                    {
                      kind: "strLit",
                      value: "Reduce of empty array with no initial value",
                      type: STRING,
                      loc,
                    },
                  ],
                  type: { kind: "object", className: "%TypeError" },
                  loc,
                },
                loc,
              },
            ],
            else_: null,
            loc,
          },
          { kind: "varDecl", localId: "acc.0", init: lowerer.coerceToExpected(at(i), accT), loc },
          advance,
        ] satisfies IrStmt[])),
  ];
  const loop: IrStmt = {
    kind: "for",
    init: null,
    cond: right
      ? { kind: "bin", op: ">=", left: i, right: numLit(0, loc), type: BOOL, loc }
      : { kind: "bin", op: "<", left: i, right: n, type: BOOL, loc },
    update: {
      kind: "assign",
      localId: "i.0",
      value: { kind: "bin", op: right ? "-" : "+", left: i, right: numLit(1, loc), type: F64, loc },
      loc,
    },
    body: [
      {
        kind: "if",
        cond: currentArrayIndexPresent(arrT, loc),
        then: [
          {
            kind: "assign",
            localId: "acc.0",
            value: lowerer.coerceToExpected(
              {
                kind: "callValue",
                callee: varRef("f.0", fnT, loc),
                args: [varRef("acc.0", accT, loc), at(i), i, varRef("a.0", arrT, loc)].slice(
                  0,
                  arity,
                ),
                type: fnRet,
                loc,
              },
              accT,
            ),
            loc,
          },
        ],
        else_: null,
        loc,
      },
    ],
    loc,
  };
  const body: IrStmt[] = [
    arrayLengthDeclaration(arrT, loc),
    ...seedStmts,
    loop,
    { kind: "return", value: varRef("acc.0", accT, loc), loc },
  ];
  lowerer.liftedFns.push(
    withFastCallback({ name, params, returnType: accT, locals, body, loc }, fastT, elem),
  );
  return name;
}

/** `a.sort(cmp)` / `a.toSorted(cmp)`, desugared to an interned synthetic
 * function like the other array HOFs. sort mutates and returns the receiver;
 * toSorted takes its shallow snapshot INSIDE the helper, after the receiver
 * and comparator expressions have both been evaluated, then sorts and
 * returns that copy without touching the receiver. The helper merges stable
 * natural runs, reversing only strict descending runs and extending short
 * runs with insertion sort. Ordered boundaries skip merging. During a merge, an element
 * moves right only while cmp(left, right) > 0, so a NaN or 0 result keeps
 * the left element first. Undefined values sink without reaching the user
 * comparator. The callback sequence differs from V8's TimSort, so exact
 * order and count parity are not claimed; results agree for consistent
 * comparators. Without a comparator, string, number and boolean arrays use
 * native stable ordering: their String conversions cannot call user code.
 * Strings compare UTF-16 units; numbers compare their decimal spellings
 * ([10, 9, 1] → [1, 10, 9]). Other element types still need a comparator. */
export function lowerArraySortCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
  elem: IrType,
  arrT: IrType & { kind: "array" },
): IrExpr {
  const loc = locOf(call);
  const method = access.name.text === "toSorted" ? "toSorted" : "sort";
  const copyFirst = method === "toSorted";
  if (
    call.arguments.length === 0 &&
    (elem.kind === "string" || elem.kind === "f64" || elem.kind === "bool")
  ) {
    return {
      kind: "arrIntrinsic",
      method: copyFirst ? "toSortedPrimitive" : "sortPrimitive",
      receiver: lowerer.lowerExpr(access.expression),
      args: [],
      type: arrT,
      loc,
    };
  }
  if (call.arguments.length !== 1) {
    lowerer.noLowering(
      `.${method} with ${call.arguments.length} arguments`,
      call,
      "default ordering supports string[], number[] and boolean[]; other element types need a comparator",
    );
  }
  const receiver = lowerer.lowerExpr(access.expression);
  const argNode = call.arguments[0]!;
  const undefinedArg = lowerStaticallyUndefinedArgument(lowerer, argNode);
  let unwrappedArg = argNode;
  while (
    ts.isParenthesizedExpression(unwrappedArg) ||
    ts.isAsExpression(unwrappedArg) ||
    ts.isTypeAssertion(unwrappedArg) ||
    ts.isSatisfiesExpression(unwrappedArg)
  )
    unwrappedArg = unwrappedArg.expression;
  if (undefinedArg?.type.kind === "void" && !ts.isVoidExpression(unwrappedArg)) {
    lowerer.noLowering(
      `.${method} with an erased comparator result`,
      argNode,
      "pass the comparator directly, or use void expression to explicitly select default ordering",
    );
  }
  if (
    undefinedArg !== null &&
    (undefinedArg.type.kind === "undefinedT" || ts.isVoidExpression(unwrappedArg)) &&
    (elem.kind === "string" || elem.kind === "f64" || elem.kind === "bool")
  ) {
    // A type assertion alone cannot turn a function value into undefined.
    // The explicit undefined expression can mutate or replace the receiver.
    // Keep its original value alive and run the argument before sorting.
    const saved = lowerer.declareHiddenLocal("%sortReceiver", arrT);
    return {
      kind: "seqExpr",
      stmts: [{ kind: "varDecl", localId: saved.id, init: receiver, loc }],
      result: defaultAfterUndefined(undefinedArg, {
        kind: "arrIntrinsic",
        method: copyFirst ? "toSortedPrimitive" : "sortPrimitive",
        receiver: varRef(saved.id, arrT, loc),
        args: [],
        type: arrT,
        loc,
      }),
      type: arrT,
      loc,
    };
  }
  let fnArg = undefinedArg ?? lowerer.lowerExpr(argNode);
  // Reusable JS comparators often accept checked values. Adapt the array's
  // element ABI just as other array callbacks do before sorting.
  if (
    fnArg.type.kind === "func" &&
    fnArg.type.params.length <= 2 &&
    fnArg.type.params.every((param) => lowerer.coercibleValue(elem, param))
  ) {
    // Arithmetic on inferred JS values retains a checked result because
    // it can produce BigInt. The sort callback still requires a number.
    const result =
      fnArg.type.ret.kind === "dyn" && isJsSourceFile(argNode.getSourceFile())
        ? F64
        : fnArg.type.ret;
    const expected = funcOf(
      fnArg.type.params.map(() => elem),
      result,
    );
    if (!typeEquals(fnArg.type, expected)) fnArg = lowerer.coerceToExpected(fnArg, expected);
  }
  // The comparator receives exactly (a, b); declaring a prefix is
  // ordinary TS. Its result must be number (the spec coerces arbitrary
  // results — no lowering for that).
  if (
    fnArg.type.kind !== "func" ||
    fnArg.type.params.length > 2 ||
    !fnArg.type.params.every((p) => typeEquals(p, elem)) ||
    fnArg.type.ret.kind !== "f64"
  ) {
    lowerer.badType(argNode, lowerer.typeOf(argNode));
  }
  const arity = fnArg.type.params.length;
  // The runtime sorts raw slots without per-move reference counting; this
  // beats the IR merge sort even when its comparator call becomes direct.
  const native = isSortValuesElement(
    elem,
    elem.kind === "union" ? lowerer.unions.get(elem.unionId)?.arms : undefined,
  );
  const key = `${method}:${typeKey(elem)}:${arity}${native ? ":native" : ""}`;
  let helper = lowerer.arrHofHelpers.get(key);
  if (!helper) {
    helper = `%arr.${method}.${lowerer.arrHofHelpers.size}`;
    lowerer.arrHofHelpers.set(key, helper);
    const undefinedTag = elem.kind === "union" ? lowerer.armTag(elem.unionId, UNDEFINED_T) : -1;
    lowerer.liftedFns.push(
      buildArraySortFn(
        helper,
        elem,
        arity,
        copyFirst,
        undefinedTag >= 0 ? undefinedTag : null,
        loc,
        native,
      ),
    );
  }
  return { kind: "call", callee: helper, args: [receiver, fnArg], type: arrT, loc };
}

/** `d.filter(pred)` on a dyn receiver: the receiver must BE a dyn array
 * (else the Node-shaped TypeError above); the predicate runs per element
 * over the dyn value, and each SURVIVOR is validated-extracted into the
 * result's element type T — the type the checker already committed the
 * call to (the contextual `RouteMapping[]`/`string[]` slot). Extraction is
 * the checked-cast machinery: a survivor that doesn't fit T throws the
 * catchable TypeError instead of misreading (a LYING predicate is the only
 * way there). The result is a fresh STATIC array of extracted copies —
 * the dyn boundary's marshal-copy stance (SEMANTICS.md). Null when the
 * call shape isn't claimable (the method-call fence stays). */
export function lowerDynArrayFilterCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
  recv: IrExpr,
): IrExpr | null {
  if (call.arguments.length !== 1) return null;
  const argNode = call.arguments[0]!;
  const loc = locOf(call);
  // The result element type, from what the call flows INTO: the
  // contextual array (or the single array arm of a contextual union —
  // the `string[] | null` return slot), falling back to a type-guard
  // predicate's target (`(r: unknown) => r is T`). Both are tsc's own
  // verdicts on the element; the runtime check makes them honest.
  let elemT: IrType | null = null;
  const ctx = lowerer.checker.getContextualType(call);
  const ctxIr = ctx ? lowerer.mapTypeOf(ctx) : null;
  if (ctxIr?.kind === "array") elemT = ctxIr.elem;
  if (!elemT && ctxIr?.kind === "union") {
    const def = lowerer.unions.get(ctxIr.unionId);
    const arrayArms = def ? def.arms.filter((a) => a.kind === "array") : [];
    if (arrayArms.length === 1 && arrayArms[0]!.kind === "array") elemT = arrayArms[0]!.elem;
  }
  if (!elemT) {
    const sigs = lowerer.checker.getCallSignatures(lowerer.typeOf(argNode));
    const pred =
      sigs.length === 1 ? lowerer.checker.getTypePredicateOfSignature(sigs[0]!) : undefined;
    if (pred?.type) elemT = lowerer.mapTypeOf(pred.type);
  }
  if (!elemT || !lowerer.jsonSafe(elemT)) {
    // No JSON-representable destination (`const failed = checks.filter(
    // fn)` in untyped JS — test/common's runCallChecks): the result
    // STAYS in the checked-dynamic tree — the runtime prototype dispatch (scr_dyn_invoke)
    // runs the real filter over the dyn array and the survivors keep
    // their dyn selves, no extraction needed. The typed-destination path
    // above stays preferred: it hands back a real T[].
    return null;
  }
  const { fnArg, arity } = lowerArrayCallback(lowerer, argNode, [DYN], DYN);
  if (fnArg.type.ret.kind !== "bool") lowerer.badType(argNode, lowerer.typeOf(argNode));
  const helper = dynFilterHelper(lowerer, elemT, arity, loc);
  return {
    kind: "call",
    callee: helper,
    args: [
      recv,
      fnArg,
      { kind: "strLit", value: access.name.text, type: STRING, loc },
      { kind: "strLit", value: access.getText(), type: STRING, loc },
    ],
    type: arrayOf(elemT),
    loc,
  };
}

/** `.flatMap(f)` on a dyn ('unknown'/`any[]`-narrowed) receiver where the
 * callback returns a STATIC array (`parsed.flatMap((v) => typeof v ===
 * "string" ? parseTldList(v) : [])` — the tlds-file shape): the checked-dynamic tree
 * array walks element-by-element, the callback sees each element as the
 * dyn value `unknown` code sees, and its typed results concatenate —
 * depth-1 flatten by construction, no validation needed on the results
 * (they are already typed; only the RECEIVER is dynamic). Non-array
 * receivers throw the Node-shaped TypeError. Callbacks returning
 * NON-array values (JS would keep them as single elements) or dynamic
 * results keep the fence — nothing drives them yet. */
export function lowerDynArrayFlatMapCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
  recv: IrExpr,
): IrExpr | null {
  if (call.arguments.length !== 1) return null;
  const argNode = call.arguments[0]!;
  const loc = locOf(call);
  const { fnArg, arity } = lowerArrayCallback(lowerer, argNode, [DYN], DYN);
  const ret = fnArg.type.ret;
  if (ret.kind !== "array") {
    // A DYNAMIC-returning callback (`plugins.flatMap((plugin) =>
    // plugin.languages ?? [])` — the getSupportInfo shape, where the
    // callback's members ride the checked-dynamic tree): the call dispatches on the
    // RECEIVER's runtime kind (dynInvoke) with the callback boxed —
    // a wrapped ISLAND receiver runs the ENGINE's own JS-exact
    // Array.prototype.flatMap (the routed-ops lane), a native dyn
    // array runs the runtime's flatMap, and non-arrays throw Node's
    // TypeError. The result stays dyn, checked per use.
    if (ret.kind === "dyn" || ret.kind === "jsval") {
      const boxed: IrExpr = { kind: "dynFrom", value: fnArg, type: DYN, loc };
      return {
        kind: "dynInvoke",
        recv,
        method: "flatMap",
        calleeName: access.getText(),
        args: [boxed],
        type: DYN,
        loc,
      };
    }
    lowerer.unsupported(
      "SC1090",
      call,
      `'.flatMap' on 'unknown' receivers whose callback returns '${lowerer.fmt(ret)}' ` +
        `(only callbacks returning a typed ARRAY compile — the results concatenate ` +
        `without validation; return one-element/empty arrays instead of bare values)`,
    );
  }
  const helper = dynFlatMapHelper(lowerer, ret.elem, arity, loc);
  return {
    kind: "call",
    callee: helper,
    args: [
      recv,
      fnArg,
      { kind: "strLit", value: access.name.text, type: STRING, loc },
      { kind: "strLit", value: access.getText(), type: STRING, loc },
    ],
    type: arrayOf(ret.elem),
    loc,
  };
}

/** Interned `%dyn.flatmap.<n>` — one per (element type, callback arity). */
function dynFlatMapHelper(lowerer: Lowerer, elemT: IrType, arity: number, loc: SrcLoc): string {
  const key = `dynflatmap:${typeKey(elemT)}:${arity}`;
  const existing = lowerer.arrHofHelpers.get(key);
  if (existing) return existing;
  const name = `%dyn.flatmap.${lowerer.arrHofHelpers.size}`;
  lowerer.arrHofHelpers.set(key, name);
  lowerer.liftedFns.push(buildDynFlatMapFn(name, elemT, arity, loc));
  return name;
}

/** out = []; n = d.length; for (i..n) { v = d[i]; r = f(v, i, d); for
 * (j..r.length) out.push(r[j]); } return out; — the receiver-kind gate up
 * front, the length read once, elements through the canonical-index keyed
 * read (buildDynFilterFn's discipline). */
function buildDynFlatMapFn(name: string, elemT: IrType, arity: number, loc: SrcLoc): IrFunction {
  const outT = arrayOf(elemT);
  const retT = arrayOf(elemT);
  const fnT = funcOf([DYN, F64, DYN].slice(0, arity), retT);

  const d = varRef("d.0", DYN, loc);
  const body: IrStmt[] = [
    {
      kind: "if",
      cond: { kind: "dynTest", test: "array", negated: true, value: d, type: BOOL, loc },
      then: dynamicReceiverThrows(
        d,
        varRef("m.0", STRING, loc),
        varRef("full.0", STRING, loc),
        loc,
      ),
      else_: null,
      loc,
    },
    {
      kind: "varDecl",
      localId: "n.0",
      init: {
        kind: "dynCheck",
        value: {
          kind: "dynKeyGet",
          key: { kind: "strLit", value: "length", type: STRING, loc },
          value: d,
          type: DYN,
          loc,
        },
        type: F64,
        loc,
      },
      loc,
    },
    {
      kind: "varDecl",
      localId: "out.0",
      init: { kind: "arrayLit", elems: [], type: outT, loc },
      loc,
    },
    countedFor(loc, varRef("n.0", F64, loc), () => [
      {
        kind: "varDecl",
        localId: "v.0",
        init: {
          kind: "dynKeyGet",
          key: { kind: "toString", operand: varRef("i.0", F64, loc), type: STRING, loc },
          value: d,
          type: DYN,
          loc,
        },
        loc,
      },
      {
        kind: "varDecl",
        localId: "r.0",
        init: {
          kind: "callValue",
          callee: varRef("f.0", fnT, loc),
          args: [varRef("v.0", DYN, loc), varRef("i.0", F64, loc), d].slice(0, arity),
          type: retT,
          loc,
        },
        loc,
      },
      {
        kind: "varDecl",
        localId: "rn.0",
        init: {
          kind: "arrIntrinsic",
          method: "length",
          receiver: varRef("r.0", retT, loc),
          args: [],
          type: F64,
          loc,
        },
        loc,
      },
      {
        kind: "for",
        init: { kind: "varDecl", localId: "j.0", init: numLit(0, loc), loc },
        cond: {
          kind: "bin",
          op: "<",
          left: varRef("j.0", F64, loc),
          right: varRef("rn.0", F64, loc),
          type: BOOL,
          loc,
        },
        update: {
          kind: "assign",
          localId: "j.0",
          value: {
            kind: "bin",
            op: "+",
            left: varRef("j.0", F64, loc),
            right: numLit(1, loc),
            type: F64,
            loc,
          },
          loc,
        },
        body: [
          {
            kind: "exprStmt",
            expr: {
              kind: "arrIntrinsic",
              method: "push",
              receiver: varRef("out.0", outT, loc),
              args: [
                {
                  kind: "arrayGet",
                  arr: varRef("r.0", retT, loc),
                  index: varRef("j.0", F64, loc),
                  type: elemT,
                  loc,
                },
              ],
              type: F64,
              loc,
            },
            loc,
          },
        ],
        loc,
      },
    ]),
    { kind: "return", value: varRef("out.0", outT, loc), loc },
  ];
  return {
    name,
    params: [
      { localId: "d.0", name: "d", type: DYN },
      { localId: "f.0", name: "f", type: fnT },
      { localId: "m.0", name: "m", type: STRING },
      { localId: "full.0", name: "full", type: STRING },
    ],
    returnType: outT,
    locals: [
      { id: "d.0", name: "d", type: DYN, mutable: false },
      { id: "f.0", name: "f", type: fnT, mutable: false },
      { id: "m.0", name: "m", type: STRING, mutable: false },
      { id: "full.0", name: "full", type: STRING, mutable: false },
      { id: "n.0", name: "n", type: F64, mutable: false },
      { id: "i.0", name: "i", type: F64, mutable: true },
      { id: "v.0", name: "v", type: DYN, mutable: false },
      { id: "r.0", name: "r", type: retT, mutable: false },
      { id: "rn.0", name: "rn", type: F64, mutable: false },
      { id: "j.0", name: "j", type: F64, mutable: true },
      { id: "out.0", name: "out", type: outT, mutable: false },
    ],
    body,
    loc,
  };
}

/** Interned `%dyn.filter.<n>` — one per (element type, callback arity). */
function dynFilterHelper(lowerer: Lowerer, elemT: IrType, arity: number, loc: SrcLoc): string {
  const key = `dynfilter:${typeKey(elemT)}:${arity}`;
  const existing = lowerer.arrHofHelpers.get(key);
  if (existing) return existing;
  const name = `%dyn.filter.${lowerer.arrHofHelpers.size}`;
  lowerer.arrHofHelpers.set(key, name);
  lowerer.liftedFns.push(buildDynFilterFn(name, elemT, arity, loc));
  return name;
}

/** out = []; n = d.length; for (i..n) { v = d[i]; if (f(v, i, d)) out.push(
 * check<T>(v)); } return out; — with the receiver-kind gate up front. The
 * length reads ONCE (the checked-dynamic tree is immutable under the static surface), the
 * element reads through the canonical-index keyed read, the callback gets
 * whatever prefix of (element, index, receiver) it declares — the element
 * and receiver as dyn values, exactly what `unknown` code sees. */
function buildDynFilterFn(name: string, elemT: IrType, arity: number, loc: SrcLoc): IrFunction {
  const outT = arrayOf(elemT);
  const fnT = funcOf([DYN, F64, DYN].slice(0, arity), BOOL);

  const d = varRef("d.0", DYN, loc);
  const body: IrStmt[] = [
    {
      kind: "if",
      cond: { kind: "dynTest", test: "array", negated: true, value: d, type: BOOL, loc },
      then: dynamicReceiverThrows(
        d,
        varRef("m.0", STRING, loc),
        varRef("full.0", STRING, loc),
        loc,
      ),
      else_: null,
      loc,
    },
    {
      kind: "varDecl",
      localId: "n.0",
      init: {
        kind: "dynCheck",
        value: {
          kind: "dynKeyGet",
          key: { kind: "strLit", value: "length", type: STRING, loc },
          value: d,
          type: DYN,
          loc,
        },
        type: F64,
        loc,
      },
      loc,
    },
    {
      kind: "varDecl",
      localId: "out.0",
      init: { kind: "arrayLit", elems: [], type: outT, loc },
      loc,
    },
    countedFor(loc, varRef("n.0", F64, loc), () => [
      {
        kind: "varDecl",
        localId: "v.0",
        init: {
          kind: "dynKeyGet",
          key: { kind: "toString", operand: varRef("i.0", F64, loc), type: STRING, loc },
          value: d,
          type: DYN,
          loc,
        },
        loc,
      },
      {
        kind: "if",
        cond: {
          kind: "callValue",
          callee: varRef("f.0", fnT, loc),
          args: [varRef("v.0", DYN, loc), varRef("i.0", F64, loc), d].slice(0, arity),
          type: BOOL,
          loc,
        },
        then: [
          {
            kind: "exprStmt",
            expr: {
              kind: "arrIntrinsic",
              method: "push",
              receiver: varRef("out.0", outT, loc),
              args: [{ kind: "dynCheck", value: varRef("v.0", DYN, loc), type: elemT, loc }],
              type: F64,
              loc,
            },
            loc,
          },
        ],
        else_: null,
        loc,
      },
    ]),
    { kind: "return", value: varRef("out.0", outT, loc), loc },
  ];
  return {
    name,
    params: [
      { localId: "d.0", name: "d", type: DYN },
      { localId: "f.0", name: "f", type: fnT },
      { localId: "m.0", name: "m", type: STRING },
      { localId: "full.0", name: "full", type: STRING },
    ],
    returnType: outT,
    locals: [
      { id: "d.0", name: "d", type: DYN, mutable: false },
      { id: "f.0", name: "f", type: fnT, mutable: false },
      { id: "m.0", name: "m", type: STRING, mutable: false },
      { id: "full.0", name: "full", type: STRING, mutable: false },
      { id: "n.0", name: "n", type: F64, mutable: false },
      { id: "i.0", name: "i", type: F64, mutable: true },
      { id: "v.0", name: "v", type: DYN, mutable: false },
      { id: "out.0", name: "out", type: outT, mutable: false },
    ],
    body,
    loc,
  };
}
