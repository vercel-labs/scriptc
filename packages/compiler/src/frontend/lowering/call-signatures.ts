import { shapeOverlayAnnotated } from "../shape-inference/index.js";
import { layoutReturnType } from "./structural-instances.js";
import {
  typedArgumentsCandidate,
  typedArgumentsShapes,
  typedArgumentsTarget,
} from "./typed-arguments.js";
import { InternalCompilerError } from "../../errors.js";
import * as ts from "../ts7/adapter.js";
import { argumentsAliasingUnobservable, bodyReadsArguments } from "../arguments-usage.js";
import type { Lowerer } from "./lowerer.js";
import {
  canBoxFuncIntoDyn,
  DYN,
  type IrExpr,
  type IrFunction,
  type IrType,
  UNDEFINED_T,
  VOID,
  isUnitType,
  typeEquals,
} from "../../ir/ir.js";
import { isJsSourceFile, isNodeEsmFile } from "../program.js";
import {
  genResultRecord,
  restTupleParamTypes,
  isAnyArrayType,
  isUnitOnlyTsType,
  jsOpenObjectType,
  unitOnlyUnion,
} from "../type-mapper.js";
import { dynFallbackType } from "./lowerer.js";
import { builtinModuleFnOf } from "./surfaces.js";
import { mixinFnShapeOf } from "./lower-mixins.js";
import { isStreamUndefCallExpr } from "./lower-server.js";
import { nsPathPrefix } from "./lower-namespaces.js";
import { declSymbolOf } from "./lower-modules.js";
import { npmStaticPackageOfPath } from "../npm-static.js";
import { restPackingAdapterFits } from "./coercions/function-adapters.js";
import { implicitMonoFile, implicitAnyParamSymbolsOf } from "./generic-functions.js";

/** How a parameter participates in CALL-SITE COMPLETION (the frontend
 * completes every call to the one full signature, so the IR and backends
 * stay count-exact — see docs/ir.md). `required` params must be passed;
 * `omittable` params (declared `x?: T` or `x: T = e`) may be omitted by a
 * trailing-suffix call, and the frontend appends the interned undefined arm;
 * `rest` (always last) receives the surplus arguments packed into one array
 * literal at each call site. `arguments` is a hidden slot containing every
 * actual argument, including those bound to named parameters. */
export type ParamMode = "required" | "omittable" | "rest" | "dynRest" | "arguments";

/** One parameter of a signature, as call sites and callee prologues see it.
 * `type` is the ABI type — what the emitted LLVM parameter carries: the
 * checker's `T | undefined` union for `x?: T`, a synthesized `T | undefined`
 * union for `x: T = e`, `T[]` for `...xs: T[]`, the plain declared type
 * otherwise. `bodyType` is present exactly for DEFAULTED program params:
 * the plain T the body sees after the prologue applies the default (see
 * declareParams). `callDefault` is the compile-time default value for a
 * table-backed builtin's omittable slot. `entryNarrow` marks a dyn ABI slot
 * inherited from a JavaScript base method whose TypeScript override declares
 * a typed parameter: the prologue narrows the checked value to that type. */
export interface ParamShape {
  type: IrType;
  mode: ParamMode;
  bodyType?: IrType;
  callDefault?: IrExpr;
  entryNarrow?: IrType;
  /** One flattened position of a fixed-tuple rest parameter
   * (restTupleShapes): the declaration's last parameter owns every shape
   * from its index on, and the body binds the tuple (declareParams). */
  restTuple?: true;
}

export interface FnSig {
  name: string;
  params: ParamShape[];
  /** Call-site result type — Promise<inner> for async functions, the
   * generator type for generator functions. */
  returnType: IrType;
  /** Async: the IrFunction's returnType is the promise's INNER type, or
   * the generator's TReturn when generator is also present. */
  isAsync?: boolean;
  /** Generator: the IrFunction's returnType is the TReturn channel; the
   * yield/next channels ride here (IrFunction.generator's exact shape). */
  generator?: { yieldT: IrType; nextT: IrType; resultType: IrType & { kind: "record" } };
}

export function funcTypeFromParamShapes(
  shapes: readonly ParamShape[],
  ret: IrType,
): IrType & { kind: "func" } {
  const typedRest = shapes.some((shape) => shape.mode === "rest");
  const dynRest = shapes.some((shape) => shape.mode === "dynRest");
  const argumentsAll = shapes.some((shape) => shape.mode === "arguments");
  return {
    kind: "func",
    params: shapes
      .filter((shape) => shape.mode !== "dynRest" && shape.mode !== "arguments")
      .map((shape) => shape.type),
    ret,
    ...(typedRest || dynRest || argumentsAll ? { rest: true as const } : {}),
    ...(argumentsAll ? { argumentsAll: true as const } : {}),
    ...(typedRest ? { restAbi: "typed" as const } : {}),
  };
}

/** Registers `const alias = overloadedDeclaration` as a compile-time
 * callable projection. The source function's one implementation ABI is
 * already collected in fnSigsBySymbol; each direct call still uses the
 * TS7-resolved overload result bridge. The alias owns no storage, and a
 * value read materializes the source function's interned closure, so JS
 * identity (`alias === source`) is preserved. */
export function registerOverloadedCallableAlias(
  lowerer: Lowerer,
  decl: ts.VariableDeclaration,
): boolean {
  if (!ts.isIdentifier(decl.name) || !decl.initializer) return false;
  let init: ts.Expression = decl.initializer;
  while (ts.isParenthesizedExpression(init)) init = init.expression;
  if (!ts.isIdentifier(init)) return false;
  const aliasType = lowerer.typeOf(decl.name);
  if (lowerer.checker.getCallSignatures(aliasType).length < 2) return false;
  const sourceSymbol = lowerer.resolveValueSymbol(init);
  if (!sourceSymbol) return false;
  const sourceProjection = lowerer.staticCallables.get(sourceSymbol);
  const signature =
    lowerer.fnSigsBySymbol.get(sourceSymbol) ??
    (sourceProjection?.kind === "declared-function" ? sourceProjection.signature : undefined);
  if (!signature) return false;
  const aliasSymbol = lowerer.checker.getSymbolAtLocation(decl.name);
  if (!aliasSymbol) return false;
  lowerer.staticCallables.set(aliasSymbol, { kind: "declared-function", signature });
  return true;
}

export function generatorMeta(
  lowerer: Lowerer,
  type: IrType & { kind: "generator" },
): NonNullable<IrFunction["generator"]> {
  const resultType = genResultRecord(type.yieldT, type.retT, lowerer.shapes, lowerer.unions);
  if (resultType === null) {
    throw new InternalCompilerError(
      "lowerer bug: mapped generator without an IteratorResult record",
    );
  }
  return { yieldT: type.yieldT, nextT: type.nextT, resultType };
}

/** A function expression stored as a prototype method: `C.prototype.name =
 * function (...) {}` or `C.prototype[key] = function (...) {}`
 * (parentheses allowed around the function). */
export function prototypeAssignedFunction(fn: ts.Node | undefined): boolean {
  if (fn === undefined || !ts.isFunctionExpression(fn)) return false;
  let node: ts.Node = fn;
  while (node.parent !== undefined && ts.isParenthesizedExpression(node.parent)) node = node.parent;
  const parent = node.parent;
  if (
    parent === undefined ||
    !ts.isBinaryExpression(parent) ||
    parent.right !== node ||
    parent.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
    !(ts.isPropertyAccessExpression(parent.left) || ts.isElementAccessExpression(parent.left))
  )
    return false;
  const owner = parent.left.expression;
  return ts.isPropertyAccessExpression(owner) && owner.name.text === "prototype";
}

/** A parameter with a type annotation or a JSDoc `@param`/`@type` tag. */
export function documentedParameter(param: ts.ParameterDeclaration): boolean {
  return (
    param.type !== undefined ||
    /@(?:param|type)\b/.test(
      ts
        .getSourceFileOfNode(param)
        .text.slice(param.parent?.pos ?? param.pos, ts.tokenStartOfNode(param)),
    )
  );
}

/** A documented parameter in a JavaScript file TypeScript checks. */
export function checkedJsDocumentedParameter(
  lowerer: Lowerer,
  param: ts.ParameterDeclaration,
): boolean {
  if (
    param.parent !== undefined &&
    shapeOverlayAnnotated(param.parent) &&
    documentedParameter(param)
  )
    return true;
  return lowerer.checkedJsFile(ts.getSourceFileOfNode(param)) && documentedParameter(param);
}

/** One parameter's ParamShape — the shared signature-shaped collection
 * point for function declarations, methods, constructors, and lambdas
 * (generic declarations defer to their call sites, where the resolved
 * types exist; see lowerGenericCall).
 *
 * - `x?: T`: the checker already types the param `T | undefined` under
 *   strictNullChecks, so the ABI type IS that union and the body narrows
 *   with `!== undefined` like any union local.
 * - `x: T = e`: the ABI type is a synthesized `T | undefined` union (the
 *   caller may omit the arg or pass undefined — both trigger the default,
 *   JS-exact); the body sees plain T through the two-local prologue
 *   (declareParams). A single-arm T narrows in the prologue; a UNION T
 *   re-tags through the interned retag helper (the undefined arm is the
 *   one stranded case, unreachable from the else-branch by construction).
 * - `...xs: T[]`: the ABI type is the array; call sites pack the surplus.
 */
export function paramShape(lowerer: Lowerer, param: ts.ParameterDeclaration): ParamShape {
  const stage = lowerer.stageSourceType(param.name);
  if (stage) return { type: stage, mode: "required" };
  if (isJsSourceFile(ts.getSourceFileOfNode(param)) && ts.isSetAccessorDeclaration(param.parent))
    return { type: DYN, mode: "required" };
  if (
    isJsSourceFile(ts.getSourceFileOfNode(param)) &&
    ts.isConstructorDeclaration(param.parent) &&
    !param.dotDotDotToken &&
    !checkedJsDocumentedParameter(lowerer, param)
  ) {
    // Reflective JavaScript construction can supply values outside the
    // constructor's documented usual types. Retain the actual arguments
    // and apply checked conversions only at operations that need them.
    // In a file TypeScript checks, documented types are enforced like
    // TypeScript annotations.
    return param.initializer
      ? { type: DYN, mode: "omittable", bodyType: DYN }
      : { type: DYN, mode: param.questionToken ? "omittable" : "required" };
  }
  if (
    isJsSourceFile(ts.getSourceFileOfNode(param)) &&
    !param.dotDotDotToken &&
    prototypeAssignedFunction(param.parent) &&
    !checkedJsDocumentedParameter(lowerer, param)
  ) {
    // A prototype method (`C.prototype.m = function (a) {}`) is called
    // through dynamic dispatch, where callers pass whatever they hold. As
    // for constructors, JSDoc in a file TypeScript does not check
    // documents the usual types without constraining callers.
    return param.initializer
      ? { type: DYN, mode: "omittable", bodyType: DYN }
      : { type: DYN, mode: param.questionToken ? "omittable" : "required" };
  }
  const executor = param.parent;
  const construction = executor?.parent;
  const nativeExecutor =
    executor &&
    (ts.isArrowFunction(executor) || ts.isFunctionExpression(executor)) &&
    ts.isNewExpression(construction) &&
    construction.arguments?.nodes[0] === executor &&
    lowerer.isStdlibGlobal(construction.expression, "Promise");
  if (
    !nativeExecutor &&
    isJsSourceFile(ts.getSourceFileOfNode(param)) &&
    !param.type &&
    !param.dotDotDotToken &&
    !ts.isSetAccessorDeclaration(param.parent) &&
    !/@(?:param|type)\b/.test(
      ts
        .getSourceFileOfNode(param)
        .text.slice(param.parent?.pos ?? param.pos, ts.tokenStartOfNode(param)),
    )
  ) {
    return param.initializer
      ? { type: DYN, mode: "omittable", bodyType: DYN }
      : { type: DYN, mode: "required" };
  }
  if (
    param.initializer &&
    isJsSourceFile(ts.getSourceFileOfNode(param)) &&
    !param.type &&
    !/@(?:param|type)\b/.test(
      ts
        .getSourceFileOfNode(param)
        .text.slice(param.parent?.pos ?? param.pos, ts.tokenStartOfNode(param)),
    )
  ) {
    return { type: DYN, mode: "omittable", bodyType: DYN };
  }
  // Inferred JS array patterns describe the bindings, not an exact tuple
  // contract. Consume the actual iterable, including surplus elements.
  if (
    ts.isArrayBindingPattern(param.name) &&
    isJsSourceFile(ts.getSourceFileOfNode(param)) &&
    !param.type &&
    !/@(?:param|type)\b/.test(
      ts
        .getSourceFileOfNode(param)
        .text.slice(param.parent?.pos ?? param.pos, ts.tokenStartOfNode(param)),
    )
  ) {
    if (param.dotDotDotToken) return { type: DYN, mode: "dynRest" };
    return param.initializer
      ? { type: DYN, mode: "omittable", bodyType: DYN }
      : { type: DYN, mode: "required" };
  }
  if (lowerer.checkedCallbackParams.has(param)) {
    if (param.dotDotDotToken) return { type: DYN, mode: "dynRest" };
    return param.initializer
      ? { type: DYN, mode: "omittable", bodyType: DYN }
      : { type: DYN, mode: "required" };
  }
  const moduleNs = lowerer.moduleNsParamOverrides.get(param);
  if (moduleNs !== undefined) {
    return { type: moduleNs, mode: param.questionToken ? "omittable" : "required" };
  }
  if (!ts.isIdentifier(param.name)) {
    // A destructuring pattern parameter — `([label, value]) => ...`,
    // `({ x }) => ...`. The ABI slot carries the SOURCE value (the
    // tuple/array/record itself); the callee prologue desugars the reads
    // through the declaration-destructuring machinery (declareParams →
    // lowerBindingPattern), so the fences inside patterns (computed
    // keys, class-instance sources, union sources) are the declaration
    // fences verbatim. A rest parameter bound to a pattern would need
    // the packing machinery on top — fenced.
    if (param.questionToken) {
      lowerer.unsupported("SC1031", param, "optional destructuring pattern parameters");
    }
    if (param.dotDotDotToken) {
      // A REST parameter bound to a pattern (`(...[[k1, v1]]: [string,
      // number][])`): the ABI packs the surplus arguments into one
      // array exactly like an identifier rest param; the prologue then
      // destructures the packed array through the declaration
      // machinery (declareParams → lowerBindingPattern).
      const type = lowerer.irTypeOf(param.name);
      const tupleRest = type.kind === "record" && lowerer.shapes.get(type.shapeId)?.tuple === true;
      if (type.kind !== "array" && !tupleRest)
        lowerer.badType(param.name, lowerer.typeOf(param.name));
      return { type, mode: "rest" };
    }
    if (param.initializer) {
      // A WHOLE-PATTERN default (`({ x } = { x: 1 }) => ...`): the ABI
      // slot arms the pattern's type with undefined, exactly the
      // identifier-param default below; the callee prologue picks the
      // default when the argument was omitted or undefined, then the
      // pattern destructures the picked value (declareParams).
      const raw = lowerer.irTypeOf(param.name);
      return defaultParameterShape(lowerer, param, raw);
    }
    return {
      type: lowerer.runtimeOptionalBindingType(param.name, lowerer.irTypeOf(param.name)),
      mode: "required",
    };
  }
  if (param.dotDotDotToken) {
    // A JS rest param with no static element type (`(...args)` — any[]):
    // the VARIADIC dyn form. The lifted function takes one trailing dyn
    // ARRAY param the dyn call thunk fills with the call's surplus
    // arguments; the binding is that array (dynRest — funcType marks
    // `rest`, and the value only ever calls through the boxed thunk).
    if (isJsSourceFile(ts.getSourceFileOfNode(param))) {
      const restMapped = lowerer.mapTypeOf(lowerer.typeOf(param.name));

      // Unmapped JS rest parameters use the native variadic checked-value ABI.
      if (restMapped?.kind !== "array") {
        return { type: DYN, mode: "dynRest" };
      }
    }
    // `...args: unknown[]` / `...args: any[]` in TypeScript: the binding is
    // the checked-dynamic array (how `unknown[]` maps everywhere), so the
    // ABI is the JS variadic dyn form above — the function type marks it
    // with `rest` and no typed slot (the type mapper agrees).
    const restTs = lowerer.typeOf(param.name);
    if (isAnyArrayType(restTs, lowerer.checker)) return { type: DYN, mode: "dynRest" };
    const type = lowerer.runtimeOptionalBindingType(param.name, lowerer.irTypeOf(param.name));
    if (type.kind === "dyn") return { type: DYN, mode: "dynRest" };
    // Tuple-typed rest params don't map to an array; generic rest is the
    // generic path's business. Anything non-array here is unmappable.
    if (type.kind !== "array") lowerer.badType(param.name, restTs);
    return { type, mode: "rest" };
  }
  if (param.initializer) {
    const raw = lowerer.irTypeOf(param.name);
    // An optional JS array parameter is a live caller-owned buffer,
    // including typed arrays passed through checked callbacks. Extracting
    // a native array here would copy it and discard element writes.
    if (
      isJsSourceFile(ts.getSourceFileOfNode(param)) &&
      !param.type &&
      (raw.kind === "array" ||
        (raw.kind === "union" &&
          lowerer.unions.get(raw.unionId)?.arms.some((arm) => arm.kind === "array")))
    ) {
      return { type: DYN, mode: "omittable", bodyType: DYN };
    }
    return defaultParameterShape(lowerer, param, raw);
  }
  let type = lowerer.runtimeOptionalBindingType(param.name, lowerer.irTypeOf(param.name));
  const body = param.parent?.body;
  if (isJsSourceFile(ts.getSourceFileOfNode(param)) && body && type.kind !== "dyn") {
    const symbol = lowerer.checker.getSymbolAtLocation(param.name);
    let acceptsUndefined = false;
    ts.walkPreorder(body, (node) => {
      if (acceptsUndefined || !ts.isBinaryExpression(node)) return;
      const op = node.operatorToken.kind;
      if (
        op !== ts.SyntaxKind.EqualsEqualsEqualsToken &&
        op !== ts.SyntaxKind.ExclamationEqualsEqualsToken &&
        op !== ts.SyntaxKind.EqualsEqualsToken &&
        op !== ts.SyntaxKind.ExclamationEqualsToken
      )
        return;
      const checks = (value: ts.Expression, absent: ts.Expression): boolean =>
        ts.isIdentifier(value) &&
        ts.isIdentifier(absent) &&
        absent.text === "undefined" &&
        (lowerer.typeOf(absent).flags & ts.TypeFlags.Undefined) !== 0 &&
        lowerer.checker.getSymbolAtLocation(value) === symbol;
      acceptsUndefined = checks(node.left, node.right) || checks(node.right, node.left);
    });
    // A JavaScript body that handles an absent argument defines a wider
    // contract than its JSDoc's usual value. Checked callers must deliver
    // undefined to that branch rather than reject it at the ABI boundary.
    if (acceptsUndefined) type = lowerer.promoteRuntimeOptionalParameter(param.name, type);
  }
  if (type.kind === "void") {
    return { type: DYN, mode: param.questionToken ? "omittable" : "required" };
  }
  if (param.questionToken && !lowerer.bareUndefinedArmedUnion(type) && type.kind !== "dyn") {
    // An omitted argument requires an undefined union arm or a native
    // checked-value slot that can hold undefined directly.
    lowerer.unsupported("SC1090", param, `optional parameters of type '${lowerer.fmt(type)}'`);
  }
  return { type, mode: param.questionToken ? "omittable" : "required" };
}

/** A `this` PARAMETER declaration (`function f(this: void, x: {}) ...`)
 * — type-world only: tsc types the receiver with it, callers never pass
 * it, and signature.getParameters() excludes it. The syntactic walks
 * (paramShapes, declareParams) skip it with this predicate so ABI slots
 * and call completion stay aligned with what JS actually passes. */
export function isThisParameter(param: ts.ParameterDeclaration): boolean {
  return ts.isIdentifier(param.name) && param.name.text === "this";
}

/** A TypeScript rest parameter bound to a name whose type is a fixed tuple
 * (`...args: [A, B]`, `...args: A` with A bound to a tuple, `...args:
 * Parameters<F>` with F bound): one required shape per position. Call
 * sites and function values see the equivalent fixed signature; the body
 * rebuilds the tuple (declareParams) unless it only forwards it. Null for
 * every other parameter. */
export function restTupleShapes(
  lowerer: Lowerer,
  param: ts.ParameterDeclaration,
  tsType?: ts.Type,
): ParamShape[] | null {
  if (
    param.dotDotDotToken === undefined ||
    !ts.isIdentifier(param.name) ||
    isJsSourceFile(ts.getSourceFileOfNode(param))
  ) {
    return null;
  }
  const elems = restTupleParamTypes(tsType ?? lowerer.typeOf(param.name), lowerer.typeCtx);
  return elems ? elems.map((type) => ({ type, mode: "required", restTuple: true })) : null;
}

/** ParamShapes for a whole parameter list. */
export function paramShapes(
  lowerer: Lowerer,
  params: readonly ts.ParameterDeclaration[],
  signature?: ts.Signature,
  blameOf?: (param: ts.ParameterDeclaration, index: number) => ts.Node,
): ParamShape[] {
  const out: ParamShape[] = [];
  if (!signature) {
    for (const param of params) {
      if (isThisParameter(param)) continue;
      const flattened = restTupleShapes(lowerer, param);
      if (flattened) out.push(...flattened);
      else out.push(lowerer.paramShape(param));
    }
    return out;
  }
  const symbols = signature.getParameters();
  const shapeAt = (declParam: ts.ParameterDeclaration, i: number): ParamShape => {
    const stage = lowerer.stageSourceType(declParam.name);
    if (stage) return { type: stage, mode: "required" as const };
    const symbol = symbols[i];
    const tsType = symbol
      ? lowerer.checker.getTypeOfSymbol(symbol)
      : lowerer.typeOf(declParam.name);
    // A call-site instantiation whose concrete argument type does not map
    // is that argument's blocker: name it there, with its concrete type,
    // rather than as the declaration's unbound type parameter.
    if (
      blameOf !== undefined &&
      !isJsSourceFile(ts.getSourceFileOfNode(declParam)) &&
      (tsType.flags & ts.TypeFlags.Any) === 0 &&
      declParam.type !== undefined &&
      mentionsTypeParameter(lowerer, lowerer.checker.getTypeFromTypeNode(declParam.type)) &&
      lowerer.mapTypeOf(tsType) === null
    ) {
      lowerer.badType(blameOf(declParam, i), tsType);
    }
    let mapped = jsOpenObjectType(
      declParam,
      lowerer.runtimeOptionalBindingType(
        declParam.name,
        lowerer.mapTypeOf(tsType) ??
          // A TypeScript instantiation at `any` (a type argument inferred
          // from an untyped value) takes the checked-dynamic slot.
          ((tsType.flags & ts.TypeFlags.Any) !== 0 &&
          !isJsSourceFile(ts.getSourceFileOfNode(declParam))
            ? DYN
            : lowerer.irTypeOf(declParam.name)),
      ),
      lowerer.shapes,
      lowerer.unions,
    );
    // An instantiation with a literal `undefined` argument (`id(undefined)`
    // binds T = undefined): standalone undefined maps to VOID (the return
    // convention), and a parameter is a value position, so it takes the
    // unit-only slot like a declared `v: undefined` parameter.
    if (mapped?.kind === "void" && isUnitOnlyTsType(tsType)) mapped = unitOnlyUnion(lowerer.unions);
    if (!mapped || mapped.kind === "void")
      lowerer.badType(blameOf?.(declParam, i) ?? declParam.name, tsType);
    if (declParam.dotDotDotToken) {
      if (mapped.kind !== "array")
        lowerer.badType(blameOf?.(declParam, i) ?? declParam.name, tsType);
      return { type: mapped, mode: "rest" };
    }
    if (declParam.initializer) return defaultParameterShape(lowerer, declParam, mapped);
    // A checked-value slot holds undefined directly, so an omitted
    // argument needs no union arm (paramShape's declared-signature rule;
    // an erased type parameter and a class-implemented interface view
    // both map here).
    if (
      declParam.questionToken &&
      !lowerer.bareUndefinedArmedUnion(mapped) &&
      mapped.kind !== "dyn"
    ) {
      lowerer.unsupported(
        "SC1090",
        declParam,
        `optional parameters of type '${lowerer.fmt(mapped)}'`,
      );
    }
    return { type: mapped, mode: declParam.questionToken ? "omittable" : "required" };
  };
  params.forEach((declParam, i) => {
    const symbol = symbols[i];
    const flattened = restTupleShapes(
      lowerer,
      declParam,
      symbol ? lowerer.checker.getTypeOfSymbol(symbol) : undefined,
    );
    if (flattened) out.push(...flattened);
    else out.push(shapeAt(declParam, i));
  });
  return out;
}

/** A declared type that is (or is a union over) a bare type parameter
 * or an instantiation of a generic alias/interface over type arguments. */
function mentionsTypeParameter(
  lowerer: Lowerer,
  t: ts.Type,
  seen: Set<ts.Type> = new Set(),
): boolean {
  if (t.flags & ts.TypeFlags.TypeParameter) return true;
  // A recursive alias (`type Child = string | Child[]`) reaches itself
  // through its own type arguments; a type already on the walk adds nothing.
  if (seen.has(t)) return false;
  seen.add(t);
  const mentions = (part: ts.Type): boolean => mentionsTypeParameter(lowerer, part, seen);
  if (t.isUnionType()) return ts.constituentTypes(t).some(mentions);
  if (t.getAliasTypeArguments().some(mentions)) return true;
  return (
    (t.flags & ts.TypeFlags.Object) !== 0 &&
    ((t as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference) !== 0 &&
    lowerer.checker.getTypeArguments(t as ts.TypeReference).some(mentions)
  );
}

/** A default expression may itself yield undefined. Keep that arm in the
 * body and parameter-property storage, including for literal `undefined`
 * and void expressions: the general type mapper represents those as VOID,
 * so checking only a mapped undefinedT erased a valid value without an error.
 * Shared by declared and instantiated signatures, including destructuring. */
function defaultParameterShape(
  lowerer: Lowerer,
  param: ts.ParameterDeclaration,
  raw: IrType,
): ParamShape {
  if (raw.kind === "dyn") {
    return { type: raw, mode: "omittable", bodyType: raw };
  }
  if (lowerer.bareUndefinedArmedUnion(raw) && param.initializer) {
    const initializer = lowerer.typeOf(param.initializer);
    const parts = initializer.isUnionType() ? ts.constituentTypes(initializer) : [initializer];
    if (parts.some((part) => (part.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) !== 0)) {
      return { type: raw, mode: "omittable", bodyType: raw };
    }
  }
  const bodyType = lowerer.stripUndefinedArm(raw);
  lowerer.checkDefaultParamBodyType(param, bodyType);
  const abi =
    bodyType.kind === "union"
      ? lowerer.withUndefinedArmOf(bodyType)
      : lowerer.withUndefinedArm(bodyType);
  if (!abi) lowerer.badType(param.name, lowerer.typeOf(param.name));
  return { type: abi, mode: "omittable", bodyType };
}

/** The fences on a defaulted parameter's body type: it becomes the value
 * arm of the synthesized `T | undefined` ABI union, so it must be a valid
 * single arm. Functions, Maps and Sets are valid: the ABI union's test is
 * the prologue's own undefined-tag check (never a user narrowing, which
 * is what keeps containers out of unions with data siblings), so `runner: Runner =
 * defaultRunner` and `skip: Set<string> = new Set()` arm like any ref
 * kind — the nullable-callback union shape, built by the compiler. */
export function checkDefaultParamBodyType(
  lowerer: Lowerer,
  param: ts.ParameterDeclaration,
  bodyType: IrType,
): void {
  if (
    bodyType.kind === "void" ||
    bodyType.kind === "regex" ||
    bodyType.kind === "dyn" ||
    isUnitType(bodyType)
  ) {
    lowerer.unsupported(
      "SC1090",
      param,
      `parameter default values on '${lowerer.fmt(bodyType)}'-typed parameters`,
    );
  }
}

/** DECISION (docs/ir.md): function VALUES carry one completed native ABI.
 * Optional/default parameters appear as literal `T | undefined` slots;
 * typed rest parameters appear as one trailing typed-array slot plus the
 * typed-rest marker that makes indirect call sites pack source arguments.
 * A value is admitted only where its target type projects to that same
 * completed signature. */
export function requireExactArityValue(
  lowerer: Lowerer,
  blame: ts.Node,
  contextual: ts.Expression | null,
  shapes: readonly ParamShape[],
  funcType: IrType,
): void {
  // dynRest params ride the boxed thunk (JS arity — no completed-ABI
  // spelling exists or is needed); they don't gate the value form.

  // Omittable checked-value slots also keep their declared param type (no
  // synthesized union), so every func-type spelling of the signature
  // already matches and short calls through the value complete with the
  // native undefined value (omittedArgFor).
  if (
    shapes.every(
      (s) =>
        s.mode === "required" ||
        s.mode === "dynRest" ||
        s.mode === "arguments" ||
        (s.mode === "omittable" && s.type.kind === "dyn"),
    )
  ) {
    return;
  }
  // The type the value FLOWS under must spell the completed ABI: the
  // contextual (target) type when one exists, otherwise the expression's
  // OWN inferred type — the unannotated-const case (`const f = (x = 5) =>
  // ...`), where every later read types the value by that inference and
  // optional/defaulted params spell their `T | undefined` slots (mapType's
  // completed-signature contract), so omitted trailing args complete with
  // the undefined arm like any direct call.
  // A nested function declaration whose only non-required parameter is a
  // typed rest: its value carries the typed-rest ABI its own type spells,
  // and every use converts it at its slot (same signature, or the rest
  // packing adapter for fixed parameters).
  if (
    contextual === null &&
    ts.isFunctionDeclaration(blame) &&
    blame.name !== undefined &&
    funcType.kind === "func" &&
    funcType.restAbi === "typed" &&
    shapes.every((s) => s.mode === "required" || s.mode === "rest")
  ) {
    const own = lowerer.mapTypeOf(lowerer.typeOf(blame.name));
    if (own && typeEquals(own, funcType)) return;
  }
  const target = contextual ? lowerer.checker.getContextualType(contextual) : undefined;
  const mapped = target
    ? lowerer.mapTypeOf(target)
    : contextual
      ? lowerer.mapTypeOf(lowerer.typeOf(contextual))
      : null;
  if (mapped && typeEquals(mapped, funcType)) return;
  // An 'any' slot (`C.prototype.m = function (a, b) {…}` through an
  // untyped receiver), or a slot whose type maps to a checked-dynamic
  // value (a member of a literal lowered with a generic function's type
  // parameters erased), boxes the value into a checked-dynamic function:
  // the box completes omitted arguments with undefined and checks every
  // argument into the completed ABI, so any boxable signature passes.
  if (
    target !== undefined &&
    ((target.flags & ts.TypeFlags.Any) !== 0 || mapped?.kind === "dyn") &&
    canBoxFuncIntoDyn(
      funcType,
      (id) => lowerer.shapes.get(id),
      (id) => lowerer.unions.get(id),
    )
  ) {
    return;
  }
  // An object-literal METHOD has no contextual type of its own: the
  // literal's contextual type names the member slot it fills. An
  // overloaded member's slot holds its erased function, which spells the
  // completed parameters of an implementation like `m(a?: string)`.
  if (
    contextual === null &&
    ts.isMethodDeclaration(blame) &&
    blame.parent !== undefined &&
    ts.isObjectLiteralExpression(blame.parent) &&
    (ts.isIdentifier(blame.name) || ts.isStringLiteral(blame.name))
  ) {
    const literalType = lowerer.checker.getContextualType(blame.parent);
    const member = literalType
      ? lowerer.checker.getPropertyOfType(literalType, blame.name.text)
      : undefined;
    const slot = member ? lowerer.memberSlotTypeOf(lowerer.checker.getTypeOfSymbol(member)) : null;
    if (slot && typeEquals(slot, funcType)) return;
  }
  // A union-typed slot (`runner || defaultRunner` under a
  // `CommandRunner | undefined` context): the value can only inhabit
  // the union's one func arm — judge by it.
  let mappedFn: IrType | null =
    mapped?.kind === "union"
      ? (() => {
          const arms =
            lowerer.unions.get(mapped.unionId)?.arms.filter((a) => a.kind === "func") ?? [];
          return arms.length === 1 ? arms[0]! : null;
        })()
      : mapped;
  // A contextual type that maps to something non-functional (`picked ||
  // defaultRunner` — tsc's contextual answer for the rhs is not the
  // slot): judge by the expression's OWN completed type; the slot's
  // coercion still enforces (or adapts) the flow it lands in.
  if (mappedFn?.kind !== "func" && contextual) {
    const ownType = lowerer.typeOf(contextual);
    mappedFn =
      lowerer.mapTypeOf(ownType) ??
      (isJsSourceFile(ts.getSourceFileOfNode(contextual))
        ? dynFallbackType(lowerer, contextual, ownType)
        : null);
  }
  if (mappedFn && typeEquals(mappedFn, funcType)) return;
  // A target signature that agrees on the completed parameters and
  // differs only by RETURNING the structural spawnSync-result record
  // (the CommandRunner shape): the slot coercion bridges with the
  // interned runner-value adapter, so the value passes here.
  if (
    mappedFn?.kind === "func" &&
    funcType.kind === "func" &&
    lowerer.spawnResFnAdapterPlan(funcType, mappedFn) !== null
  ) {
    return;
  }
  // A typed-rest function in a slot with fixed parameters (`log(...m:
  // string[])` into `(m: string) => void`): the slot coercion's packing
  // adapter collects the slot's arguments into the rest array.
  if (
    mappedFn?.kind === "func" &&
    funcType.kind === "func" &&
    restPackingAdapterFits(lowerer, funcType, mappedFn)
  ) {
    return;
  }
  // An uncontextualized npm-static implementation function can still
  // have a declaration-backed completed ABI: the package's .d.ts
  // projection supplies the body-facing parameter/return types while
  // the shipped JavaScript's own inferred type remains wider (`any`
  // callback fields are the common case). lambdaSignature has already
  // constructed and validated that concrete ABI, and every eventual
  // storage/call site independently checks it. Admit the value at birth;
  // do not make the unprojected JS inference veto its authored surface.
  if (
    target === undefined &&
    contextual !== null &&
    (ts.isArrowFunction(contextual) || ts.isFunctionExpression(contextual)) &&
    npmStaticPackageOfPath(ts.getSourceFileOfNode(contextual).fileName) !== null
  ) {
    return;
  }

  lowerer.unsupported(
    "SC1090",
    blame,
    "functions with optional or defaulted parameters as values, except where the " +
      "target type spells the completed signature with required parameters " +
      "(a '(x?: T) => R' function flows into a '(x: T | undefined) => R' slot, " +
      "and a package/'any' slot takes any natively representable signature; " +
      "otherwise call the function directly)",
  );
}

export function collectSignature(lowerer: Lowerer, decl: ts.FunctionDeclaration): void {
  lowerer.collectDeferring(
    () => declSymbolOf(lowerer, decl),
    () => lowerer.collectSignatureInner(decl),
  );
}

export function collectSignatureInner(lowerer: Lowerer, decl: ts.FunctionDeclaration): void {
  // The one legal nameless declaration form is `export default function
  // () {}` — its symbol is the module's default export (declSymbolOf)
  // and it registers under the synthetic "%default" spelling.
  if (!decl.name && declSymbolOf(lowerer, decl) === undefined) {
    lowerer.unsupported("SC1090", decl, "anonymous function declarations");
  }
  // A body-less declaration is type-world and lowers to NOTHING: an
  // OVERLOAD SIGNATURE when an implementation shares the symbol (the
  // implementation's own collection registers the one real ABI — tsc
  // resolved every call site against the signatures, and the
  // implementation's parameter types are supersets by the
  // overload-compatibility rules, so calls flow through that ABI), or an
  // AMBIENT `declare function` nothing defines (references compile to
  // Node's ReferenceError at the use site — the `declare const` /
  // ambient-namespace undefRead stance, ambientUndefinedFnSymbolOf).
  if (!decl.body) return;
  // A MIXIN function (`function M(Base: T) { return class extends Base
  // {…} }`) has no callable signature of its own — its return type is a
  // per-call class, so calls instantiate per site (lower-mixins.ts) and
  // nothing ever dispatches through an ABI. Recognized here so the
  // declaration neither registers a broken signature nor lowers as a
  // body (run()/discover() skip by the same test). Generic mixins still
  // register their generic signature below: non-mixin-shaped calls
  // degrade to the generic machinery's own per-site fences.
  if (!decl.typeParameters?.nodes && mixinFnShapeOf(lowerer, decl)) return;
  const isAsync = decl.modifiers?.nodes.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) === true;
  const isGenerator = decl.asteriskToken !== undefined;
  if (decl.typeParameters?.nodes) {
    // Generic async composes: each monomorphized instance is an async
    // IrFunction like any other — its own spawn wrapper, its body
    // returning the resolved promise's inner (lowerGenericInstance).
    lowerer.collectGenericSignature(decl);
    return;
  }
  // IMPLICIT-ANY monomorphization (npm-static JS): a function whose
  // signature carries bindable untyped params registers like a generic
  // declaration — no ABI of its own, one instance per call-site type
  // tuple (generic-functions.ts). Everything that
  // routes generic declarations (direct calls, namespace/CJS member
  // calls, value references) resolves it through genericFnsBySymbol
  // unchanged.
  if (implicitMonoFile(ts.getSourceFileOfNode(decl)) && !isAsync && !isGenerator) {
    const implicit = implicitAnyParamSymbolsOf(lowerer, decl);
    if (implicit) {
      const nameText = decl.name?.text ?? "%default";
      const symbol = declSymbolOf(lowerer, decl);
      if (!symbol) lowerer.unsupported("SC1090", decl, "this function form");
      lowerer.genericFnsBySymbol.set(symbol, {
        decl,
        baseName: nameText,
        qualifiedName: lowerer.qualify(
          ts.getSourceFileOfNode(decl),
          nsPathPrefix(lowerer, decl) + nameText,
        ),
        typeParams: [],
        instances: new Map(),
        implicitParams: implicit,
      });
      return;
    }
  }

  const params = lowerer.paramShapes(decl.parameters.nodes);
  // The zero-parameter declaration retains its dynRest ABI; value
  // functions use the full arguments slot even with no named parameters.
  appendArgumentsParameter(
    lowerer,
    decl,
    params,
    decl.parameters.nodes.length > 0 ? "arguments" : "dynRest",
  );
  const nameBlame: ts.Node = decl.name ?? decl;
  let returnType = lowerer.declaredReturnType(decl, nameBlame);
  // A JavaScript generator whose inferred return the checker leaves `any`
  // (it delegates to itself: `yield* walkTree(sub)`) is still a generator:
  // its channels are checked-dynamic values.
  if (isGenerator && returnType.kind === "dyn" && isJsSourceFile(ts.getSourceFileOfNode(decl))) {
    returnType = {
      kind: "generator",
      ...(isAsync ? { async: true as const } : {}),
      yieldT: DYN,
      retT: DYN,
      nextT: DYN,
    };
  }
  if (isAsync && !isGenerator && returnType.kind !== "promise") {
    lowerer.badType(nameBlame, lowerer.typeOf(nameBlame));
  }
  if (isGenerator && (returnType.kind !== "generator" || (returnType.async === true) !== isAsync)) {
    lowerer.badType(nameBlame, lowerer.typeOf(nameBlame));
  }

  if (!isAsync && !isGenerator) returnType = layoutReturnType(lowerer, decl, returnType);
  const symbol = declSymbolOf(lowerer, decl);
  if (!symbol) lowerer.unsupported("SC1090", decl, "this function form");
  lowerer.fnSigsBySymbol.set(symbol, {
    // Namespace-nested functions carry the namespace path (nsPathPrefix)
    // so `namespace A { export function f }` and a top-level `f` never
    // collide. The anonymous default export takes the synthetic
    // "%default" spelling ('%' cannot appear in a user identifier).
    name: lowerer.qualify(
      ts.getSourceFileOfNode(decl),
      nsPathPrefix(lowerer, decl) + (decl.name?.text ?? "%default"),
    ),
    params,
    returnType,
    isAsync,
    ...(isGenerator && returnType.kind === "generator"
      ? { generator: generatorMeta(lowerer, returnType) }
      : {}),
  });
}

/** Arrows inherit arguments. Ordinary JS functions receive a hidden
 * array unless a declared rest parameter already owns that contract.
 * Class methods are strict; other parameterized forms require ES modules
 * because sloppy-mode arguments alias named parameters, unless the body
 * cannot observe that aliasing (argumentsAliasingUnobservable). */
function appendArgumentsParameter(
  lowerer: Lowerer,
  node: ts.SignatureDeclaration,
  shapes: ParamShape[],
  mode: "arguments" | "dynRest",
): void {
  if (
    shapes.some((s) => s.mode === "rest" || s.mode === "dynRest") ||
    !(
      ts.isFunctionExpression(node) ||
      ts.isFunctionDeclaration(node) ||
      ts.isMethodDeclaration(node)
    ) ||
    !isJsSourceFile(ts.getSourceFileOfNode(node)) ||
    !bodyReadsArguments(node)
  )
    return;
  if (node.parameters.nodes.length > 0 || ts.isMethodDeclaration(node)) {
    const classMethod =
      ts.isMethodDeclaration(node) &&
      (ts.isClassDeclaration(node.parent) || ts.isClassExpression(node.parent));
    if (
      !classMethod &&
      !isNodeEsmFile(ts.getSourceFileOfNode(node), lowerer.program) &&
      !unmappedArguments(node) &&
      !argumentsAliasingUnobservable(node)
    ) {
      lowerer.unsupported(
        "SC1090",
        node,
        "parameterized 'arguments' outside an ES module (sloppy-mode parameter aliases)",
        undefined,
        "sloppy-arguments",
      );
    }
  }
  shapes.push({ type: DYN, mode });
}

/** Whether `arguments` inside `node` is Node's unmapped object: strict code
 * (a 'use strict' prologue on the file or an enclosing function, or a class
 * body) or a non-simple parameter list (defaults, rest, destructuring). Its
 * elements then never alias the parameters, which is the ES module case. */
function unmappedArguments(node: ts.SignatureDeclaration): boolean {
  if (
    node.parameters.nodes.some(
      (p) =>
        p.initializer !== undefined || p.dotDotDotToken !== undefined || !ts.isIdentifier(p.name),
    )
  )
    return true;
  const useStrict = (statements: readonly ts.Statement[]): boolean => {
    for (const statement of statements) {
      if (!ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression))
        return false;
      if (statement.expression.text === "use strict") return true;
    }
    return false;
  };
  for (let n: ts.Node | undefined = node; n; n = n.parent) {
    if (ts.isClassDeclaration(n) || ts.isClassExpression(n)) return true;
    if (ts.isFunctionLike(n) && n.body && ts.isBlock(n.body) && useStrict(n.body.statements.nodes))
      return true;
    if (ts.isSourceFile(n)) return useStrict(n.statements.nodes);
  }
  return false;
}

/** Signature checks + param shapes + IR func type for any lambda-like
 * node. The func type's params are the ABI types: optional/default params
 * become `T | undefined`, and typed rest becomes one packed-array slot.
 * requireExactArityValue decides whether that completed ABI may escape. */
export function lambdaSignature(
  lowerer: Lowerer,
  node:
    | ts.ArrowFunction
    | ts.FunctionExpression
    | ts.FunctionDeclaration
    | ts.MethodDeclaration
    | ts.GetAccessorDeclaration
    | ts.SetAccessorDeclaration,
): { shapes: ParamShape[]; funcType: IrType & { kind: "func" } } {
  if (!node.body) lowerer.unsupported("SC1090", node, "function overload signatures");
  // A parameterless function expression forwarding its `arguments`,
  // asserted to a fixed signature: that signature is its ABI.
  if (typedArgumentsCandidate(node) && !node.typeParameters?.nodes.length) {
    const target = typedArgumentsTarget(lowerer, node);
    if (target) {
      const shapes = typedArgumentsShapes(target);
      lowerer.typedArgumentsLambdas.add(node);
      return { shapes, funcType: funcTypeFromParamShapes(shapes, target.ret) };
    }
  }
  // A JS replacement of a native stream's write method receives the
  // actual call tuple, including overloads and omitted arguments. Node's
  // contextual overload signature cannot define this closure's ABI.
  if (
    isJsSourceFile(ts.getSourceFileOfNode(node)) &&
    !node.type &&
    (ts.isFunctionExpression(node) || ts.isArrowFunction(node)) &&
    node.parameters.nodes.every(
      (param) => !param.type && !param.dotDotDotToken && !param.initializer,
    ) &&
    ts.isBinaryExpression(node.parent) &&
    node.parent.right === node &&
    node.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    ts.isPropertyAccessExpression(node.parent.left) &&
    node.parent.left.name.text === "write" &&
    lowerer.isStdlibMember(node.parent.left)
  ) {
    const receiver = lowerer.lowerExpr(node.parent.left.expression);
    if (receiver.type.kind === "dyn") {
      const shapes: ParamShape[] = node.parameters.nodes.map(() => ({
        type: DYN,
        mode: "required",
      }));
      return { shapes, funcType: funcTypeFromParamShapes(shapes, DYN) };
    }
  }
  // A callback whose arguments arrive as the runtime produced them, wider
  // than its contextual overload says (dns.lookup's callback when the
  // options are only known at run time: the address is a string or an
  // address list): every parameter binds as a checked-dynamic value.
  // Rest parameters keep their packing and optional or defaulted ones stay
  // omittable (the prologue applies a default to an undefined argument).
  // The slot discards the result, so a sync callback returns void and an
  // async one keeps its promise.
  if (lowerer.dynParamLambdas.has(node)) {
    const shapes: ParamShape[] = node.parameters.nodes
      .filter((param) => !isThisParameter(param))
      .map((param) =>
        param.dotDotDotToken
          ? { type: DYN, mode: "dynRest" }
          : param.initializer
            ? { type: DYN, mode: "omittable", bodyType: DYN }
            : { type: DYN, mode: param.questionToken ? "omittable" : "required" },
      );
    const isAsync = node.modifiers?.nodes.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword);
    const ret = isAsync ? lowerer.declaredReturnType(node, node) : VOID;
    return { shapes, funcType: funcTypeFromParamShapes(shapes, ret) };
  }
  if (node.typeParameters?.nodes && !lowerer.erasingLambdas.has(node)) {
    // Generic function-like forms monomorphize only where a static home
    // exists: top-level generic function declarations, generic methods
    // (class and object-literal), and module-scope never-reassigned
    // bindings initialized with a generic arrow/function expression —
    // all collected before this path. Everything else lambda-shaped
    // (arguments, IIFEs, default exports, nested declarations) has no
    // per-instantiation story and stays out.
    lowerer.unsupported(
      "SC1090",
      node,
      ts.isMethodDeclaration(node)
        ? "generic methods"
        : ts.isFunctionDeclaration(node)
          ? "generic nested functions (only top-level generic function declarations are supported)"
          : "generic arrow/function expressions outside a never-reassigned module-scope binding (only `const f = <T>(x: T) => ...` bindings and top-level generic function declarations monomorphize)",
    );
  }
  const shapes = lowerer.paramShapes(node.parameters.nodes);
  // Error-first callbacks captured by native filesystem adapters receive
  // the selected runtime overload. Ambient contextual inference can pick
  // the string overload even when options request a Buffer.
  if (
    (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
    ts.isCallExpression(node.parent) &&
    node.parent.arguments.nodes.at(-1) === node
  ) {
    const builtin = ts.isPropertyAccessExpression(node.parent.expression)
      ? lowerer.builtinMemberOf(node.parent.expression)
      : ts.isIdentifier(node.parent.expression)
        ? lowerer.builtinImportOf(node.parent.expression)
        : null;
    if (
      builtin?.module === "fs" &&
      builtin.member !== "rename" &&
      builtinModuleFnOf(lowerer, builtin.module, builtin.member)?.fn === "fs.callbackCall"
    ) {
      for (let index = 0; index < shapes.length; index++) {
        if (!node.parameters.nodes[index]?.type) {
          shapes[index]!.type = DYN;
          if (shapes[index]!.bodyType) shapes[index]!.bodyType = DYN;
        }
      }
    }
  }
  // A concise arrow over an h2-only stream/session call (`() =>
  // req.stream.destroy()`): the call ALWAYS throws on this lowering
  // (stream is undefined — the streamUndefCall precedent), so the body
  // is throw-only and the declared return type (ServerHttp2Stream,
  // unmappable) must not decide the ABI — void, the `never` stance.
  let ret =
    ts.isArrowFunction(node) && !ts.isBlock(node.body) && isStreamUndefCallExpr(lowerer, node.body)
      ? VOID
      : lowerer.declaredReturnType(node, node);
  ret = lowerer.runtimeOptionalFunctionReturnType(node, ret);
  // A contextually-typed arrow/function EXPRESSION whose slot signature
  // returns a composite type the inferred return doesn't spell adopts
  // the slot's return as its ABI: `(n) => work()` (inferring Promise<void>) against
  // an `(n) => Promise<void> | void` field must RETURN that union — the
  // body's returns coerce into it per return site (arm values wrap;
  // width-coercible records rebuild into their arm — the runJobs
  // `{ data, id }` literal against `Buffer | string | GeneratedOutput`),
  // a void body's implicit completion becomes the undefined arm, and the
  // closure VALUE matches the slot exactly (no runtime re-tag exists for
  // func returns). tsc vetted the assignability — a return the coercion
  // path can't carry fences per site with its own actionable message.
  // ASYNC lambdas adopt through the promise: an inferred Promise<record>
  // against a Promise<union> slot returns the union promise (the fiber's
  // returns coerce; the spawn-wrapper ABI still returns a promise).

  // Array and record returns also need the destination during literal
  // construction: a callback building IrStmt[] must wrap each element at
  // that recursive layout instead of first inferring narrower arrays.
  const isAsyncLike =
    !ts.isMethodDeclaration(node) &&
    node.modifiers?.nodes.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) === true;
  const innerRet = isAsyncLike && ret.kind === "promise" ? ret.inner : ret;
  // Union-inferred returns adopt too (a mixed-return body inferring a
  // SUB-union of the slot's union — adopting is a no-op when the two

  // A synchronous object-literal method adopts its slot's return the same
  // way: its slot is the property of that name on the literal's
  // contextual type. A literal under `satisfies` keeps its own type (the
  // constraint is only checked), so its methods keep their inferred
  // returns: callers of the value see those, not the constraint's.
  const literalMethod =
    ts.isMethodDeclaration(node) &&
    ts.isObjectLiteralExpression(node.parent) &&
    !node.asteriskToken &&
    node.modifiers?.nodes.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) !== true &&
    !isSatisfiesOperand(node.parent);
  if (
    ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
      (!isAsyncLike || ret.kind === "promise")) ||
    literalMethod
  ) {
    // The slot's signature: the contextual type stripped of its nullish
    // parts (an OPTIONAL callback field's context is the whole
    // `(...) | undefined` union) with exactly one call signature — and
    // declared in USER code: stdlib callback slots (flatMap's
    // `U | readonly U[]`, sort comparators) have intrinsic lowerings
    // that inspect the INFERRED type, so they must not widen.
    const ctxType =
      literalMethod && ts.isMethodDeclaration(node) && node.parent
        ? objectLiteralMethodSlot(lowerer, node, node.parent)
        : lowerer.checker.getContextualType(node);
    const ctxSigs = ctxType
      ? lowerer.checker.getCallSignatures(lowerer.checker.getNonNullableType(ctxType))
      : [];
    const ctxDecl = ctxSigs.length === 1 ? ctxSigs[0]!.declaration : undefined;
    const ctxRetRaw =
      ctxDecl && !ts.getSourceFileOfNode(ctxDecl).isDeclarationFile
        ? lowerer.mapTypeOf(lowerer.checker.getReturnTypeOfSignature(ctxSigs[0]!))
        : null;
    // An async lambda always produces a promise, so a slot returning a
    // promise-armed union (`Promise<R | void> | R | void`, `Promise<void>
    // | void`) is met through that promise arm: its payload is the ABI.
    const ctxPromiseArm =
      isAsyncLike && ctxRetRaw?.kind === "union"
        ? lowerer.unions.get(ctxRetRaw.unionId)?.arms.filter((arm) => arm.kind === "promise")
        : undefined;
    const ctxRet =
      isAsyncLike && ctxRetRaw?.kind === "promise"
        ? ctxRetRaw.inner
        : ctxPromiseArm?.length === 1 && ctxPromiseArm[0]!.kind === "promise"
          ? ctxPromiseArm[0]!.inner
          : ctxRetRaw;
    // A TypeScript variadic lambda (`(...args) => handler(...args)`) in a
    // checked-dynamic variadic slot returning `unknown` adopts that result
    // too: rest closures have no function-value adapter, so the closure
    // must match the slot's ABI exactly.
    const dynVariadicSlot =
      ctxRet?.kind === "dyn" &&
      !isJsSourceFile(ts.getSourceFileOfNode(node)) &&
      shapes.some((shape) => shape.mode === "dynRest");
    if (
      dynVariadicSlot ||
      ((ctxRet?.kind === "union" || ctxRet?.kind === "array" || ctxRet?.kind === "record") &&
        (innerRet.kind !== "void" ||
          (ctxRet.kind === "union" && lowerer.armTag(ctxRet.unionId, UNDEFINED_T) >= 0)))
    ) {
      ret = isAsyncLike ? { kind: "promise", inner: ctxRet! } : ctxRet!;
    }
    // A VOID slot discards the callback's result (TS's void-returning
    // assignability rule; JS ignores the value), so an UNANNOTATED
    // sync lambda adopts void regardless of what its body infers —
    // `() => socket.destroy()` infers Socket (destroy returns `this`
    // for chaining) but the error-listener slot never looks. Stdlib
    // slots included: no intrinsic lowering inspects an inferred
    // return where its own declared slot is void. Async lambdas stay
    // out (the spawn-wrapper ABI must still return a promise), and an
    // explicit return annotation keeps its word. So does the property
    // value of an object literal whose contextual type maps to a
    // checked-dynamic slot or to no lowered type (such as an EventTarget
    // listener union): that literal's record is typed by its own inferred
    // properties, so the field keeps the inferred return and can be read
    // back and called (`{ handleEvent: (e) => count++ }` passed as a
    // listener still returns the count from `.handleEvent(e)`). A literal
    // lowered against a declared record type takes that type's void field.
    const literal =
      ts.isPropertyAssignment(node.parent) &&
      node.parent.initializer === node &&
      ts.isObjectLiteralExpression(node.parent.parent)
        ? node.parent.parent
        : null;
    const literalSlot = literal ? lowerer.checker.getContextualType(literal) : undefined;
    const literalType =
      literalSlot !== undefined
        ? lowerer.mapTypeOf(lowerer.checker.getNonNullableType(literalSlot))
        : null;
    const inferredLiteral =
      literalSlot !== undefined && (literalType === null || literalType.kind === "dyn");
    if (
      !literalMethod &&
      !isAsyncLike &&
      !node.type &&
      !inferredLiteral &&
      ret.kind !== "void" &&
      ctxSigs.length === 1 &&
      !!(lowerer.checker.getReturnTypeOfSignature(ctxSigs[0]!).flags & ts.TypeFlags.Void)
    ) {
      ret = VOID;
    }
  }
  ret = lowerer.contextualFunctionReturns.get(node) ?? ret;
  appendArgumentsParameter(lowerer, node, shapes, "arguments");
  const funcType = funcTypeFromParamShapes(shapes, ret);
  return { shapes, funcType };
}

/** Whether the object literal `literal` is the operand of a `satisfies`
 * expression, directly or as a property value of literals that are. */
function isSatisfiesOperand(literal: ts.Node): boolean {
  let n: ts.Node | undefined = literal;
  while (n !== undefined) {
    const parent: ts.Node | undefined = n.parent;
    if (parent === undefined) return false;
    if (ts.isParenthesizedExpression(parent)) n = parent;
    else if (ts.isPropertyAssignment(parent) && parent.initializer === n) n = parent.parent;
    else return ts.isSatisfiesExpression(parent) && parent.expression === n;
  }
  return false;
}

/** The type of the property an object-literal method fills on the
 * literal's contextual type; undefined when the literal has no contextual
 * type or the method has a computed name. */
function objectLiteralMethodSlot(
  lowerer: Lowerer,
  node: ts.MethodDeclaration,
  literal: ts.Node,
): ts.Type | undefined {
  if (!ts.isIdentifier(node.name) && !ts.isStringLiteral(node.name)) return undefined;
  const literalType = lowerer.checker.getContextualType(literal);
  if (!literalType) return undefined;
  const property = lowerer.checker.getPropertyOfType(
    lowerer.checker.getNonNullableType(literalType),
    node.name.text,
  );
  return property ? lowerer.checker.getTypeOfSymbol(property) : undefined;
}
