import { keyedHelperName } from "../stable-names.js";
import * as ts from "../../ts7/adapter.js";
import type { Lowerer } from "../lowerer.js";
import { isJsSourceFile, locOf } from "../../program.js";
import { isThisParameter } from "../call-signatures.js";
import { callbackTakesEveryArgument } from "../callback-arg.js";
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

/** Whether the callback handed to an array method declares a rest
 * parameter. Such a callback lowers to a variadic closure, and a native
 * helper calls it with exactly the parameters it declares, so a call it
 * takes cannot ride the native tables. */
function arrayCallbackDeclaresRest(lowerer: Lowerer, call: ts.CallExpression): boolean {
  const callback = call.arguments.nodes[0];
  if (callback === undefined || ts.isSpreadElement(callback)) return false;
  return lowerer.checker.getCallSignatures(lowerer.typeOf(callback)).some((signature) => {
    const params = signature.declaration?.parameters?.nodes ?? [];
    return params.some((param) => ts.isParameter(param) && param.dotDotDotToken !== undefined);
  });
}

/** Whether `callback` names a constant that holds, under a declared type
 * with fewer parameters, a function that observes every argument (a rest
 * parameter, or `arguments`): `const one: (v: object) => number = counted`.
 * The constant holds an adapter that a native loop would call with the
 * declared parameters, and that is the original function again once it is
 * boxed, so the view calls the original with every argument the method
 * passes, as it did when these lists were checked-dynamic arrays. A
 * function that reaches the method any other way under such a type (a
 * parameter, a field) is not known here; the store check refuses it
 * (variadic-functions.ts). */
function namesVariadicConstant(lowerer: Lowerer, callback: ts.Expression): boolean {
  let node = callback;
  for (let hops = 0; hops < 8 && ts.isIdentifier(node); hops++) {
    let declarations: readonly ts.Node[];
    try {
      declarations = lowerer.resolveValueSymbol(node)?.declarations ?? [];
    } catch {
      return false;
    }
    const declaration = declarations.length === 1 ? declarations[0]! : undefined;
    if (
      declaration === undefined ||
      !ts.isVariableDeclaration(declaration) ||
      (ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const) === 0 ||
      declaration.initializer === undefined
    )
      return false;
    node = declaration.initializer;
    while (ts.isParenthesizedExpression(node)) node = node.expression;
    if (callbackTakesEveryArgument(lowerer, node)) return true;
  }
  return false;
}

/** Whether the callback handed to an array method is one a native helper's
 * loop cannot call, so that a list which has a checked-dynamic view runs
 * the method there, where the callback is called as any function value is.
 * The loop calls a closure of fixed arity with typed arguments. It does not
 * take a callback with a rest parameter (above, and a function value whose
 * compiled type keeps one), a constant that holds such a function under a
 * type with fewer parameters (namesVariadicConstant), a generator function (its results have no array
 * element kind), a function held as `any`, or a standard-library function,
 * whose compiled value takes one input type (`Number` as a value takes a
 * string). A standard-library function is known by its type, whose call
 * signature the library declares, not by how the call spells it: it is
 * the same value through a binding (`const toNumber = Number`), a property,
 * a parameter or an import. `String` and `Boolean` written as the globals
 * have loops of their own (lowerArrayCallback). In a JavaScript source a
 * function value is checked-dynamic already and lowerArrayCallback adapts
 * it at that boundary, so only the rest parameter counts there. */
export function arrayCallbackNeedsDynamicView(lowerer: Lowerer, call: ts.CallExpression): boolean {
  if (arrayCallbackDeclaresRest(lowerer, call)) return true;
  if (isJsSourceFile(ts.getSourceFileOfNode(call))) return false;
  let callback = call.arguments.nodes[0];
  if (callback === undefined || ts.isSpreadElement(callback)) return false;
  while (ts.isParenthesizedExpression(callback)) callback = callback.expression;
  if (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))
    return callback.asteriskToken !== undefined;
  if (
    ts.isIdentifier(callback) &&
    (callback.text === "String" || callback.text === "Boolean") &&
    lowerer.isStdlibSymbol(lowerer.resolveValueSymbol(callback) ?? undefined)
  )
    return false;
  if (namesVariadicConstant(lowerer, callback)) return true;
  const checkerType = lowerer.typeOf(callback);
  if ((checkerType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0) return true;
  if (
    lowerer.checker
      .getCallSignatures(checkerType)
      .some(
        (signature) =>
          signature.declaration !== undefined &&
          lowerer.isStdlibFile(ts.getSourceFileOfNode(signature.declaration)),
      )
  )
    return true;
  const type = lowerer.mapTypeOf(checkerType);
  return type?.kind === "func" && type.rest === true;
}

/** A callback's `(value, index, array)` positions count from its first
 * data parameter: TypeScript declares an explicit `this` parameter
 * first, and it is not one of them. */
function callbackDataParams(
  node: ts.ArrowFunction | ts.FunctionExpression,
): readonly ts.ParameterDeclaration[] {
  const params: readonly ts.ParameterDeclaration[] = node.parameters.nodes;
  return params.length > 0 && isThisParameter(params[0]!) ? params.slice(1) : params;
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
  /** The caller checks the callback's arity itself (requireFixedArityCallback)
   * because one of its paths boxes the callback as a checked-dynamic
   * function, which any function can be. */
  checksArity = false,
): {
  fnArg: IrExpr & { type: IrType & { kind: "func" } };
  arity: number;
  unread: boolean;
  /** The lowered callback's own type, before any slot adaptation below. A
   * caller that synthesizes the call itself needs the unadapted ABI: a JS
   * function whose `arguments` slot is its ABI ({params: [], rest: true})
   * is adapted to the visible slot here, losing that fact. */
  rawType: IrType;
} {
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
    const truthy = truthyFilterCallback(lowerer, valueT, locOf(argNode));
    return { fnArg: truthy, arity: 1, unread: false, rawType: truthy.type };
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
    const conversion = stringConversionCallback(lowerer, valueT, argNode);
    return { fnArg: conversion, arity: 1, unread: false, rawType: conversion.type };
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

  // A parameter registered to take the helper's checked-dynamic value as it
  // is (open-enumerations.ts) is declared `unknown` for this lowering, like
  // the untyped parameters above.
  if (ts.isArrowFunction(argNode) || ts.isFunctionExpression(argNode)) {
    for (const p of callbackDataParams(argNode)) {
      if (!ts.isIdentifier(p.name) || p.type || p.initializer || p.dotDotDotToken) continue;
      if (lowerer.chainNarrowedType.has(p.name)) continue;
      const symbol = lowerer.checker.getSymbolAtLocation(p.name);
      if (symbol && lowerer.runtimeOptionalBindingTypes.get(symbol)?.kind === "dyn") {
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
    callbackDataParams(argNode).forEach((param, i) => {
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
    callbackDataParams(argNode).forEach((param, i) => {
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
    // A literal callback takes the helper's argument types as its own
    // parameter types and converts at entry, where a callback value is
    // adapted to them below.
    fnArg =
      ts.isArrowFunction(argNode) || ts.isFunctionExpression(argNode)
        ? lowerer.lowerWithSlot(argNode, argNode, { params: full, ret: null, passesAll: false })
        : lowerer.lowerExpr(argNode);
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
  // A Node island's function arrives as its typed view at the slot the
  // checker spelled, which names the arguments JavaScript passes this
  // callback. The helper passes them in its own layout of (value, index,
  // array), so the view is taken at that layout, argument for argument.
  if (fnArg.type.kind === "func" && fnArg.type.params.length <= full.length) {
    const view = lowerer.islandFunctionViewAt(
      fnArg,
      argNode,
      funcOf(full.slice(0, fnArg.type.params.length), expectedReturn ?? fnArg.type.ret),
    );
    if (view !== null) fnArg = view;
  }
  const rawType = fnArg.type;
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
    // A checked-dynamic function whose signature answers nothing
    // (`names.forEach(console.log)`) takes every position the helper
    // passes, as the JavaScript function does: value, index and array.
    if (ret) fnArg = lowerer.coerceToExpected(fnArg, funcOf(full, ret));
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
  // A DYN-receiver HOF whose callback declares NARROWER parameters than
  // the dyn element the helper passes (`.filter((m): m is string => ...)`
  // on `xs.map(...)` where the checker types the callback parameter
  // `string | undefined` from the receiver's precise element while the
  // receiver LOWERS to the checked-dynamic array): the callback is a
  // value whose parameter types are the checker's proof of what the dyn
  // element holds, so each argument crosses the checked-dynamic boundary
  // into them with the usual checked conversion — a lying type throws,
  // like any other checked extraction, instead of reading a mistyped
  // value. Adapt the callback to the helper's ABI rather than refusing.
  if (
    fnArg.type.kind === "func" &&
    fnArg.type.params.length <= full.length &&
    !fnArg.type.params.every((p, i) => typeEquals(p, full[i]!)) &&
    fnArg.type.params.every((p, i) => typeEquals(p, full[i]!) || full[i]!.kind === "dyn")
  ) {
    const func = fnArg.type as IrType & { kind: "func" };
    fnArg = lowerer.coerceToExpected(fnArg, funcOf(full.slice(0, func.params.length), func.ret));
  }
  if (
    fnArg.type.kind !== "func" ||
    fnArg.type.params.length > full.length ||
    !fnArg.type.params.every((p, i) => typeEquals(p, full[i]!))
  ) {
    // A function whose parameters past the element cannot hold what the
    // method passes there (`items.map(format)` with `format(item, options?)`):
    // JavaScript would hand it the index as its options. Name the position
    // and the rewrite instead of the function's type.
    if (fnArg.type.kind === "func" && fnArg.type.params.length <= full.length) {
      const params = fnArg.type.params;
      const at = params.findIndex((p, i) => i >= lead.length && !typeEquals(p, full[i]!));
      if (at >= 0)
        lowerer.unsupported(
          "SC1090",
          argNode,
          `an array-method callback whose parameter ${at + 1} is '${lowerer.fmt(params[at]!)}' where the method passes ${at === lead.length ? "the index" : "the array"} (JavaScript calls the callback with the element, its index and the array, so the function would receive that value; pass a function that takes only what it reads, such as '(value) => f(value)')`,
        );
    }
    lowerer.badType(argNode, lowerer.typeOf(argNode));
  }
  if (!checksArity) requireFixedArityCallback(lowerer, argNode, fnArg.type);
  return {
    fnArg: fnArg as IrExpr & { type: IrType & { kind: "func" } },
    arity: fnArg.type.params.length,
    unread: !readsParameter(argNode, lead.length - 1),
    rawType,
  };
}

/** A helper's loop calls its callback as a closure of fixed arity. A
 * callback that takes a rest parameter, or whose whole signature is
 * `arguments`, receives its arguments through a hidden array that only a
 * call through the checked-dynamic function boundary fills, so the loop
 * cannot call it: it would see none of the element, index and array that
 * JavaScript passes. Refuse it by name before a helper is built for it; a
 * helper whose callback type is not the callback's own fails validation as
 * an internal error. */
export function requireFixedArityCallback(
  lowerer: Lowerer,
  argNode: ts.Expression,
  callback: IrType,
): void {
  if (callback.kind !== "func" || callback.rest !== true) return;
  lowerer.unsupported(
    "SC1090",
    argNode,
    "a callback that takes a rest parameter or reads 'arguments', passed to an array method that calls it with a fixed argument list (name the parameters the callback uses)",
  );
}

/** Whether a callback can observe its parameter at `index`: false for a
 * function or arrow expression that declares no such parameter, or binds
 * it to a plain name that appears nowhere else in it (any identifier of
 * that name counts, including shorthand properties and shadowing
 * bindings). Any other callback may. `index` counts the callback's data
 * parameters: an explicit `this` parameter is not one of them. */
function readsParameter(argNode: ts.Expression, index: number): boolean {
  if (!ts.isArrowFunction(argNode) && !ts.isFunctionExpression(argNode)) return true;
  const params = callbackDataParams(argNode);
  const param = params[index];
  if (!param) return false;
  if (!ts.isIdentifier(param.name) || param.initializer || param.dotDotDotToken) return true;
  const name = param.name.text;
  const mentions = (node: ts.Node): boolean =>
    (node !== param.name &&
      ts.isIdentifier(node) &&
      (node.text === name || node.text === "arguments")) ||
    (ts.forEachChild(node, (child) => (mentions(child) ? true : undefined)) ?? false);
  return params.some((other) => other !== param && mentions(other)) || mentions(argNode.body);
}

/** The result array's element when it is the unit-only union (`undefined[]`,
 * the sparse-literal/`Array.from(..., () => undefined)` shape): a callback
 * that answers `undefined` stores a PRESENT unit element, so the producer
 * gives the callback that union as its contextual return. The standalone
 * `undefined` in return position otherwise maps to the void convention,
 * whose answer is erased before it could be stored. Null for other elements. */
export function unitOnlyArrayElement(lowerer: Lowerer, call: ts.CallExpression): IrType | null {
  const result = lowerer.mapTypeOf(lowerer.typeOf(call));
  if (result?.kind !== "array") return null;
  const elem = result.elem;
  if (isUnitType(elem)) return elem;
  return elem.kind === "union" &&
    lowerer.unions.get(elem.unionId)?.arms.every((arm) => isUnitType(arm)) === true
    ? elem
    : null;
}

/** Lower a callback whose answer becomes an array element, with the result
 * element as its contextual return when that element is the unit-only union
 * (see unitOnlyArrayElement). Other producers lower the callback directly. */
export function lowerArrayCallbackAnswering(
  lowerer: Lowerer,
  fnNode: ts.Expression,
  expected: IrType | null,
): IrExpr {
  if (expected === null) return lowerer.lowerExpr(fnNode);
  const previous = lowerer.contextualFunctionReturns.get(fnNode);
  lowerer.contextualFunctionReturns.set(fnNode, expected);
  try {
    return lowerer.lowerExpr(fnNode);
  } finally {
    if (previous === undefined) lowerer.contextualFunctionReturns.delete(fnNode);
    else lowerer.contextualFunctionReturns.set(fnNode, previous);
  }
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
