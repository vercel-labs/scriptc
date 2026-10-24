import { keyedHelperName } from "../stable-names.js";
import * as ts from "../../ts7/adapter.js";
import type { Lowerer } from "../lowerer.js";
import { isJsSourceFile, locOf } from "../../program.js";
import { primitiveElement } from "../array-values.js";
import { varRef } from "../../../ir/build.js";
import { typeKey } from "../../type-mapper.js";
import {
  BOOL,
  DYN,
  F64,
  STRING,
  type IrExpr,
  type IrType,
  type SrcLoc,
  UNDEFINED_T,
  funcOf,
  isSupportedArrayElem,
  isUnitType,
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
  // `xs.map(((x) => x))`: a parenthesized callback is the function itself.
  while (ts.isParenthesizedExpression(argNode)) argNode = argNode.expression;
  // The ambient `Boolean` as the callback (`flags.every(Boolean)`,
  // `xs.some(Boolean)`, `xs.map(Boolean)`): Boolean(value) answers the
  // ToBoolean of its FIRST argument and ignores the rest, so the callback
  // is the interned one-parameter truthiness closure over the lead slot.
  // The constructor's own generic signature has no compiled value form.
  // JavaScript files keep their primitive-constructor closure.
  if (
    ts.isIdentifier(argNode) &&
    argNode.text === "Boolean" &&
    !isJsSourceFile(ts.getSourceFileOfNode(argNode)) &&
    lowerer.isStdlibSymbol(lowerer.resolveValueSymbol(argNode) ?? undefined)
  ) {
    const valueT = lead[0];
    if (valueT === undefined || valueT.kind === "void" || isUnitType(valueT))
      lowerer.badType(argNode, lowerer.typeOf(argNode));
    if (valueT.kind === "union") lowerer.requireTruthyUnion(valueT.unionId, argNode);
    return { fnArg: truthyFilterCallback(lowerer, valueT, locOf(argNode)), arity: 1 };
  }
  // The ambient `String` (`values.map(String)`): String(value) converts its
  // first argument as a direct call does, whatever the element type; the
  // constructor's own value form takes a string.
  if (
    ts.isIdentifier(argNode) &&
    argNode.text === "String" &&
    !isJsSourceFile(ts.getSourceFileOfNode(argNode)) &&
    lowerer.isStdlibSymbol(lowerer.resolveValueSymbol(argNode) ?? undefined)
  ) {
    const valueT = lead[0];
    if (valueT === undefined || valueT.kind === "void")
      lowerer.badType(argNode, lowerer.typeOf(argNode));
    return { fnArg: stringConversionCallback(lowerer, valueT, argNode), arity: 1 };
  }
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
    for (const p of argNode.parameters.nodes) {
      if (!ts.isIdentifier(p.name) || p.type || p.initializer || p.dotDotDotToken) continue;
      const t = lowerer.checker.getTypeAtLocation(p.name);
      if ((t.flags & ts.TypeFlags.Any) !== 0 && !lowerer.chainNarrowedType.has(p.name)) {
        lowerer.chainNarrowedType.set(p.name, lowerer.checker.getUnknownType());
        overridden.push(p.name);
      }
    }
  }

  // the value's handle element while tsc's evolving analysis types the
  // callback's params by the pushed elements): the lead params BIND the
  // handles the loop passes, whatever the contextual type spelled —

  if (ts.isArrowFunction(argNode) || ts.isFunctionExpression(argNode)) {
    argNode.parameters.nodes.forEach((_p, _i) => {
      return;
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
    argNode.parameters.nodes.forEach((param, i) => {
      const expected = full[i];
      if (
        expected === undefined ||
        expected.kind === "dyn" ||
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
      // A helper that passes present number, string or boolean elements
      // (a `(T | undefined)[]` stores T elements) binds a `T | undefined`
      // parameter to T, so the callback takes them without an adapter.
      const presentElement =
        mapped !== null &&
        primitiveElement(expected) &&
        mapped.kind === "union" &&
        lowerer.armTag(mapped.unionId, UNDEFINED_T) >= 0 &&
        typeEquals(lowerer.stripUndefinedArm(mapped), expected);
      if (
        untyped
          ? !bindUntyped
          : mapped === null ||
            (lowerer.coercibleValue(expected, mapped) &&
              !runtimeOptionalPairVariant(lowerer, expected, mapped) &&
              !presentElement)
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
    argNode.parameters.nodes.forEach((param, i) => {
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

/** `String` as a one-parameter callback over `valueT`: the conversion a
 * direct `String(value)` call lowers to (the runtime's String() for unknown
 * values and unions holding a symbol, ToString otherwise), interned per
 * value type. */
function stringConversionCallback(
  lowerer: Lowerer,
  valueT: IrType,
  node: ts.Expression,
): IrExpr & { type: IrType & { kind: "func" } } {
  const loc = locOf(node);
  const fnT: IrType & { kind: "func" } = { kind: "func", params: [valueT], ret: STRING };
  const key = `mapString:${typeKey(valueT)}`;
  let name = lowerer.arrHofHelpers.get(key);
  if (!name) {
    name = `%arr.mapString.${lowerer.arrHofHelpers.size}`;
    lowerer.arrHofHelpers.set(key, name);
    const value = varRef("v.0", valueT, loc);
    const runtimeString =
      valueT.kind === "dyn" ||
      (valueT.kind === "union" &&
        lowerer.unions.get(valueT.unionId)?.arms.some((arm) => arm.kind === "symbol") === true &&
        lowerer.dynConvertible(valueT));
    const converted: IrExpr = runtimeString
      ? {
          kind: "libCall",
          fn: "dyn.stringConstructor",
          args: [lowerer.coerceToExpected(value, DYN)],
          type: STRING,
          loc,
        }
      : lowerer.ensureString(value, node);
    lowerer.liftedFns.push({
      name,
      params: [{ localId: "v.0", name: "v", type: valueT }],
      returnType: STRING,
      locals: [{ id: "v.0", name: "v", type: valueT, mutable: false }],
      body: [{ kind: "return", value: converted, loc }],
      loc,
    });
  }
  return { kind: "closure", fnName: name, captures: [], type: fnT, loc };
}

/** A native closure for the ambient Boolean callback. Reifying the
 * JavaScript constructor itself is unnecessary; Array#filter only observes
 * its one-argument ToBoolean result. */
export function truthyFilterCallback(
  lowerer: Lowerer,
  valueT: IrType,
  loc: SrcLoc,
): IrExpr & { type: IrType & { kind: "func" } } {
  const fnT: IrType & { kind: "func" } = { kind: "func", params: [valueT], ret: BOOL };
  const key = `filterBoolean:${typeKey(valueT)}`;
  let name = lowerer.arrHofHelpers.get(key);
  if (!name) {
    name = keyedHelperName(lowerer, "%arr.filterBoolean", key);
    lowerer.arrHofHelpers.set(key, name);
    const value = varRef("v.0", valueT, loc);
    lowerer.liftedFns.push({
      name,
      params: [{ localId: "v.0", name: "v", type: valueT }],
      returnType: BOOL,
      locals: [{ id: "v.0", name: "v", type: valueT, mutable: false }],
      body: [
        {
          kind: "return",
          value:
            valueT.kind === "dyn"
              ? { kind: "dynTest", test: "truthy", value, type: BOOL, loc }
              : { kind: "toBool", operand: value, type: BOOL, loc },
          loc,
        },
      ],
      loc,
    });
  }
  return { kind: "closure", fnName: name, captures: [], type: fnT, loc };
}
