import * as ts from "../ts7/adapter.js";
import type { IrType } from "../../ir/ir.js";
import { typeEquals, UNDEFINED_T } from "../../ir/ir.js";
import type { FnSig, ParamShape } from "./call-signatures.js";
import { funcTypeFromParamShapes, isThisParameter } from "./call-signatures.js";
import { findMethodOn } from "./lower-classes.js";
import {
  internImplicitInstanceOr,
  paramWrittenInBody,
  type GenericFnInfo,
  type GenericInstance,
} from "./generic-functions.js";
import { parameterIdentityUse } from "./divergences.js";
import { nsPathPrefix } from "./lower-namespaces.js";
import type { Lowerer } from "./lowerer.js";
import { PoisonError } from "./lowerer.js";
import { locOf } from "../program.js";
import { keptLayoutStoreCopyDiag, widthCopyRefusalDiag } from "../../diagnostics/diagnostic.js";
import { observesIdentity } from "./observable-write.js";

/** Instances of a typed function for arguments that keep their own layout.
 *
 * A record or array whose layout differs from a parameter's declared
 * structural type converts by copying it (`{ id; name; owned?: true }[]`
 * into `{ id; name }[]`). JavaScript passes the same object, so the
 * callee's writes (`push`, index stores, element-field writes) and identity
 * comparisons see the caller's value. When an argument names an existing
 * value, the call instead targets an instance of the function lowered with
 * that parameter bound to the argument's own type: the body reads and
 * writes the caller's storage. Instances are keyed by the parameter
 * layouts, so each layout combination compiles once.
 *
 * A record parameter the callee writes through or compares by identity also
 * binds a record whose other fields are required, or an index-signature
 * record, and so the arm a union argument is narrowed to at the call
 * (`fill(last, detail)` after `last.kind === "note"`). No conversion between
 * those layouts keeps the caller's object, so the copy would lose the writes
 * and answer `===` false. */

/** The argument expressions that can name a value another reference sees:
 * bindings, member reads and `this`. Fresh values (literals, calls) have no
 * other reference, so their copy is not observable. */
export function namesExistingValue(arg: ts.Expression): boolean {
  let e = arg;
  for (;;) {
    if (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e)) e = e.expression;
    else if (ts.isAsExpression(e) || ts.isSatisfiesExpression(e)) e = e.expression;
    else break;
  }
  return (
    ts.isIdentifier(e) ||
    ts.isPropertyAccessExpression(e) ||
    ts.isElementAccessExpression(e) ||
    e.kind === ts.SyntaxKind.ThisKeyword
  );
}

/** Whether a value of layout `from` can stand for a value of layout `to`
 * in code written against `to`: the same layout, or a record that has every
 * field of `to` at such a layout plus fields `to` lacks that are optional
 * (`{ id; name; owned?: true }` for `{ id; name }`), or an array of such
 * elements. Every value that code stores converts into `from` by completing
 * the optional fields as absent, so reads and writes through either type see
 * one value. */
function standsFor(
  lowerer: Lowerer,
  from: IrType,
  to: IrType,
  assumed: Set<string> = new Set(),
): boolean {
  if (typeEquals(from, to)) return true;
  if (from.kind === "array" && to.kind === "array")
    return standsFor(lowerer, from.elem, to.elem, assumed);
  if (from.kind !== "record" || to.kind !== "record") return false;
  // Recursive layouts (`{ kids: Tree[] }` against `{ kids: Plain[] }`) meet
  // the same pair again inside their fields; the pair holds there if it
  // holds for the other fields.
  const pair = `${from.shapeId}>${to.shapeId}`;
  if (assumed.has(pair)) return true;
  assumed.add(pair);
  const source = lowerer.shapes.get(from.shapeId);
  const target = lowerer.shapes.get(to.shapeId);
  if (!source || !target || source.tuple || target.tuple) return false;
  if (source.indexValue || target.indexValue) return false;
  for (const field of target.fields) {
    const kept = source.fields.find((f) => f.name === field.name);
    if (!kept || !standsFor(lowerer, kept.type, field.type, assumed)) return false;
  }
  return source.fields.every(
    (field) =>
      target.fields.some((f) => f.name === field.name) ||
      (field.type.kind === "union" && lowerer.armTag(field.type.unionId, UNDEFINED_T) >= 0),
  );
}

/** Whether converting `from` into `to` copies a value that could keep its
 * own layout instead. */
function copies(lowerer: Lowerer, from: IrType, to: IrType): boolean {
  if (typeEquals(from, to)) return false;
  if (from.kind === "procStream") return procStreamStandsFor(lowerer, to);
  if (!standsFor(lowerer, from, to)) return false;
  const plan = lowerer.widthLiftPlan(from, to);
  return plan !== null && (plan.how === "arr" || plan.how === "width");
}

/** Whether `from` and `to` are record layouts that differ only in field
 * representation: every field of `to` names a field of `from`, and every
 * field `from` has besides those is optional. No field is added or dropped,
 * so the two layouts could be served by one storage; a conversion between
 * them copies the value instead (recordWidthPlan). */
export function sameFieldsForCopy(lowerer: Lowerer, from: IrType, to: IrType): boolean {
  if (from.kind !== "record" || to.kind !== "record") return false;
  const source = lowerer.shapes.get(from.shapeId);
  const target = lowerer.shapes.get(to.shapeId);
  if (!source || !target || source.tuple || target.tuple) return false;
  if (source.indexValue || target.indexValue) return false;
  if (target.fields.some((field) => !source.fields.some((kept) => kept.name === field.name)))
    return false;
  return source.fields.every(
    (field) =>
      target.fields.some((kept) => kept.name === field.name) ||
      (field.type.kind === "union" && lowerer.armTag(field.type.unionId, UNDEFINED_T) >= 0),
  );
}

/** Whether a record of layout `from` can be the value of a parameter of
 * record layout `to` in a body that never assigns the parameter: it has
 * every field of `to` at a layout that stands for it, and both keep
 * undeclared keys the same way (neither has an index signature, or both
 * have one of the same value type). Its other fields may be required. The
 * body is written against `to`, so it never names them, and no value converts
 * into the parameter's layout, so none needs them completed. A read or write
 * by a runtime key lowers against `from` and follows its rules: the body
 * does not lower where a key could meet a field of another type. */
function carries(lowerer: Lowerer, from: IrType, to: IrType): boolean {
  if (from.kind !== "record" || to.kind !== "record" || typeEquals(from, to)) return false;
  const source = lowerer.shapes.get(from.shapeId);
  const target = lowerer.shapes.get(to.shapeId);
  if (!source || !target || source.tuple || target.tuple) return false;
  const sourceValue = source.indexValue;
  const targetValue = target.indexValue;
  if (sourceValue === undefined || targetValue === undefined) {
    if (sourceValue !== undefined || targetValue !== undefined) return false;
  } else if (!typeEquals(sourceValue, targetValue)) return false;
  return target.fields.every((field) => {
    const kept = source.fields.find((f) => f.name === field.name);
    return (
      kept !== undefined &&
      kept.optional === field.optional &&
      standsFor(lowerer, kept.type, field.type)
    );
  });
}

/** Whether the body of `decl` writes through its parameter at `index` or
 * compares it by identity, the uses a copy of the argument changes
 * (divergences.ts reports the same uses as SC6001). Scanned once per
 * declaration. */
function usesParameterIdentity(info: GenericFnInfo, index: number): boolean {
  const uses = (info.identityParams ??= info.decl.parameters.nodes.map((param) =>
    ts.isIdentifier(param.name) ? parameterIdentityUse(info.decl, param.name.text) : false,
  ));
  return uses[index] === true;
}

/** The structural-instance info of a typed function declaration, created on
 * first use and kept on the Lowerer. */
function structuralInfoOf(
  lowerer: Lowerer,
  decl: ts.FunctionDeclaration,
  symbol: ts.Symbol,
): GenericFnInfo {
  const existing = lowerer.structuralFnInfos.get(symbol);
  if (existing) return existing;
  const nameText = decl.name?.text ?? "%default";
  const body = decl.body!;
  const info: GenericFnInfo = {
    decl,
    baseName: nameText,
    qualifiedName: lowerer.qualify(
      ts.getSourceFileOfNode(decl),
      nsPathPrefix(lowerer, decl) + nameText + "%layout",
    ),
    typeParams: [],
    instances: new Map(),
    implicitParams: decl.parameters.nodes.map((param) => {
      if (!ts.isIdentifier(param.name) || param.dotDotDotToken || param.initializer) return null;
      if (param.questionToken) return null;
      const sym = lowerer.checker.getSymbolAtLocation(param.name);
      if (!sym || paramWrittenInBody(lowerer, body, sym, param.name.text)) return null;
      return sym;
    }),
  };
  lowerer.structuralFnInfos.set(symbol, info);
  return info;
}

/** The instance a direct call of the declared function `sig` targets when
 * one of its arguments names a record or array whose layout the parameter
 * would copy; null when every argument converts as declared. */
export function structuralCallInstance(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  sig: FnSig,
): GenericInstance | null {
  const symbol = lowerer.resolveValueSymbol(expr.expression as ts.Identifier);
  const decl = symbol?.valueDeclaration;
  if (!symbol || !decl || !ts.isFunctionDeclaration(decl) || !decl.body) return null;
  if (
    decl.asteriskToken ||
    decl.modifiers?.nodes.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)
  )
    return null;
  if (decl.parameters.nodes.some(isThisParameter)) return null;
  if (symbol.declarations.filter((d) => ts.isFunctionDeclaration(d)).length !== 1) return null;
  const args = expr.arguments.nodes;
  if (args.some((a) => ts.isSpreadElement(a))) return null;
  const params = decl.parameters.nodes;
  if (sig.params.length !== params.length) return null;
  const bound: { index: number; type: IrType; checker: ts.Type }[] = [];
  params.forEach((_, index) => {
    const arg = args[index];
    const declared = sig.params[index]!;
    if (!arg || declared.mode !== "required" || !namesExistingValue(arg)) return;
    // A signature that widens the declared type's layout (record parameters
    // whose fields also take undefined) keeps its own boundary conversion.
    const own = lowerer.mapTypeOf(lowerer.checker.getTypeAtLocation(params[index]!.name));
    if (!own || !typeEquals(own, declared.type)) return;
    const checker = preservedLayoutOf(lowerer, arg) ?? lowerer.typeOf(arg);
    const type = lowerer.mapTypeOf(checker);
    if (!type) return;
    if (
      copies(lowerer, type, declared.type) ||
      (carries(lowerer, type, declared.type) &&
        usesParameterIdentity(structuralInfoOf(lowerer, decl, symbol), index))
    )
      bound.push({ index, type, checker });
  });
  if (bound.length === 0) return null;
  const info = structuralInfoOf(lowerer, decl, symbol);
  const shapes: ParamShape[] = [...sig.params];
  const argTypes = new Map<ts.Symbol, ts.Type>();
  for (const { index, type, checker } of bound) {
    const sym = info.implicitParams![index];
    if (!sym) continue;
    shapes[index] = { type, mode: "required" };
    argTypes.set(sym, checker);
  }
  if (argTypes.size === 0) return null;
  // A body that returns a bound parameter returns the argument's layout.
  const previous = lowerer.implicitParamTypes;
  lowerer.implicitParamTypes = argTypes;
  let returnType: IrType;
  try {
    returnType = layoutReturnType(lowerer, decl, sig.returnType);
  } finally {
    lowerer.implicitParamTypes = previous;
  }
  const instance = internImplicitInstanceOr(
    lowerer,
    expr,
    info,
    shapes,
    argTypes,
    "",
    returnType,
    true,
  );
  if (instance) for (const { index } of bound) lowerer.layoutKeptNodes.add(args[index]!);
  return instance;
}

/** The layout of the value an existing-value expression names: a binding's
 * own type, or the element or field of such a value read through `[i]` or
 * `.name`. Reads of a parameter bound to an argument's layout follow that
 * layout rather than the parameter's declared type. */
function layoutOf(lowerer: Lowerer, expression: ts.Expression): IrType | null {
  let e = expression;
  while (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e)) e = e.expression;
  if (ts.isElementAccessExpression(e)) {
    const base = layoutOf(lowerer, e.expression);
    if (
      base?.kind === "array" &&
      lowerer.mapTypeOf(lowerer.typeOf(e.argumentExpression))?.kind === "f64"
    )
      return base.elem;
  } else if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.name)) {
    const base = layoutOf(lowerer, e.expression);
    if (base?.kind === "record") {
      const field = lowerer.shapes.get(base.shapeId)?.fields.find((f) => f.name === e.name.text);
      if (field) return field.type;
    }
  }
  return lowerer.mapTypeOf(lowerer.typeOf(e));
}

/** The return type of a declared function whose every `return` names an
 * existing value of one record or array layout that the declared return type
 * would copy (`function items(values: Refined[]): Value[] { return values; }`):
 * that layout, so the caller receives the value itself. `declared` otherwise. */
export function layoutReturnType(
  lowerer: Lowerer,
  decl: ts.FunctionDeclaration,
  declared: IrType,
): IrType {
  if (!decl.body || (declared.kind !== "array" && declared.kind !== "record")) return declared;
  // An exported function keeps its declared result: a library build calls it
  // from outside the program, through the declared ABI.
  if (decl.modifiers?.nodes.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) return declared;
  const returned: ts.Expression[] = [];
  let open = false;
  ts.walkPreorder(decl.body, (node) => {
    if (node !== decl.body && ts.isFunctionLike(node)) return "skip";
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) return "skip";
    if (!ts.isReturnStatement(node)) return undefined;
    if (!node.expression || !namesExistingValue(node.expression)) open = true;
    else returned.push(node.expression);
    return undefined;
  });
  if (open || returned.length === 0) return declared;
  let layout: IrType | null = null;
  for (const expression of returned) {
    const type = layoutOf(lowerer, expression);
    if (!type || !copies(lowerer, type, declared)) return declared;
    if (layout && !typeEquals(layout, type)) return declared;
    layout = type;
  }
  return layout ?? declared;
}

/** The initializer type of a const the argument names when the const kept
 * that initializer's layout (keepsInitializerLayout): the checker types the
 * binding by its annotation, but its value has the initializer's layout. A
 * declaration lowers once per function instance, and only some instances
 * keep a layout, so the recorded type applies only while it maps to the
 * layout of the binding the current lowering resolves. */
export function preservedLayoutOf(lowerer: Lowerer, arg: ts.Expression): ts.Type | undefined {
  let e = arg;
  while (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e)) e = e.expression;
  if (!ts.isIdentifier(e)) return undefined;
  const symbol = lowerer.resolveValueSymbol(e);
  const recorded = symbol ? lowerer.preservedLayoutTypes.get(symbol) : undefined;
  if (recorded === undefined) return undefined;
  const binding = lowerer.peekLocal(e)?.type ?? lowerer.globalOf(e)?.type;
  const layout = lowerer.mapTypeOf(recorded);
  return binding && layout && typeEquals(binding, layout) ? recorded : undefined;
}

/** The type a value really has at run time when it names a binding that kept
 * its initializer's layout, or a member of one: the binding's kept layout,
 * or that member's type in it. Undefined for every other expression. The
 * checker answers `p.list` from `p`'s declaration, which a kept binding
 * stores in a wider layout. */
export function keptLayoutTypeOf(lowerer: Lowerer, arg: ts.Expression): ts.Type | undefined {
  const names: string[] = [];
  let e = arg;
  for (;;) {
    if (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e)) e = e.expression;
    else if (ts.isPropertyAccessExpression(e) && !ts.isPrivateIdentifier(e.name)) {
      names.unshift(e.name.text);
      e = e.expression;
    } else if (ts.isElementAccessExpression(e) && ts.isStringLiteralLike(e.argumentExpression)) {
      names.unshift(e.argumentExpression.text);
      e = e.expression;
    } else break;
  }
  if (!ts.isIdentifier(e)) return undefined;
  let type = preservedLayoutOf(lowerer, e);
  if (type === undefined) return undefined;
  for (const name of names) {
    const property = lowerer.checker.getPropertyOfType(type, name);
    if (property === undefined) return undefined;
    type = lowerer.checker.getTypeOfSymbol(property);
  }
  return type;
}

/** Whether a class instance presents the record type `to` without a copy:
 * every member `to` names is a class field at the same slot type, or a
 * method whose signature its function type adapts to (Node's `Sink` over
 * `process.stdout`: `write` is the stream's method). The binding's storage
 * stays the instance, so reads, calls and writes reach the one object and
 * a method call keeps the instance as its receiver. */
function classStandsFor(lowerer: Lowerer, className: string, to: IrType): boolean {
  if (to.kind !== "record") return false;
  const target = lowerer.shapes.get(to.shapeId);
  const info = lowerer.classes.get(className);
  if (!target || !info || target.tuple || target.indexValue) return false;
  if (target.fields.length === 0) return false;
  if (target.fields.some((field) => field.name.startsWith("%"))) return false;
  for (const tf of target.fields) {
    const field = info.fields.get(tf.name);
    if (field !== undefined) {
      if (!typeEquals(field, tf.type)) return false;
      continue;
    }
    const method = findMethodOn(lowerer, info, tf.name);
    if (!method || method.sig.abstract) return false;
    if (tf.type.kind !== "func") return false;
    const funcType = funcTypeFromParamShapes(method.sig.params, method.sig.ret);
    if (lowerer.widthLiftPlan(funcType, tf.type) === null) return false;
  }
  return true;
}

/** Whether a process-stream value (the file-descriptor scalar behind
 * `process.stdout`) presents the record type `to`: `write` is the stream's
 * own method, so a binding may keep the descriptor and route its calls to
 * the stream the descriptor names. */
function procStreamStandsFor(lowerer: Lowerer, to: IrType): boolean {
  if (to.kind !== "record") return false;
  const target = lowerer.shapes.get(to.shapeId);
  if (!target || target.tuple || target.indexValue || target.fields.length === 0) return false;
  return target.fields.every(
    (tf) =>
      tf.name === "write" &&
      tf.type.kind === "func" &&
      tf.type.params.length === 1 &&
      tf.type.params[0]?.kind === "string" &&
      (tf.type.ret.kind === "void" || tf.type.ret.kind === "bool"),
  );
}

/** Whether a `const` binding typed `declared` keeps the record or array
 * layout `actual` of an initializer that names an existing value or returns
 * one, instead of converting it by a copy. Fresh literals convert as
 * declared: their copy is not observable. A class instance whose members
 * answer the declared record keeps the instance. */
export function keepsInitializerLayout(
  lowerer: Lowerer,
  initializer: ts.Expression,
  actual: IrType,
  declared: IrType,
): boolean {
  let e = initializer;
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  if (!namesExistingValue(e) && !ts.isCallExpression(e)) return false;
  if (lowerer.isRuntimeOptionalRecordVariant(actual, declared)) return false;
  if (actual.kind === "object" && declared.kind === "record")
    return classStandsFor(lowerer, actual.className, declared);
  return copies(lowerer, actual, declared);
}

/** Whether a binding typed `declared` keeps the checked-dynamic
 * value its assertion of an existing value lowered to, instead of converting
 * it. An index-signature type keeps the keys it does not declare in an
 * overflow map, and a conversion builds one of its own: a copy would take
 * every write through the binding with it, so the binding would not be the
 * object the assertion names. */
export function keepsCheckedDynamicValue(
  lowerer: Lowerer,
  initializer: ts.Expression | undefined,
  actual: IrType,
  declared: IrType | null,
): boolean {
  if (initializer === undefined) return false;
  if (actual.kind !== "dyn" || declared?.kind !== "record") return false;
  if (lowerer.shapes.get(declared.shapeId)?.indexValue === undefined) return false;
  let e = initializer;
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  if (!ts.isAsExpression(e) && !ts.isTypeAssertion(e) && !ts.isSatisfiesExpression(e)) return false;
  e = e.expression;
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  return namesExistingValue(e) || ts.isCallExpression(e);
}

/** Records that the const `decl` keeps its initializer's layout, so calls
 * that pass it bind the initializer's type (preservedLayoutOf). */
export function notePreservedLayout(lowerer: Lowerer, decl: ts.VariableDeclaration): void {
  if (!ts.isIdentifier(decl.name) || !decl.initializer) return;
  const symbol = lowerer.checker.getSymbolAtLocation(decl.name);
  if (!symbol) return;
  const initializer =
    preservedLayoutOf(lowerer, decl.initializer) ?? lowerer.typeOf(decl.initializer);
  lowerer.preservedLayoutTypes.set(symbol, initializer);
  lowerer.layoutKeptNodes.add(decl.initializer);
}

/** Refuse a direct call that would copy an existing value into a parameter
 * the callee writes through (SC2021): the callee's write would reach only
 * the copy, while under Node the caller's object is the parameter.
 * structuralCallInstance already binds such a call to the argument's
 * layout whenever the callee's own layout can hold the parameter's; a
 * pair it cannot bind (`dyn` field against a union field) falls back to
 * the width copy, which this refuses. */
export function refuseWrittenParamCopy(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  decl: ts.FunctionDeclaration,
  sig: FnSig,
): void {
  if (decl.body === undefined) return;
  const params = decl.parameters.nodes;
  expr.arguments.nodes.forEach((arg, index) => {
    const param = params[index];
    const declared = sig.params[index];
    if (!param || !declared || param.type === undefined) return;
    if (!ts.isIdentifier(param.name)) return;
    if (!namesExistingValue(arg) || lowerer.layoutKeptNodes.has(arg)) return;
    // A signature whose own layout widens the declared type keeps its
    // boundary conversion (structureCallInstance's rule).
    const own = lowerer.mapTypeOf(lowerer.checker.getTypeAtLocation(param.name));
    if (!own || !typeEquals(own, declared.type)) return;
    if (declared.type.kind !== "record") return;
    const source = preservedLayoutOf(lowerer, arg) ?? lowerer.typeOf(arg);
    const from = lowerer.mapTypeOf(source);
    if (!from || from.kind !== "record" || typeEquals(from, declared.type)) return;
    // A projection (the argument has fields the parameter's type lacks) is
    // not the copy this refuses: the callee's layout is the only one that
    // carries the extra fields.
    if (!sameFieldsForCopy(lowerer, from, declared.type)) return;
    if (lowerer.recordWidthPlan(from.shapeId, declared.type.shapeId) === null) return;
    const symbol = lowerer.checker.getSymbolAtLocation(param.name);
    if (!symbol || decl.body === undefined) return;
    if (!observesIdentity(lowerer, decl.body, symbol, param.name.text)) return;
    const checker = lowerer.checker;
    const target = checker.typeToString(checker.getTypeAtLocation(param.name));
    lowerer.pushDiag(
      widthCopyRefusalDiag(
        "call",
        checker.typeToString(source),
        target,
        `the callee writes through '${param.name.text}', so the write would reach only the copy`,
        `declare the argument with the parameter's type ('${target}') so the callee receives the caller's object, or make the shape a class`,
        locOf(arg),
      ),
    );
    throw new PoisonError();
  });
}

/** The width lifts that rebuild a value: they copy the source's contents
 * into the destination's layout instead of storing the same object. */
const COPYING_STORE_LIFTS = new Set<string>(["width", "ovf", "arr", "tupleArr", "emptyArr"]);

/** Whether a value of layout `from` arrives at the slot `to` as a rebuilt
 * object: both sides are the same kind of composite and the store converts
 * between their layouts. */
function storeRebuilds(lowerer: Lowerer, from: IrType, to: IrType): boolean {
  if (typeEquals(from, to)) return false;
  const paired =
    (from.kind === "record" && to.kind === "record") ||
    (from.kind === "array" && to.kind === "array");
  if (!paired) return false;
  const plan = lowerer.widthLiftPlan(from, to);
  return plan !== null && COPYING_STORE_LIFTS.has(plan.how);
}

/** The store that would copy an existing value into a slot of a binding
 * that kept its initializer's layout: the kept slot represents the value in
 * a different layout, so the store rebuilds the object instead of sharing
 * it. Null when the target does not root at such a binding, the value is
 * fresh (its copy is not observable), or the value already has the slot's
 * layout. */
export function copiedStoreIntoKeptLayout(
  lowerer: Lowerer,
  target: ts.Expression,
  slot: IrType,
  value: ts.Expression,
): { binding: string; field: string | null; element: boolean; kept: IrType } | null {
  let e: ts.Expression = target;
  let field: string | null = null;
  // An element store (`kept.list[i] = v`) rebuilds through the array's own
  // element slot; the target names the element, not the binding.
  let element = false;
  if (ts.isPropertyAccessExpression(e) && !ts.isPrivateIdentifier(e.name)) field = e.name.text;
  else if (ts.isElementAccessExpression(e) && ts.isStringLiteralLike(e.argumentExpression))
    field = e.argumentExpression.text;
  else if (ts.isElementAccessExpression(e)) element = true;
  for (;;) {
    if (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) e = e.expression;
    else if (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e)) e = e.expression;
    else break;
  }
  const root = ts.isIdentifier(e) ? e : undefined;
  if (root === undefined || preservedLayoutOf(lowerer, root) === undefined) return null;
  if (!namesExistingValue(value)) return null;
  const source = lowerer.mapTypeOf(keptLayoutTypeOf(lowerer, value) ?? lowerer.typeOf(value));
  if (!source || !storeRebuilds(lowerer, source, slot)) return null;
  return { binding: root.text, field, element, kept: slot };
}

/** Refuse a store that would copy an existing value into a binding that kept
 * its initializer's layout (SC2021): the kept slot rebuilds the assigned
 * value, so a later write through the stored name would reach only the
 * copy, while under Node both names are one object. */
export function refuseCopiedStore(
  lowerer: Lowerer,
  target: ts.Expression,
  slot: IrType,
  value: ts.Expression,
): void {
  const store = copiedStoreIntoKeptLayout(lowerer, target, slot, value);
  if (store === null) return;
  const checker = lowerer.checker;
  const sourceText = checker.typeToString(lowerer.typeOf(value));
  const declaredText = checker.typeToString(lowerer.typeOf(target));
  const targetName = store.element
    ? target.getText()
    : store.field === null
      ? store.binding
      : `${store.binding}.${store.field}`;
  const detail = store.element
    ? `'${targetName}' is an element of a kept array ('${lowerer.fmt(store.kept)}') while the declared element is '${declaredText}'`
    : store.field === null
      ? `'${store.binding}' keeps the initializer's layout ('${lowerer.fmt(store.kept)}') instead of the declared '${declaredText}'`
      : `'${store.binding}' keeps the initializer's layout, so its field '${store.field}' is '${lowerer.fmt(store.kept)}' while the declared field is '${declaredText}'`;
  lowerer.pushDiag(
    keptLayoutStoreCopyDiag(
      targetName,
      sourceText,
      detail,
      `make the initializer's layout match the declared '${declaredText}' so both names are the same object, or make the shape a class`,
      locOf(target),
    ),
  );
  throw new PoisonError();
}
