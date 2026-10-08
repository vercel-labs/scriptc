import * as ts from "../../ts7/adapter.js";
import type { Lowerer } from "../lowerer.js";
import {
  F64,
  type IrExpr,
  type IrType,
  UNDEFINED_T,
  funcOf,
  isSupportedArrayElem,
  typeEquals,
} from "../../../ir/ir.js";

/** Callback-driven array producers bypass mapType's ordinary T[] mapping:
 * the callback is lowered first, then the helper's result array is built
 * directly from its IR return type. Fence element kinds ScrArr cannot hold
 * before constructing that array type. */
export function requireProducedArrayElement(
  lowerer: Lowerer,
  node: ts.Node,
  producer: string,
  elem: IrType,
): void {
  if (!isSupportedArrayElem(elem)) {
    lowerer.unsupported(
      "SC1090",
      node,
      `${producer} with a callback returning '${lowerer.fmt(elem)}' values (arrays of this element kind have no representation — store the values individually)`,
    );
  }
}

/** Lowers and validates a HOF callback argument. The lib declares optional
 * trailing (index, array) parameters after `lead` (the element for the
 * map family, accumulator + element for reduce); a callback may declare
 * any PREFIX of [...lead, index, array] — ordinary TS — and the desugared
 * loop passes exactly what it declares (JS passes everything; a callback
 * only sees the parameters it names). Returns the lowered callback and
 * its declared arity. */
export function lowerArrayCallback(
  lowerer: Lowerer,
  argNode: ts.Expression,
  lead: IrType[],
  arrT: IrType,
  bindUntyped = false,
  expectedReturn?: IrType,
): { fnArg: IrExpr & { type: IrType & { kind: "func" } }; arity: number } {
  const full = [...lead, F64, arrT];
  // A DYN-receiver HOF's callback (`parsed.flatMap((value) => ...)`):
  // the contextual signature types the unannotated param `any` (the
  // receiver is checker-`any[]`), while the VALUE each call receives is
  // the dyn element `unknown` code sees — narrow the param declaration
  // to `unknown` so it lowers as the dyn it carries (typeof tests and
  // validated extractions ride as usual) instead of fencing on `any`.
  const overridden: ts.Node[] = [];
  if (
    lead[0]?.kind === "dyn" &&
    (ts.isArrowFunction(argNode) || ts.isFunctionExpression(argNode))
  ) {
    for (const p of argNode.parameters) {
      if (!ts.isIdentifier(p.name) || p.type || p.initializer || p.dotDotDotToken) continue;
      const t = lowerer.checker.getTypeAtLocation(p.name);
      if ((t.flags & ts.TypeFlags.Any) !== 0 && !lowerer.chainNarrowedType.has(p.name)) {
        lowerer.chainNarrowedType.set(p.name, lowerer.checker.getUnknownType());
        overridden.push(p.name);
      }
    }
  }
  // A JSVAL-element receiver behind an EVOLVED contextual type (the
  // evolving-`any` array under --dynamic — lowerArrayMethodCall adopted
  // the value's handle element while tsc's evolving analysis types the
  // callback's params by the pushed elements): the lead params BIND the
  // handles the loop passes, whatever the contextual type spelled —
  // paramShape's island-handle early-out, the then-handler rule.
  if (ts.isArrowFunction(argNode) || ts.isFunctionExpression(argNode)) {
    argNode.parameters.forEach((p, i) => {
      if (i >= lead.length || lead[i]!.kind !== "jsval") return;
      if (!ts.isIdentifier(p.name) || p.type || p.initializer || p.dotDotDotToken) return;
      lowerer.jsvalParamOverrides.add(p);
    });
  }
  // An untyped or flow-refined array can contextually type an inline
  // callback differently from the stored element and array layout. Bind
  // unannotated parameters to the helper's ABI when a boundary adapter
  // cannot carry it. Include the optional-read prepass's parameter type
  // in this comparison. The override is temporary because one callback
  // AST can lower under several generic instances.
  const contextual: { symbol: ts.Symbol; previous: IrType | undefined }[] = [];
  const previousImplicit = lowerer.implicitParamTypes;
  let contextualTs: Map<ts.Symbol, ts.Type> | null = null;
  if (ts.isArrowFunction(argNode) || ts.isFunctionExpression(argNode)) {
    argNode.parameters.forEach((param, i) => {
      const expected = full[i];
      if (
        expected === undefined ||
        expected.kind === "dyn" ||
        expected.kind === "jsval" ||
        !ts.isIdentifier(param.name) ||
        param.type ||
        param.initializer ||
        param.dotDotDotToken
      ) {
        return;
      }
      const checkerType = lowerer.checker.getTypeAtLocation(param.name);
      const untyped = (checkerType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0;
      const raw = untyped ? null : lowerer.mapTypeOf(checkerType);
      const mapped = raw ? lowerer.runtimeOptionalBindingType(param.name, raw) : null;
      if (
        untyped
          ? !bindUntyped
          : mapped === null ||
            (lowerer.coercibleValue(expected, mapped) &&
              !runtimeOptionalPairVariant(lowerer, expected, mapped))
      )
        return;
      const symbol = lowerer.checker.getSymbolAtLocation(param.name);
      if (!symbol) return;
      contextual.push({ symbol, previous: lowerer.runtimeOptionalBindingTypes.get(symbol) });
      lowerer.runtimeOptionalBindingTypes.set(symbol, expected);
      const bodyExpected =
        expected.kind === "union" && lowerer.armTag(expected.unionId, UNDEFINED_T) >= 0
          ? lowerer.stripUndefinedArm(expected)
          : expected;
      const expectedTs =
        bodyExpected.kind === "string"
          ? lowerer.checker.getStringType()
          : bodyExpected.kind === "f64"
            ? lowerer.checker.getNumberType()
            : bodyExpected.kind === "bool"
              ? lowerer.checker.getBooleanType()
              : null;
      if (expectedTs !== null) {
        contextualTs ??= new Map(previousImplicit ?? []);
        contextualTs.set(symbol, expectedTs);
      }
    });
  }
  if (contextualTs !== null) lowerer.implicitParamTypes = contextualTs;
  // A destructured parameter over records whose runtime-optional fields
  // kept their undefined arm (an entries pair from such a record) binds
  // that stored layout; its names then see the optional values.
  const patterns: { node: ts.Node; previous: IrType | undefined }[] = [];
  if (ts.isArrowFunction(argNode) || ts.isFunctionExpression(argNode)) {
    argNode.parameters.forEach((param, i) => {
      const expected = full[i];
      if (
        expected === undefined ||
        ts.isIdentifier(param.name) ||
        param.type ||
        param.initializer ||
        param.dotDotDotToken
      )
        return;
      const mapped = lowerer.mapTypeOf(lowerer.checker.getTypeAtLocation(param.name));
      if (mapped === null || !runtimeOptionalPairVariant(lowerer, expected, mapped)) return;
      patterns.push({
        node: param.name,
        previous: lowerer.runtimeOptionalPatternTypes.get(param.name),
      });
      lowerer.runtimeOptionalPatternTypes.set(param.name, expected);
    });
  }
  const previousReturn = lowerer.contextualFunctionReturns.get(argNode);
  if (expectedReturn && (ts.isArrowFunction(argNode) || ts.isFunctionExpression(argNode))) {
    lowerer.contextualFunctionReturns.set(argNode, expectedReturn);
  }
  let fnArg: IrExpr;
  try {
    fnArg = lowerer.lowerExpr(argNode);
  } finally {
    for (const n of overridden) lowerer.chainNarrowedType.delete(n);
    for (const { node, previous } of patterns) {
      if (previous === undefined) lowerer.runtimeOptionalPatternTypes.delete(node);
      else lowerer.runtimeOptionalPatternTypes.set(node, previous);
    }
    for (const { symbol, previous } of contextual) {
      if (previous === undefined) lowerer.runtimeOptionalBindingTypes.delete(symbol);
      else lowerer.runtimeOptionalBindingTypes.set(symbol, previous);
    }
    lowerer.implicitParamTypes = previousImplicit;
    if (previousReturn === undefined) lowerer.contextualFunctionReturns.delete(argNode);
    else lowerer.contextualFunctionReturns.set(argNode, previousReturn);
  }
  // A callback can accept a wider parameter type than the array supplies
  // (a reusable predicate over a union is common). Its closure still has
  // that wider ABI: adapt each actual argument before invoking it, just
  // as assignment to a narrower function slot does. Require a conversion
  // plan so this path never manufactures a stranded callback.
  if (fnArg.type.kind === "dyn") {
    const signatures = lowerer.checker.getCallSignatures(lowerer.typeOf(argNode));
    const ret =
      expectedReturn ??
      (signatures[0]
        ? lowerer.mapTypeOf(lowerer.checker.getReturnTypeOfSignature(signatures[0]))
        : null);
    if (ret && ret.kind !== "void") fnArg = lowerer.coerceToExpected(fnArg, funcOf(full, ret));
  }
  if (
    fnArg.type.kind === "func" &&
    fnArg.type.params.length <= full.length &&
    fnArg.type.params.every((param, i) => lowerer.coercibleValue(full[i]!, param))
  ) {
    const callbackType = funcOf(full.slice(0, fnArg.type.params.length), fnArg.type.ret);
    if (!typeEquals(fnArg.type, callbackType))
      fnArg = lowerer.coerceToExpected(fnArg, callbackType);
  }
  // Array storage widens indexed reads with undefined so holes remain
  // observable. The HOF helper guards every callback behind arrayHas,
  // so an exact-ABI builtin closure may safely adapt from its declared
  // parameter to that guarded union. Keep this exception scoped to the
  // compiler-generated builtin values; ordinary callback-value policy is
  // unchanged.
  if (fnArg.type.kind === "func" && lowerer.isBuiltinCallableValue(fnArg)) {
    const callbackType = funcOf(full.slice(0, fnArg.type.params.length), fnArg.type.ret);
    if (!typeEquals(fnArg.type, callbackType)) {
      fnArg = lowerer.coerceToExpected(fnArg, callbackType);
    }
  }
  if (
    fnArg.type.kind !== "func" ||
    fnArg.type.params.length > full.length ||
    !fnArg.type.params.every((p, i) => typeEquals(p, full[i]!))
  ) {
    lowerer.badType(argNode, lowerer.typeOf(argNode));
  }
  return {
    fnArg: fnArg as IrExpr & { type: IrType & { kind: "func" } },
    arity: fnArg.type.params.length,
  };
}

/** Preserve the checker-selected payload ABI when a callback's runtime
 * return gained only undefined. The array state byte carries that value. */
export function callbackArrayElement(
  lowerer: Lowerer,
  call: ts.CallExpression,
  fnRet: IrType,
): IrType {
  const result = lowerer.mapTypeOf(lowerer.typeOf(call));
  return result?.kind === "array" && lowerer.runtimeOptionalWidening(fnRet, result.elem)
    ? result.elem
    : fnRet;
}

/** True when the helper passes records (optionally behind an undefined
 * arm) that keep runtime-optional fields the checker's parameter type
 * spells as required. */
function runtimeOptionalPairVariant(lowerer: Lowerer, expected: IrType, mapped: IrType): boolean {
  const strip = (t: IrType): IrType =>
    t.kind === "union" && lowerer.armTag(t.unionId, UNDEFINED_T) >= 0
      ? lowerer.stripUndefinedArm(t)
      : t;
  return lowerer.isRuntimeOptionalRecordVariant(strip(expected), strip(mapped));
}
