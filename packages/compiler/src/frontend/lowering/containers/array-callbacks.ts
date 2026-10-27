import { keyedHelperName } from "../stable-names.js";
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
import {
  type SortKeyOrder,
  type SortKeyRead,
  buildArraySortFn,
  buildSortKeyFn,
  closureKeyOrder,
  sortKeysId,
  sortKeysOrder,
} from "../lower-array-sort.js";
import {
  arrayIndexPresent,
  arraySlotSnapshot,
  arraySnapshotAppend,
  arraySnapshotValue,
  arrayValueRead,
  arrayValueStore,
  arrayValueType,
  currentArrayIndexPresent,
  elementMayBeForeign,
  foreignElementThrow,
  primitiveElement,
  slotSnapshotLocals,
  unreadArgument,
  type SlotSnapshot,
} from "../array-values.js";
import { typeKey } from "../../type-mapper.js";
import {
  lowerArrayCallback,
  requireProducedArrayElement,
  callbackArrayElement,
  truthyFilterCallback,
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
import { checkedFilterNarrowing } from "./filter-predicates.js";

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
  const argNode = call.arguments.nodes[0];
  if (!argNode) lowerer.unsupported("SC1090", call, "this call form"); // tsc-guarded
  const booleanFilter =
    method === "filter" &&
    ts.isIdentifier(argNode) &&
    argNode.text === "Boolean" &&
    lowerer.isStdlibSymbol(lowerer.resolveValueSymbol(argNode) ?? undefined);
  const present = !booleanFilter && presentElements(lowerer, call, elem);
  const valueT = callbackValueType(lowerer, elem, present);
  if (booleanFilter) {
    if (valueT.kind === "union") lowerer.requireTruthyUnion(valueT.unionId, argNode);
    // Checked-dynamic elements (`anyText.split("\n").map(...).filter(Boolean)`)
    // keep their runtime kind, so their truthiness is the runtime's.
    if (valueT.kind === "void" || isUnitType(valueT)) {
      lowerer.badType(argNode, lowerer.typeOf(argNode));
    }
  }
  const callback = booleanFilter
    ? { fnArg: truthyFilterCallback(lowerer, valueT, loc), arity: 1, unread: false }
    : lowerArrayCallback(lowerer, argNode, [valueT], arrayOf(elem));
  const { fnArg, arity } = callback;
  // Only an array that can hold elements outside its element type needs to
  // leave an element its callback ignores unread.
  const unread = callback.unread && !present && elementMayBeForeign(lowerer, elem);
  const fnRet = fnArg.type.ret;
  if (method === "map" && (fnRet.kind === "void" || fnRet.kind === "func")) {
    // The result array U[] is unrepresentable here (no void elements;
    // the map helper's closure-returning form has no fixture-backed
    // story yet).
    lowerer.badType(call, lowerer.typeOf(call));
  }
  if (method === "map") requireProducedArrayElement(lowerer, call, "'.map()'", fnRet);
  // JS applies ToBoolean to whatever the predicate answers, so a non-bool
  // result is not an error when its truthiness is represented. Void,
  // whose real answer the ABI has already discarded, keeps the fence. No separate
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
  const filtered =
    method === "filter"
      ? filterResultElem(lowerer, call, argNode, elem, valueT, booleanFilter)
      : null;
  const outElem = filtered !== null ? filtered.elem : callbackArrayElement(lowerer, call, fnRet);
  // A filter that re-tags its elements keeps the single union-typed visit.
  // A callback that never reads its element has no use for a typed one.
  const fast =
    present || booleanFilter || unread || (method === "filter" && !typeEquals(outElem, elem))
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
    present,
    unread,
  );
  const resultType: IrType = method === "map" || method === "filter" ? arrayOf(outElem) : VOID;
  const result: IrExpr = {
    kind: "call",
    callee: helper,
    args: [receiver, fnArg, ...(fast ? [fast] : [])],
    type: resultType,
    loc,
  };
  const narrowing = filtered?.narrowing ?? null;
  if (narrowing === null) return result;
  return {
    kind: "call",
    callee: narrowing.helper,
    args: [result],
    type: arrayOf(narrowing.elem),
    loc,
  };
}

/** The element a filter keeps, and the checked conversion of the result
 * to the checker's narrower element when the predicate does not prove it.
 * An inferred inline type predicate proves one source arm, or a class
 * view, so the loop keeps that type directly. A written predicate (`(p): p
 * is Cat => ...`, a guard function passed as a value) is an assertion
 * TypeScript does not check, and an inferred predicate that keeps several
 * arms has no single arm to re-tag: the loop keeps the receiver's element
 * and `narrowing` (checkedFilterNarrowing) converts each kept element.
 * Boolean is safe when every discarded arm is a nullish unit. */
function filterResultElem(
  lowerer: Lowerer,
  call: ts.CallExpression,
  argNode: ts.Expression,
  elem: IrType,
  valueT: IrType,
  booleanFilter: boolean,
): { elem: IrType; narrowing: { helper: string; elem: IrType } | null } {
  const kept = filterKeptElem(lowerer, call, argNode, elem, valueT, booleanFilter);
  if (typeof kept !== "string") return { elem: kept, narrowing: null };
  return { elem, narrowing: { helper: kept, elem: filterCheckerElem(lowerer, call, elem) } };
}

/** The checker's spelling of a filter result's element type. */
function filterTypeText(lowerer: Lowerer, call: ts.CallExpression): string {
  const result = lowerer.typeOf(call);
  const element = lowerer.checker.isArrayType(result)
    ? lowerer.checker.getTypeArguments(result as ts.TypeReference)[0]
    : undefined;
  return element === undefined ? "" : lowerer.checker.typeToString(element);
}

/** The checker's element of a filter result, or the receiver's when the
 * filter introduces no refinement. */
function filterCheckerElem(lowerer: Lowerer, call: ts.CallExpression, elem: IrType): IrType {
  const result = lowerer.mapTypeOf(lowerer.typeOf(call));
  return result?.kind === "array" ? result.elem : elem;
}

/** filterResultElem's element, or the name of the checked narrowing helper. */
function filterKeptElem(
  lowerer: Lowerer,
  call: ts.CallExpression,
  argNode: ts.Expression,
  elem: IrType,
  valueT: IrType,
  booleanFilter: boolean,
): IrType | string {
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
  const written =
    !booleanFilter &&
    ((!ts.isArrowFunction(argNode) && !ts.isFunctionExpression(argNode)) ||
      argNode.type !== undefined);
  const narrowing = booleanFilter
    ? null
    : (): string | null =>
        checkedFilterNarrowing(lowerer, elem, outElem, filterTypeText(lowerer, call), locOf(call));
  if (written) {
    const helper = narrowing!();
    if (helper !== null) return helper;
    if (!ts.isArrowFunction(argNode) && !ts.isFunctionExpression(argNode)) {
      lowerer.unsupported(
        "SC1090",
        argNode,
        `narrowing '.filter' to '${lowerer.fmt(outElem)}' through a callback VALUE (no checked ` +
          `conversion from '${lowerer.fmt(elem)}' — ${annotateEscape})`,
      );
    }
    lowerer.unsupported(
      "SC1090",
      argNode,
      `narrowing '.filter' to '${lowerer.fmt(outElem)}' with a hand-written type predicate (no ` +
        `checked conversion from '${lowerer.fmt(elem)}' — ${annotateEscape})`,
    );
  }
  const classRefinement =
    !booleanFilter && outElem.kind === "object" && canAssertClassValue(lowerer, valueT, outElem);
  if (
    !classRefinement &&
    (valueT.kind !== "union" || lowerer.armTag(valueT.unionId, outElem) < 0)
  ) {
    const helper = narrowing?.() ?? null;
    if (helper !== null) return helper;
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

function filterPredicateOk(lowerer: Lowerer, ret: IrType): boolean {
  if (ret.kind === "bool") return true;
  // VOID is a TYPE erasure, not a runtime value: TS lets a value-returning
  // function sit in a void-returning slot (`const p: (n: number) => void =
  // (n) => n`), so the predicate's real answer can be truthy while the
  // compiled ABI has already discarded it. Treating void as constantly
  // falsy would answer [] where Node answers [1]. Fenced until
  // the returned value can be preserved through the void ABI.
  // A checked-dynamic value retains its runtime kind, so scr_dyn_truthy can

  if (ret.kind === "void") return false;
  if (ret.kind === "dyn") return true;
  if (ret.kind === "caught") return false;
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
    isJsSourceFile(ts.getSourceFileOfNode(argNode)) ||
    valueT?.kind !== "union" ||
    typeEquals(valueT, elem) ||
    elem.kind === "union" ||
    elem.kind === "dyn" ||
    isUnitType(elem)
  )
    return null;
  const fastLead = lead.slice();
  fastLead[elemIndex] = elem;
  // The optional-read prepass binds an unannotated element parameter to
  // the array's runtime value type. Rebind it to the plain element for
  // this lowering only.
  const param = argNode.parameters.nodes[elemIndex];
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
export function callbackSite(fnArg: IrExpr): string {
  return fnArg.kind === "closure" ? `@${fnArg.fnName}` : "";
}

/** The optional-read analysis proved this call's receiver never holds an
 * explicit undefined (or, for the find family, a hole): its callback takes
 * the element type itself, read without a state test. A missing value the
 * proof excluded would make the element read trap instead of producing a
 * wrong value. */
function presentElements(lowerer: Lowerer, call: ts.CallExpression, elem: IrType): boolean {
  return (
    lowerer.presentElementCalls.has(call) &&
    elem.kind !== "dyn" &&
    elem.kind !== "void" &&
    !isUnitType(elem)
  );
}

/** The value a helper passes its callback for one visited index. */
function callbackValueType(lowerer: Lowerer, elem: IrType, present: boolean): IrType {
  return present ? elem : arrayValueType(lowerer, elem);
}

function callbackValueRead(
  lowerer: Lowerer,
  arr: IrExpr,
  index: IrExpr,
  elem: IrType,
  present: boolean,
  loc: SrcLoc,
  unread = false,
): IrExpr {
  if (unread) {
    const placeholder = unreadArgument(lowerer, callbackValueType(lowerer, elem, present), loc);
    if (placeholder) return placeholder;
  }
  return present
    ? { kind: "arrayGet", arr, index, type: elem, loc }
    : arrayValueRead(lowerer, arr, index, elem, loc);
}

/** The snapshot locals of the filter and find helpers; `value` is their
 * element local `v.0`. */
const FILTER_SNAPSHOT: SlotSnapshot = { isForeign: "vf.0", value: "v.0", foreign: "vd.0" };

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
  present = false,
  unread = false,
): string {
  const key = `${method}:${typeKey(elem)}:${typeKey(fnRet)}:${arity}:${typeKey(outElem)}${site}${fastT ? ":split" : ""}${present ? ":present" : ""}${unread ? ":unread" : ""}`;
  const existing = lowerer.arrHofHelpers.get(key);
  if (existing) return existing;
  const name = keyedHelperName(lowerer, `%arr.${method}`, key);
  lowerer.arrHofHelpers.set(key, name);
  lowerer.arrHofInfo.set(name, {
    method,
    elem,
    fnRet,
    arity,
    outElem,
    present,
    split: !!fastT,
    unread,
  });
  const fn = buildArrayHofFn(
    lowerer,
    name,
    method,
    elem,
    fnRet,
    arity,
    loc,
    outElem,
    fastT,
    present,
    unread,
  );
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
  if (call.arguments.nodes.length !== 1 || !call.arguments.nodes[0]) return null;
  const arrays = def.arms as (IrType & { kind: "array" })[];
  const valueArms: IrType[] = [];
  const addValueArm = (type: IrType): boolean => {
    if (type.kind === "dyn" || type.kind === "caught" || type.kind === "void") return false;
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
  const argNode = call.arguments.nodes[0]!;
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
  const name = keyedHelperName(lowerer, "%arr.union", key);
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

/** A kept filter element as the result's element type: the value itself,
 * or its narrowed arm or class view when the predicate narrowed it. */
function filterRetainedValue(
  lowerer: Lowerer,
  v: IrExpr,
  elem: IrType,
  outElem: IrType,
  loc: SrcLoc,
): IrExpr {
  if (typeEquals(outElem, elem)) return v;
  const classView =
    outElem.kind === "object" ? checkedClassAssertion(lowerer, v, outElem, loc) : null;
  if (classView !== null) return classView;
  if (v.type.kind !== "union") return v;
  return {
    kind: "unionNarrow",
    unionId: v.type.unionId,
    tag: lowerer.armTag(v.type.unionId, outElem),
    value: v,
    type: outElem,
    loc,
  };
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
  present = false,
  unread = false,
): IrFunction {
  const arrT = arrayOf(elem);
  const valueT = callbackValueType(lowerer, elem, present);
  const fnT = funcOf([valueT, F64, arrT].slice(0, arity), fnRet);

  const locals = arrayCallbackLocals(arrT, fnT);
  const params = arrayCallbackParams(arrT, fnT);
  const callF = (arg: IrExpr): IrExpr => callArrayCallback(arrT, fnT, fnRet, arity, arg, loc);
  const getElem = callbackValueRead(
    lowerer,
    varRef("a.0", arrT, loc),
    varRef("i.0", F64, loc),
    elem,
    present,
    loc,
  );
  // What the callback takes: the element, or a placeholder for one it
  // ignores (callbackValueRead's `unread`).
  const argElem = unread
    ? callbackValueRead(
        lowerer,
        varRef("a.0", arrT, loc),
        varRef("i.0", F64, loc),
        elem,
        present,
        loc,
        true,
      )
    : getElem;
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
      readLen,
      {
        kind: "varDecl",
        localId: "out.0",
        init: { kind: "arrayLit", elems: [], type: outT, loc },
        loc,
      },
      // map's result has the receiver's length, holes where the receiver
      // has them. Storage for it is reserved first (with the result's
      // construction, which directly precedes it) and the length is set
      // after the loop, so a result without holes is filled by appends and
      // gets no state bytes.
      ...(method === "map"
        ? [
            {
              kind: "arraySetLength",
              arr: varRef("out.0", outT, loc),
              length: varRef("n.0", F64, loc),
              loc,
              reserve: true,
            } satisfies IrStmt,
          ]
        : []),
      forLoop([
        {
          kind: "if",
          cond: hasElem,
          then: [
            { kind: "varDecl", localId: "mapped.0", init: callF(argElem), loc },
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
    const retained = filterRetainedValue(lowerer, varRef("v.0", valueT, loc), elem, outElem, loc);
    // A predicate that ignores the element of an array that can hold
    // elements outside its element type keeps a snapshot of the slot, read
    // before the predicate runs, as stored (arraySlotSnapshot).
    const copied =
      (arity === 0 || unread) &&
      !present &&
      typeEquals(outElem, elem) &&
      elementMayBeForeign(lowerer, elem);
    // `v.0` is declared above; the snapshot adds its other two locals.
    if (copied)
      locals.push(
        ...slotSnapshotLocals(lowerer, elem, FILTER_SNAPSHOT).filter((l) => l.id !== "v.0"),
      );
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
          // A kept element is appended as it was stored, so one the element
          // type cannot hold stays in the result.
          then: copied
            ? [
                ...arraySlotSnapshot(
                  lowerer,
                  varRef("a.0", arrT, loc),
                  varRef("i.0", F64, loc),
                  elem,
                  FILTER_SNAPSHOT,
                  loc,
                ),
                {
                  kind: "if",
                  cond: filterCond(callF(argElem), fnRet, loc),
                  then: [
                    arraySnapshotAppend(
                      lowerer,
                      varRef("out.0", outT, loc),
                      elem,
                      FILTER_SNAPSHOT,
                      loc,
                    ),
                  ],
                  else_: null,
                  loc,
                },
              ]
            : [
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
          then: [{ kind: "exprStmt", expr: callF(argElem), loc }],
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
  const argNode = call.arguments.nodes[0];
  if (!argNode) lowerer.unsupported("SC1090", call, "this call form"); // tsc-guarded
  // find's result must be reachable from the element itself; a predicate
  // that narrows to another layout keeps the optional element visit.
  const present =
    presentElements(lowerer, call, elem) &&
    ((method !== "find" && method !== "findLast") ||
      (!bindUntyped && lowerer.coercibleValue(elem, lowerer.irTypeOf(call))));
  const lowered = lowerArrayCallback(
    lowerer,
    argNode,
    [callbackValueType(lowerer, elem, present)],
    arrT,
    bindUntyped,
  );
  const { fnArg, arity } = lowered;
  // Only an array that can hold elements outside its element type needs to
  // leave an element its callback ignores unread.
  const unread = lowered.unread && !present && elementMayBeForeign(lowerer, elem);
  // JS takes the ToBoolean of the predicate's result — allowed wherever
  // that ToBoolean has a static answer (bool passes through; f64/string
  // by value; a truthy-answerable union by its arm — the
  // `packages.some((p) => p.scripts[name])` idiom, whose callback
  // returns the index read's `string | undefined`).
  const fnRet = fnArg.type.ret;
  if (!findPredicateOk(lowerer, fnRet)) lowerer.badType(argNode, lowerer.typeOf(argNode));
  const last = method === "findLast" || method === "findLastIndex";
  if (
    method === "some" ||
    method === "every" ||
    method === "findIndex" ||
    method === "findLastIndex"
  ) {
    const fast =
      present || unread
        ? null
        : lowerFastCallback(
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
            present,
            unread,
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
            present,
            unread,
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
  const valueT = callbackValueType(lowerer, elem, present);
  const checkerReceiver = lowerer.mapTypeOf(lowerer.typeOf(access.expression));
  const checkerResult = lowerer.irTypeOf(call);
  const unchangedElement =
    checkerReceiver?.kind === "array" &&
    typeEquals(checkerResult, arrayValueType(lowerer, checkerReceiver.elem));
  const resultT = bindUntyped ? valueT : checkerResult;
  if (resultT.kind !== "union") lowerer.badType(call, lowerer.typeOf(call)); // defensive: T | undefined always maps to a union
  const undefTag = lowerer.armTag(resultT.unionId, UNDEFINED_T);
  if (undefTag < 0) lowerer.badType(call, lowerer.typeOf(call));
  const retag = findResultRetag(lowerer, call, argNode, method, valueT, resultT, unchangedElement);
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
    present,
    unread,
  );
  return { kind: "call", callee: helper, args: [receiver, fnArg], type: resultT, loc };
}

/** The retag helper that converts a found element into find's result union,
 * or null when the element converts directly. Only an inline callback with
 * an inferred predicate over its element can narrow the result; a written
 * predicate is an unchecked assertion and keeps the refusal. */
function findResultRetag(
  lowerer: Lowerer,
  call: ts.CallExpression,
  argNode: ts.Expression,
  method: string,
  valueT: IrType,
  resultT: IrType & { kind: "union" },
  unchangedElement: boolean,
): string | null {
  if (lowerer.coercibleValue(valueT, resultT)) return null;
  const loc = locOf(call);
  const inline = ts.isArrowFunction(argNode) || ts.isFunctionExpression(argNode);
  if (!unchangedElement && (!inline || argNode.type !== undefined)) {
    lowerer.unsupported(
      "SC1090",
      argNode,
      `narrowing '.${method}' requires an inline callback with an inferred predicate (annotate the return ': boolean' to keep the receiver's element type)`,
    );
  }
  const signature = inline ? lowerer.checker.getSignatureFromDeclaration(argNode) : undefined;
  const predicate = signature ? lowerer.checker.getTypePredicateOfSignature(signature) : undefined;
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
  const retag = lowerer.narrowedRetagHelper(call, valueT.unionId, resultT.unionId, loc);
  const present = lowerer.stripUndefinedArm(resultT);
  if (
    retag === null &&
    !(present.kind === "object" && canAssertClassValue(lowerer, valueT, present))
  )
    lowerer.unsupported("SC1090", call, `'.${method}' narrowing to an incompatible result layout`);
  return retag;
}

/** The find-like predicate results whose ToBoolean has a static answer:
 * bool passes through; f64/string by value; checked values and
 * truthy-answerable unions by their runtime kind or arm. */
export function findPredicateOk(lowerer: Lowerer, fnRet: IrType): boolean {
  return (
    fnRet.kind === "bool" ||
    fnRet.kind === "f64" ||
    fnRet.kind === "string" ||
    fnRet.kind === "dyn" ||
    (fnRet.kind === "union" &&
      (lowerer.unions.get(fnRet.unionId)?.arms ?? []).every(
        (a) => a.kind !== "dyn" && a.kind !== "caught",
      ))
  );
}

/** ToBoolean of a predicate result inside a synthesized HOF helper — the
 * ensureBool subset the find-like path admits (bool through; checked
 * values via dynTest; f64/string/truthy-answerable unions via toBool). */
export function predicateToBoolean(e: IrExpr): IrExpr {
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
  present = false,
  unread = false,
): string {
  const method = last ? "findLast" : "find";
  const key = `${method}:${typeKey(elem)}:${typeKey(resultT)}:${typeKey(fnRet)}:${arity}${site}${present ? ":present" : ""}${unread ? ":unread" : ""}`;
  const existing = lowerer.arrHofHelpers.get(key);
  if (existing) return existing;
  const name = keyedHelperName(lowerer, `%arr.${method}`, key);
  lowerer.arrHofHelpers.set(key, name);
  const arrT = arrayOf(elem);
  const valueT = callbackValueType(lowerer, elem, present);
  const fnT = funcOf([valueT, F64, arrT].slice(0, arity), fnRet);

  const v = varRef("v.0", valueT, loc);
  const found = findFoundValue(lowerer, v, resultT, retag, loc);
  const miss: IrExpr = {
    kind: "unionWrap",
    unionId: resultT.unionId,
    tag: undefTag,
    value: { kind: "unitLit", unit: "undefined", type: UNDEFINED_T, loc },
    type: resultT,
    loc,
  };
  const read: IrStmt = {
    kind: "varDecl",
    localId: "v.0",
    init: callbackValueRead(
      lowerer,
      varRef("a.0", arrT, loc),
      varRef("i.0", F64, loc),
      elem,
      present,
      loc,
    ),
    loc,
  };
  // A predicate that ignores the element of an array that can hold
  // elements outside its element type keeps a snapshot of the slot, read
  // before the predicate runs as JavaScript reads it (arraySlotSnapshot):
  // the predicate is called without reading it as typed, and a found element
  // outside the element type takes the checked conversion into the result.
  const ignored = (arity === 0 || unread) && !present && elementMayBeForeign(lowerer, elem);
  const placeholder = unread ? unreadArgument(lowerer, valueT, loc) : null;
  const visitBody: IrStmt[] = ignored
    ? [
        ...arraySlotSnapshot(
          lowerer,
          varRef("a.0", arrT, loc),
          varRef("i.0", F64, loc),
          elem,
          FILTER_SNAPSHOT,
          loc,
        ),
        {
          kind: "if",
          cond: predicateToBoolean(
            callArrayCallback(arrT, fnT, fnRet, arity, placeholder ?? v, loc),
          ),
          then: [
            {
              kind: "return",
              value: arraySnapshotValue(lowerer, elem, FILTER_SNAPSHOT, resultT, () => found, loc),
              loc,
            },
          ],
          else_: null,
          loc,
        },
      ]
    : [
        read,
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
      ...(ignored
        ? slotSnapshotLocals(lowerer, elem, FILTER_SNAPSHOT).filter((l) => l.id !== "v.0")
        : []),
    ],
    body,
    loc,
  });
  return name;
}

/** A found element as find's result union. A successful inferred class
 * predicate may select a descendant of a stored base arm. The value is the
 * one read before the callback ran, even if the callback mutated its slot. */
function findFoundValue(
  lowerer: Lowerer,
  v: IrExpr,
  resultT: IrType & { kind: "union" },
  retag: string | null,
  loc: SrcLoc,
): IrExpr {
  if (retag !== null) return { kind: "call", callee: retag, args: [v], type: resultT, loc };
  const presentArm = lowerer.stripUndefinedArm(resultT);
  const classView =
    !lowerer.coercibleValue(v.type, resultT) && presentArm.kind === "object"
      ? checkedClassAssertion(lowerer, v, presentArm, loc)
      : null;
  return lowerer.coerceToExpected(classView ?? v, resultT);
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
  present = false,
  unread = false,
): string {
  const method = last ? "findLastIndex" : "findIndex";
  const key = `${method}:${typeKey(elem)}:${typeKey(fnRet)}:${arity}${site}${fastT ? ":split" : ""}${present ? ":present" : ""}${unread ? ":unread" : ""}`;
  const existing = lowerer.arrHofHelpers.get(key);
  if (existing) return existing;
  const name = keyedHelperName(lowerer, `%arr.${method}`, key);
  lowerer.arrHofHelpers.set(key, name);
  if (!last)
    lowerer.arrHofInfo.set(name, {
      method: "findIndex",
      elem,
      fnRet,
      arity,
      outElem: elem,
      present,
      split: !!fastT,
      unread,
    });
  const arrT = arrayOf(elem);
  const fnT = funcOf([callbackValueType(lowerer, elem, present), F64, arrT].slice(0, arity), fnRet);

  const visit: IrStmt[] = [
    {
      kind: "if",
      cond: predicateToBoolean(
        callArrayCallback(
          arrT,
          fnT,
          fnRet,
          arity,
          callbackValueRead(
            lowerer,
            varRef("a.0", arrT, loc),
            varRef("i.0", F64, loc),
            elem,
            present,
            loc,
            unread,
          ),
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
  present = false,
  unread = false,
): string {
  const key = `${method}:${typeKey(elem)}:${typeKey(fnRet)}:${arity}${site}${fastT ? ":split" : ""}${present ? ":present" : ""}${unread ? ":unread" : ""}`;
  const existing = lowerer.arrHofHelpers.get(key);
  if (existing) return existing;
  const name = keyedHelperName(lowerer, `%arr.${method}`, key);
  lowerer.arrHofHelpers.set(key, name);
  lowerer.arrHofInfo.set(name, {
    method,
    elem,
    fnRet,
    arity,
    outElem: elem,
    present,
    split: !!fastT,
    unread,
  });
  const arrT = arrayOf(elem);
  const fnT = funcOf([callbackValueType(lowerer, elem, present), F64, arrT].slice(0, arity), fnRet);
  const callF: IrExpr = predicateToBoolean(
    callArrayCallback(
      arrT,
      fnT,
      fnRet,
      arity,
      callbackValueRead(
        lowerer,
        varRef("a.0", arrT, loc),
        varRef("i.0", F64, loc),
        elem,
        present,
        loc,
        unread,
      ),
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
  const argNode = call.arguments.nodes[0];
  if (!argNode) lowerer.unsupported("SC1090", call, "this call form"); // tsc-guarded
  const present = presentElements(lowerer, call, elem);
  const lowered = lowerArrayCallback(
    lowerer,
    argNode,
    [callbackValueType(lowerer, elem, present)],
    arrT,
  );
  const { fnArg, arity } = lowered;
  // Only an array that can hold elements outside its element type needs to
  // leave an element its callback ignores unread.
  const unread = lowered.unread && !present && elementMayBeForeign(lowerer, elem);
  const fnRet = fnArg.type.ret;
  if (
    fnRet.kind === "dyn" ||
    (fnRet.kind === "record" && lowerer.shapes.get(fnRet.shapeId)?.tuple)
  ) {
    return {
      kind: "dynInvoke",
      recv: { kind: "dynFrom", value: receiver, liveRef: true, type: DYN, loc },
      method: "flatMap",
      calleeName: ts.getTextOfNode(access),
      args: [{ kind: "dynFrom", value: fnArg, type: DYN, loc }],
      type: DYN,
      loc,
    };
  }
  if (fnRet.kind === "union") {
    const def = lowerer.unions.get(fnRet.unionId);
    const plan = def?.arms.some((a) => a.kind === "array")
      ? flatMapUnionPlan(lowerer, call, argNode, fnRet)
      : null;
    if (plan) {
      const helper = flatMapUnionHelper(lowerer, elem, fnRet, arity, plan, loc, present);
      return {
        kind: "call",
        callee: helper,
        args: [receiver, fnArg],
        type: arrayOf(plan.outElem),
        loc,
      };
    }
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
    const fast =
      present || unread
        ? null
        : lowerFastCallback(lowerer, argNode, [arrayValueType(lowerer, elem)], 0, elem, arrT, {
            fnArg,
            arity,
          });
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
      present,
      unread,
    );
    return {
      kind: "call",
      callee: helper,
      args: [receiver, fnArg, ...(fast ? [fast] : [])],
      type: arrayOf(outElem),
      loc,
    };
  }
  const fast =
    present || unread
      ? null
      : lowerFastCallback(lowerer, argNode, [arrayValueType(lowerer, elem)], 0, elem, arrT, {
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
    present,
    unread,
  );
  return {
    kind: "call",
    callee: helper,
    args: [receiver, fnArg, ...(fast ? [fast] : [])],
    type: fnRet,
    loc,
  };
}

/** How each arm of a flatMap callback's union result contributes to the
 * output: an array arm appends its elements, an array arm the checker
 * types `never[]` (an empty literal such as `s ? s : []`) appends nothing,
 * and any other arm appends itself. */
interface FlatMapUnionPlan {
  outElem: IrType;
  arms: ("spread" | "empty" | "value")[];
}

/** The plan for a callback returning `T | U[]`: every non-array arm must
 * convert into the result's element type without a check, and every
 * array arm's element type must be the result's. Null when an arm does
 * not. */
function flatMapUnionPlan(
  lowerer: Lowerer,
  call: ts.CallExpression,
  argNode: ts.Expression,
  fnRet: IrType & { kind: "union" },
): FlatMapUnionPlan | null {
  const out = lowerer.mapTypeOf(lowerer.typeOf(call));
  if (out?.kind !== "array") return null;
  const outElem = out.elem;
  const arms = lowerer.unions.get(fnRet.unionId)?.arms;
  if (!arms) return null;
  // The `never[]` constituents of the callback's checked result.
  const emptyArms: IrType[] = [];
  const signature = lowerer.checker.getCallSignatures(lowerer.typeOf(argNode))[0];
  if (signature) {
    const ret = lowerer.checker.getReturnTypeOfSignature(signature);
    for (const part of ret.isUnionType() ? ts.constituentTypes(ret) : [ret]) {
      if (!lowerer.checker.isArrayType(part)) continue;
      const [element] = lowerer.checker.getTypeArguments(part as ts.TypeReference);
      if (element === undefined || (element.flags & ts.TypeFlags.Never) === 0) continue;
      const mapped = lowerer.mapTypeOf(part);
      if (mapped) emptyArms.push(mapped);
    }
  }
  const converts = (t: IrType): boolean => {
    if (typeEquals(t, outElem)) return true;
    // A `(T | undefined)[]` result stores T elements (primitiveElement).
    if (t.kind === "undefinedT" && primitiveElement(outElem)) return true;
    if (outElem.kind !== "union") return false;
    return lowerer.armTag(outElem.unionId, t) >= 0;
  };
  const plan: FlatMapUnionPlan["arms"] = [];
  for (const arm of arms) {
    if (arm.kind === "array" && emptyArms.some((e) => typeEquals(e, arm))) plan.push("empty");
    // An array arm copies its elements as they are stored, a present
    // undefined included, so its element type is the result's.
    else if (arm.kind === "array" && typeEquals(arm.elem, outElem)) plan.push("spread");
    else if (arm.kind !== "array" && converts(arm)) plan.push("value");
    else return null;
  }
  return { outElem, arms: plan };
}

/** The flatMap loop over a union-returning callback: each result tests
 * its arm and appends its elements, nothing, or itself (Node's
 * IsArray decision per value). */
function flatMapUnionHelper(
  lowerer: Lowerer,
  elem: IrType,
  fnRet: IrType & { kind: "union" },
  arity: number,
  plan: FlatMapUnionPlan,
  loc: SrcLoc,
  present: boolean,
): string {
  // The plan is part of the key: one union result type can carry an empty
  // `never[]` arm in one callback and a populated array arm in another.
  const key = `flatMapUnion:${typeKey(elem)}:${typeKey(fnRet)}:${typeKey(plan.outElem)}:${plan.arms.join(",")}:${arity}${present ? ":present" : ""}`;
  const existing = lowerer.arrHofHelpers.get(key);
  if (existing) return existing;
  const name = `%arr.flatMap.${lowerer.arrHofHelpers.size}`;
  lowerer.arrHofHelpers.set(key, name);
  const arrT = arrayOf(elem);
  const outT = arrayOf(plan.outElem);
  const fnT = funcOf([callbackValueType(lowerer, elem, present), F64, arrT].slice(0, arity), fnRet);
  const arms = lowerer.unions.get(fnRet.unionId)!.arms;
  const outRef = (): IrExpr => varRef("out.0", outT, loc);
  const resultRef = (): IrExpr => varRef("r.0", fnRet, loc);
  const outLength = (): IrExpr => ({
    kind: "arrIntrinsic",
    method: "length",
    receiver: outRef(),
    args: [],
    type: F64,
    loc,
  });
  const locals: IrLocal[] = [
    ...arrayCallbackLocals(arrT, fnT),
    { id: "out.0", name: "out", type: outT, mutable: false },
    { id: "r.0", name: "r", type: fnRet, mutable: false },
  ];
  const armBody = (tag: number): IrStmt[] => {
    const arm = arms[tag]!;
    const narrowed: IrExpr = {
      kind: "unionNarrow",
      unionId: fnRet.unionId,
      tag,
      value: resultRef(),
      type: arm,
      loc,
    };
    if (plan.arms[tag] === "empty") return [];
    if (plan.arms[tag] === "value") {
      // A unit arm's value is the unit itself, which has no narrowed
      // representation.
      const value: IrExpr = isUnitType(arm)
        ? { kind: "unitLit", unit: arm.kind === "nullT" ? "null" : "undefined", type: arm, loc }
        : narrowed;
      return [
        arrayValueStore(
          lowerer,
          outRef(),
          outLength(),
          // An undefined value is a present undefined element of a
          // primitive array (arrayValueStore).
          arm.kind === "undefinedT" && primitiveElement(plan.outElem)
            ? value
            : lowerer.coerceToExpected(value, plan.outElem),
          plan.outElem,
          loc,
        ),
      ];
    }
    const innerT = arm as IrType & { kind: "array" };
    const listId = `list.${tag}`;
    const lengthId = `m.${tag}`;
    const indexId = `j.${tag}`;
    const itemId = `inner.${tag}`;
    locals.push(
      { id: listId, name: "list", type: innerT, mutable: false },
      { id: lengthId, name: "m", type: F64, mutable: false },
      { id: indexId, name: "j", type: F64, mutable: true },
      { id: itemId, name: "inner", type: arrayValueType(lowerer, innerT.elem), mutable: false },
    );
    const list = (): IrExpr => varRef(listId, innerT, loc);
    const index = (): IrExpr => varRef(indexId, F64, loc);
    return [
      { kind: "varDecl", localId: listId, init: narrowed, loc },
      {
        kind: "varDecl",
        localId: lengthId,
        init: {
          kind: "arrIntrinsic",
          method: "length",
          receiver: list(),
          args: [],
          type: F64,
          loc,
        },
        loc,
      },
      {
        kind: "for",
        init: { kind: "varDecl", localId: indexId, init: numLit(0, loc), loc },
        cond: {
          kind: "bin",
          op: "<",
          left: index(),
          right: varRef(lengthId, F64, loc),
          type: BOOL,
          loc,
        },
        update: {
          kind: "assign",
          localId: indexId,
          value: { kind: "bin", op: "+", left: index(), right: numLit(1, loc), type: F64, loc },
          loc,
        },
        body: [
          {
            kind: "if",
            cond: arrayIndexPresent(list(), index(), loc),
            then: [
              {
                kind: "varDecl",
                localId: itemId,
                init: arrayValueRead(lowerer, list(), index(), innerT.elem, loc),
                loc,
              },
              arrayValueStore(
                lowerer,
                outRef(),
                outLength(),
                varRef(itemId, arrayValueType(lowerer, innerT.elem), loc),
                plan.outElem,
                loc,
              ),
            ],
            else_: null,
            loc,
          },
        ],
        loc,
      },
    ];
  };
  let dispatch: IrStmt[] = armBody(arms.length - 1);
  for (let tag = arms.length - 2; tag >= 0; tag--) {
    dispatch = [
      {
        kind: "if",
        cond: {
          kind: "unionIsTag",
          unionId: fnRet.unionId,
          tag,
          value: resultRef(),
          negated: false,
          type: BOOL,
          loc,
        },
        then: armBody(tag),
        else_: dispatch,
        loc,
      },
    ];
  }
  const body: IrStmt[] = [
    {
      kind: "varDecl",
      localId: "out.0",
      init: { kind: "arrayLit", elems: [], type: outT, loc },
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
              callbackValueRead(
                lowerer,
                varRef("a.0", arrT, loc),
                varRef("i.0", F64, loc),
                elem,
                present,
                loc,
              ),
              loc,
            ),
            loc,
          },
          ...dispatch,
        ],
        else_: null,
        loc,
      },
    ]),
    { kind: "return", value: outRef(), loc },
  ];
  lowerer.liftedFns.push({
    name,
    params: arrayCallbackParams(arrT, fnT),
    returnType: outT,
    locals,
    body,
    loc,
  });
  return name;
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
  present = false,
  unread = false,
): string {
  const key = `flatMap:${typeKey(elem)}:${typeKey(fnRet)}:${arity}${site}${fastT ? ":split" : ""}${present ? ":present" : ""}${unread ? ":unread" : ""}`;
  const existing = lowerer.arrHofHelpers.get(key);
  if (existing) return existing;
  const name = keyedHelperName(lowerer, "%arr.flatMap", key);
  lowerer.arrHofHelpers.set(key, name);
  lowerer.arrHofInfo.set(name, {
    method: "flatMapArray",
    elem,
    fnRet,
    arity,
    outElem: fnRet.elem,
    present,
    split: !!fastT,
    unread,
  });
  const arrT = arrayOf(elem);
  const inner = fnRet.elem;
  const fnT = funcOf([callbackValueType(lowerer, elem, present), F64, arrT].slice(0, arity), fnRet);

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
              callbackValueRead(
                lowerer,
                varRef("a.0", arrT, loc),
                varRef("i.0", F64, loc),
                elem,
                present,
                loc,
                unread,
              ),
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
  const argNode = call.arguments.nodes[0];
  if (!argNode) lowerer.unsupported("SC1090", call, "this call form"); // tsc-guarded
  const hasInit = call.arguments.nodes.length === 2;
  const accT =
    lowerer.runtimeOptionalReduceTypes.get(call) ??
    (hasInit ? lowerer.irTypeOf(call) : arrayValueType(lowerer, elem));
  if (accT.kind === "void" || accT.kind === "func") lowerer.badType(call, lowerer.typeOf(call));
  const lowered = lowerArrayCallback(
    lowerer,
    argNode,
    [accT, arrayValueType(lowerer, elem)],
    arrT,
    false,
    accT,
  );
  const { fnArg, arity } = lowered;
  // Only an array that can hold elements outside its element type needs to
  // leave an element its callback ignores unread.
  const unread = lowered.unread && elementMayBeForeign(lowerer, elem);
  const fast = unread
    ? null
    : lowerFastCallback(
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
    unread,
  );
  const args: IrExpr[] = [receiver, fnArg];
  if (hasInit) args.push(lowerer.lowerExprExpecting(call.arguments.nodes[1]!, accT));
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
 * TypeError message is Node's exact message. */
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
  unread = false,
): string {
  const key = `${method}:${typeKey(elem)}:${typeKey(accT)}:${typeKey(fnRet)}:${arity}:${hasInit ? "init" : "seed"}${site}${fastT ? ":split" : ""}${unread ? ":unread" : ""}`;
  const existing = lowerer.arrHofHelpers.get(key);
  if (existing) return existing;
  const name = keyedHelperName(lowerer, `%arr.${method}`, key);
  lowerer.arrHofHelpers.set(key, name);
  if (method === "reduce")
    lowerer.arrHofInfo.set(name, {
      method,
      elem,
      fnRet,
      arity,
      outElem: accT,
      present: false,
      split: !!fastT,
      hasInit,
      unread,
    });
  const arrT = arrayOf(elem);
  const fnT = funcOf([accT, arrayValueType(lowerer, elem), F64, arrT].slice(0, arity), fnRet);

  const n = varRef("n.0", F64, loc);
  const i = varRef("i.0", F64, loc);
  const right = method === "reduceRight";
  const at = (index: IrExpr): IrExpr =>
    arrayValueRead(lowerer, varRef("a.0", arrT, loc), index, elem, loc);
  // The visited element, or a placeholder for a callback that never reads it.
  const placeholder = unread ? unreadArgument(lowerer, arrayValueType(lowerer, elem), loc) : null;
  const visited = (): IrExpr => placeholder ?? at(i);
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
                args: [varRef("acc.0", accT, loc), visited(), i, varRef("a.0", arrT, loc)].slice(
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

/** The comparator of a sort over a `(T | undefined)[]`, which stores T
 * elements. The comparator only receives present elements (undefined
 * elements sort last without a call), so the unannotated parameters of an
 * inline comparator take the element type, and the runtime calls it
 * without an adapter. */
function lowerOptionalElementComparator(
  lowerer: Lowerer,
  argNode: ts.Expression,
  comparator: ts.Expression,
  elem: IrType,
  arrT: IrType & { kind: "array" },
): IrExpr {
  if (
    arrT.optionalElements !== true ||
    !(ts.isArrowFunction(comparator) || ts.isFunctionExpression(comparator)) ||
    isJsSourceFile(ts.getSourceFileOfNode(comparator))
  )
    return lowerer.lowerExpr(argNode);
  const rebound: { symbol: ts.Symbol; previous: IrType | undefined }[] = [];
  for (const param of comparator.parameters.nodes.slice(0, 2)) {
    if (param.type || param.initializer || param.dotDotDotToken || !ts.isIdentifier(param.name))
      continue;
    const symbol = lowerer.checker.getSymbolAtLocation(param.name);
    if (!symbol) continue;
    rebound.push({ symbol, previous: lowerer.runtimeOptionalBindingTypes.get(symbol) });
    lowerer.runtimeOptionalBindingTypes.set(symbol, elem);
  }
  try {
    return lowerer.lowerExpr(argNode);
  } finally {
    for (const { symbol, previous } of rebound) {
      if (previous === undefined) lowerer.runtimeOptionalBindingTypes.delete(symbol);
      else lowerer.runtimeOptionalBindingTypes.set(symbol, previous);
    }
  }
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
 * comparators. Without a comparator, string, number, boolean and Date
 * arrays use native stable ordering: their String conversions cannot call
 * user code. Strings compare UTF-16 units; numbers compare their decimal
 * spellings ([10, 9, 1] → [1, 10, 9]); Dates compare their toString() text.
 * Other element types still need a comparator. */
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
    call.arguments.nodes.length === 0 &&
    (elem.kind === "string" || elem.kind === "f64" || elem.kind === "bool" || elem.kind === "date")
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
  if (call.arguments.nodes.length !== 1) {
    lowerer.noLowering(
      `.${method} with ${call.arguments.nodes.length} arguments`,
      call,
      "default ordering supports string[], number[], boolean[] and Date[]; other element types need a comparator",
    );
  }
  const receiver = lowerer.lowerExpr(access.expression);
  const argNode = call.arguments.nodes[0]!;
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
  let fnArg =
    undefinedArg ?? lowerOptionalElementComparator(lowerer, argNode, unwrappedArg, elem, arrT);
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
      fnArg.type.ret.kind === "dyn" && isJsSourceFile(ts.getSourceFileOfNode(argNode))
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
  const keyed = native ? recognizedSortKeys(lowerer, fnArg, elem) : null;
  const reads = keyed?.every((k) => k.read !== null) ? keyed.map((k) => k.read!) : null;
  const order = keyed ? sortKeysOrder(keyed) : 0;
  const key = `${method}:${typeKey(elem)}:${arity}${native ? ":native" : ""}${keyed ? `:keyed${order}${reads ? `:field${reads.length}` : ""}` : ""}`;
  let helper = lowerer.arrHofHelpers.get(key);
  if (!helper) {
    helper = keyedHelperName(lowerer, `%arr.${method}`, key);
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
        keyed && { order, key: reads !== null, keys: keyed.length },
        elementMayBeForeign(lowerer, elem)
          ? (arr, index) => foreignElementThrow(lowerer, arr, index, elem, loc)
          : null,
      ),
    );
  }
  const args = [receiver, fnArg];
  if (reads) args.push(sortKeyReader(lowerer, elem, reads, loc));
  return { kind: "call", callee: helper, args, type: arrT, loc };
}

/** The keys of a capture-free comparator closure the runtime can sort by
 * without calling it: number elements themselves, or number fields of
 * record or class elements (one or several). */
function recognizedSortKeys(
  lowerer: Lowerer,
  fnArg: IrExpr,
  elem: IrType,
): readonly SortKeyOrder[] | null {
  const keyed = closureKeyOrder(lowerer.liftedFns, fnArg);
  if (!keyed) return null;
  if (keyed[0]!.read === null) return elem.kind === "f64" ? keyed : null;
  return elem.kind === "record" || elem.kind === "object" ? keyed : null;
}

/** A zero-capture closure over the shared key reader of these reads
 * (buildSortKeyFn): `(x) => x.field`, or `(x, j) => key j` for several. */
function sortKeyReader(
  lowerer: Lowerer,
  elem: IrType,
  reads: readonly SortKeyRead[],
  loc: SrcLoc,
): IrExpr {
  const cacheKey = `sortKey:${typeKey(elem)}:${sortKeysId(reads.map((read) => ({ order: 1, read })))}`;
  let reader = lowerer.arrHofHelpers.get(cacheKey);
  if (!reader) {
    reader = keyedHelperName(lowerer, "%arr.sortKey", cacheKey);
    lowerer.arrHofHelpers.set(cacheKey, reader);
    lowerer.liftedFns.push(buildSortKeyFn(reader, elem, reads, loc));
  }
  const params = reads.length > 1 ? [elem, F64] : [elem];
  return { kind: "closure", fnName: reader, captures: [], type: funcOf(params, F64), loc };
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
  if (call.arguments.nodes.length !== 1) return null;
  const argNode = call.arguments.nodes[0]!;
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
      { kind: "strLit", value: ts.getTextOfNode(access), type: STRING, loc },
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
  if (call.arguments.nodes.length !== 1) return null;
  const argNode = call.arguments.nodes[0]!;
  const loc = locOf(call);
  const { fnArg, arity } = lowerArrayCallback(lowerer, argNode, [DYN], DYN);
  const ret = fnArg.type.ret;
  if (ret.kind !== "array") {
    // A DYNAMIC-returning callback (`plugins.flatMap((plugin) =>
    // plugin.languages ?? [])` — the getSupportInfo shape, where the
    // callback's members ride the checked-dynamic tree): the call dispatches on the
    // RECEIVER's runtime kind (dynInvoke) with the callback boxed. A native
    // dyn array runs the runtime's flatMap, and non-arrays throw Node's
    // TypeError. The result stays dyn, checked per use.
    if (ret.kind === "dyn") {
      const boxed: IrExpr = { kind: "dynFrom", value: fnArg, type: DYN, loc };
      return {
        kind: "dynInvoke",
        recv,
        method: "flatMap",
        calleeName: ts.getTextOfNode(access),
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
      { kind: "strLit", value: ts.getTextOfNode(access), type: STRING, loc },
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
  const name = keyedHelperName(lowerer, "%dyn.flatmap", key);
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
  const name = keyedHelperName(lowerer, "%dyn.filter", key);
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

/** Tuple `filter` / `find` / `findIndex` / `some` / `every`. `reads` holds
 * one element read per position, in index order, each over the helper's
 * `a.0` receiver parameter. The helper visits positions in order and reads
 * each one only when it is visited, so a callback's write to a later
 * position is visible; filter and find keep the value read before the
 * callback ran. find, findIndex, some and every return at the first
 * deciding position. Predicate results and narrowing follow the array
 * methods' rules. */
export function lowerTuplePredicateCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  method: "filter" | "find" | "findIndex" | "some" | "every",
  receiver: IrExpr,
  elem: IrType,
  reads: IrExpr[],
): IrExpr {
  const loc = locOf(call);
  const argNode = call.arguments.nodes[0]!;
  const booleanFilter =
    method === "filter" &&
    ts.isIdentifier(argNode) &&
    argNode.text === "Boolean" &&
    lowerer.isStdlibSymbol(lowerer.resolveValueSymbol(argNode) ?? undefined);
  if (booleanFilter) {
    if (elem.kind === "union") lowerer.requireTruthyUnion(elem.unionId, argNode);
    if (elem.kind === "dyn" || elem.kind === "void" || isUnitType(elem)) {
      lowerer.badType(argNode, lowerer.typeOf(argNode));
    }
  }
  const { fnArg, arity } = booleanFilter
    ? { fnArg: truthyFilterCallback(lowerer, elem, loc), arity: 1 }
    : lowerArrayCallback(lowerer, argNode, [elem], receiver.type);
  const fnRet = fnArg.type.ret;
  if (method === "filter" ? !filterPredicateOk(lowerer, fnRet) : !findPredicateOk(lowerer, fnRet)) {
    if (fnRet.kind === "void") {
      lowerer.unsupported(
        "SC1090",
        argNode,
        `'.${method}()' with a void-returning predicate (the callback return value is erased before its truthiness can be tested)`,
      );
    }
    lowerer.badType(argNode, lowerer.typeOf(argNode));
  }
  let resultT: IrType;
  let outElem: IrType = elem;
  // A narrowing find retags from the element union widened with undefined,
  // the value type an array find narrows from.
  let foundT: IrType = elem;
  let retag: string | null = null;
  let narrowing: { helper: string; elem: IrType } | null = null;
  if (method === "filter") {
    // The element union is built in position order, so the checker's
    // result element can list the same arms in another order.
    const checkerResult = lowerer.mapTypeOf(lowerer.typeOf(call));
    const arms = (type: IrType): IrType[] =>
      type.kind === "union" ? lowerer.unions.get(type.unionId)!.arms : [type];
    const unchanged =
      checkerResult?.kind === "array" &&
      arms(checkerResult.elem).length === arms(elem).length &&
      arms(checkerResult.elem).every((arm) => arms(elem).some((other) => typeEquals(arm, other)));
    if (!unchanged) {
      const filtered = filterResultElem(lowerer, call, argNode, elem, elem, booleanFilter);
      outElem = filtered.elem;
      narrowing = filtered.narrowing;
    }
    resultT = arrayOf(outElem);
  } else if (method === "find") {
    resultT = lowerer.irTypeOf(call);
    if (resultT.kind !== "union" || lowerer.armTag(resultT.unionId, UNDEFINED_T) < 0) {
      lowerer.badType(call, lowerer.typeOf(call));
    }
    if (!lowerer.coercibleValue(elem, resultT)) foundT = arrayValueType(lowerer, elem);
    retag = findResultRetag(lowerer, call, argNode, method, foundT, resultT, false);
  } else {
    resultT = method === "findIndex" ? F64 : BOOL;
  }
  const key = `tuple.${method}:${typeKey(receiver.type)}:${typeKey(fnArg.type)}:${typeKey(resultT)}:${arity}${callbackSite(fnArg)}`;
  let helper = lowerer.arrHofHelpers.get(key);
  if (!helper) {
    helper = keyedHelperName(lowerer, `%tuple.${method}`, key);
    lowerer.arrHofHelpers.set(key, helper);
    const v = varRef("v.0", elem, loc);
    const out = varRef("out.0", resultT, loc);
    const test = (index: number): IrExpr => {
      const invocation: IrExpr = {
        kind: "callValue",
        callee: varRef("f.0", fnArg.type, loc),
        args: [v, numLit(index, loc)].slice(0, arity),
        type: fnRet,
        loc,
      };
      return method === "filter"
        ? filterCond(invocation, fnRet, loc)
        : predicateToBoolean(invocation);
    };
    const decided = (index: number): IrStmt => {
      switch (method) {
        case "filter":
          return arrayValueStore(
            lowerer,
            out,
            { kind: "arrIntrinsic", method: "length", receiver: out, args: [], type: F64, loc },
            filterRetainedValue(lowerer, v, elem, outElem, loc),
            outElem,
            loc,
          );
        case "find":
          return {
            kind: "return",
            value: findFoundValue(
              lowerer,
              lowerer.coerceToExpected(v, foundT),
              resultT as IrType & { kind: "union" },
              retag,
              loc,
            ),
            loc,
          };
        case "findIndex":
          return { kind: "return", value: numLit(index, loc), loc };
        case "some":
          return { kind: "return", value: boolLit(true, loc), loc };
        case "every":
          return { kind: "return", value: boolLit(false, loc), loc };
      }
    };
    const body: IrStmt[] =
      method === "filter"
        ? [
            {
              kind: "varDecl",
              localId: "out.0",
              init: { kind: "arrayLit", elems: [], type: resultT, loc },
              loc,
            },
          ]
        : [];
    reads.forEach((read, index) => {
      body.push(
        index === 0
          ? { kind: "varDecl", localId: "v.0", init: read, loc }
          : { kind: "assign", localId: "v.0", value: read, loc },
        {
          kind: "if",
          cond:
            method === "every"
              ? { kind: "unary", op: "!", operand: test(index), type: BOOL, loc }
              : test(index),
          then: [decided(index)],
          else_: null,
          loc,
        },
      );
    });
    let done: IrExpr;
    switch (method) {
      case "filter":
        done = out;
        break;
      case "find": {
        const unionId = (resultT as IrType & { kind: "union" }).unionId;
        done = {
          kind: "unionWrap",
          unionId,
          tag: lowerer.armTag(unionId, UNDEFINED_T),
          value: { kind: "unitLit", unit: "undefined", type: UNDEFINED_T, loc },
          type: resultT,
          loc,
        };
        break;
      }
      case "findIndex":
        done = numLit(-1, loc);
        break;
      default:
        done = boolLit(method === "every", loc);
    }
    body.push({ kind: "return", value: done, loc });
    lowerer.liftedFns.push({
      name: helper,
      params: [
        { localId: "a.0", name: "a", type: receiver.type },
        { localId: "f.0", name: "f", type: fnArg.type },
      ],
      returnType: resultT,
      locals: [
        { id: "a.0", name: "a", type: receiver.type, mutable: false },
        { id: "f.0", name: "f", type: fnArg.type, mutable: false },
        ...(reads.length > 0 ? [{ id: "v.0", name: "v", type: elem, mutable: true }] : []),
        ...(method === "filter"
          ? [{ id: "out.0", name: "out", type: resultT, mutable: false }]
          : []),
      ],
      body,
      loc,
    });
  }
  const result: IrExpr = {
    kind: "call",
    callee: helper,
    args: [receiver, fnArg],
    type: resultT,
    loc,
  };
  if (narrowing === null) return result;
  return {
    kind: "call",
    callee: narrowing.helper,
    args: [result],
    type: arrayOf(narrowing.elem),
    loc,
  };
}

/** The `%arr.<method>` helper `name` (map, flatMap or filter) taking its
 * iteration bound as a last parameter: the loop runs to the bound instead
 * of the receiver's length when it starts. ArraySpeciesCreate reads the
 * receiver's length before the species constructor runs, so a constructor
 * that appends to the receiver does not extend the loop
 * (lowerWithArraySpecies). Null when `name` is no such helper. */
export function boundedArrayHofHelper(lowerer: Lowerer, name: string): string | null {
  const info = lowerer.arrHofInfo.get(name);
  if (!info || info.method === "forEach") return null;
  const bounded = `${name}.bounded`;
  if (lowerer.liftedFnNamed(bounded)) return bounded;
  const fn = lowerer.liftedFnNamed(name);
  if (!fn) return null;
  let replaced = false;
  const body = fn.body.map((stmt): IrStmt => {
    if (replaced || stmt.kind !== "varDecl" || stmt.localId !== "n.0") return stmt;
    replaced = true;
    return { ...stmt, init: varRef("bound.0", F64, stmt.loc) };
  });
  if (!replaced) return null;
  lowerer.liftedFns.push({
    ...fn,
    name: bounded,
    params: [...fn.params, { localId: "bound.0", name: "bound", type: F64 }],
    locals: [...fn.locals, { id: "bound.0", name: "bound", type: F64, mutable: false }],
    body,
  });
  return bounded;
}
