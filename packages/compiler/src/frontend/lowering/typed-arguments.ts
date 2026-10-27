import * as ts from "../ts7/adapter.js";
import { bodyReadsArguments } from "../arguments-usage.js";
import { isJsSourceFile, locOf } from "../program.js";
import { restTupleElementTypes, unitOnlyUnion } from "../type-mapper.js";
import {
  DYN,
  type IrExpr,
  type IrLocal,
  type IrParam,
  type IrStmt,
  type IrType,
  arrayOf,
} from "../../ir/ir.js";
import type { Lowerer } from "./lowerer.js";
import { captureContextArguments } from "./function-context.js";
import { isThisParameter, type ParamShape } from "./call-signatures.js";
import { tryLowerExpression } from "./expressions/try-lower-expression.js";
import { omittedArgFor } from "./call-arguments.js";

/** Variadic forwarding through a FIXED signature.
 *
 * A TypeScript function expression that declares no parameters and reads
 * `arguments` (`function (this: unknown) { return fn.apply(this, arguments) }
 * as F`) is lowered against the fixed function type its value is asserted
 * to: one native slot per position of that type, and `arguments` is the
 * tuple of those slots. Inside a generic instantiation F is the call
 * site's concrete signature, so a higher-order wrapper specializes to the
 * wrapped function's exact ABI. Forwarding (`f.apply(thisArg, args)`,
 * `f(...args)`) then calls with the tuple's positions directly. */

/** `e`, with the type-only wrappers that never change its value removed. */
export function stripTypeWrappers(e: ts.Expression): ts.Expression {
  let cur = e;
  for (;;) {
    if (ts.isParenthesizedExpression(cur)) cur = cur.expression;
    else if (ts.isAsExpression(cur) || ts.isTypeAssertion(cur) || ts.isSatisfiesExpression(cur))
      cur = cur.expression;
    else if (ts.isNonNullExpression(cur)) cur = cur.expression;
    else return cur;
  }
}

/** The outermost type assertion around `node` (`node as unknown as F` → F),
 * looking through parentheses; null when the value is not asserted. */
function assertedTypeNode(node: ts.Node): ts.TypeNode | null {
  let cur: ts.Node = node;
  let found: ts.TypeNode | null = null;
  for (let parent = cur.parent; parent !== undefined; parent = cur.parent) {
    if (ts.isParenthesizedExpression(parent)) {
      cur = parent;
      continue;
    }
    if ((ts.isAsExpression(parent) || ts.isTypeAssertion(parent)) && parent.expression === cur) {
      found = parent.type;
      cur = parent;
      continue;
    }
    break;
  }
  return found;
}

/** The fixed function type a value is asserted to, or null. */
function assertedFuncType(lowerer: Lowerer, node: ts.Node): (IrType & { kind: "func" }) | null {
  const typeNode = assertedTypeNode(node);
  if (!typeNode) return null;
  const mapped = lowerer.mapTypeOf(lowerer.checker.getTypeFromTypeNode(typeNode));
  return mapped?.kind === "func" ? mapped : null;
}

function sameFuncType(a: IrType & { kind: "func" }, b: IrType & { kind: "func" }): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** A function expression whose `arguments` can be typed: TypeScript source,
 * no runtime parameters (a `this` parameter is type-only), an ordinary
 * (non-generator) function that reads its own `arguments`. */
export function typedArgumentsCandidate(node: ts.Node): node is ts.FunctionExpression {
  return (
    ts.isFunctionExpression(node) &&
    node.asteriskToken === undefined &&
    !isJsSourceFile(ts.getSourceFileOfNode(node)) &&
    node.parameters.nodes.every(isThisParameter) &&
    bodyReadsArguments(node)
  );
}

/** The fixed signature a typed-arguments function expression is lowered
 * against: the type its value is asserted to (`function () {…} as F`), the
 * one type every use of its const binding asserts it to (`const w =
 * function () {…}; return w as unknown as F`), or its contextual function
 * type. Null when none names one fixed-arity signature. */
export function typedArgumentsTarget(
  lowerer: Lowerer,
  node: ts.FunctionExpression,
): (IrType & { kind: "func" }) | null {
  const fixed = (t: (IrType & { kind: "func" }) | null) => (t && t.rest !== true ? t : null);
  const direct = assertedFuncType(lowerer, node);
  if (direct) return fixed(direct);
  let top: ts.Node = node;
  while (top.parent && ts.isParenthesizedExpression(top.parent)) top = top.parent;
  const decl = top.parent;
  if (
    decl &&
    ts.isVariableDeclaration(decl) &&
    decl.initializer === top &&
    decl.type === undefined &&
    ts.isIdentifier(decl.name) &&
    (ts.getCombinedNodeFlags(decl) & ts.NodeFlags.Const) !== 0
  ) {
    const symbol = lowerer.checker.getSymbolAtLocation(decl.name);
    const scope = enclosingScope(decl);
    if (symbol && scope) {
      let target: (IrType & { kind: "func" }) | null = null;
      let ok = true;
      let uses = 0;
      ts.walkPreorder(scope, (n) => {
        if (!ok) return "stop";
        if (n === decl.name || !ts.isIdentifier(n) || n.text !== decl.name.text) return undefined;
        if (lowerer.checker.getSymbolAtLocation(n) !== symbol) return undefined;
        uses++;
        const asserted = assertedFuncType(lowerer, n);
        if (!asserted || (target && !sameFuncType(target, asserted))) ok = false;
        else target = asserted;
        return undefined;
      });
      if (ok && uses > 0) return fixed(target);
    }
  }
  const ctxType = lowerer.checker.getContextualType(node);
  if (!ctxType) return null;
  const sigs = lowerer.checker.getCallSignatures(lowerer.checker.getNonNullableType(ctxType));
  if (sigs.length !== 1) return null;
  const mapped = lowerer.mapTypeOf(lowerer.checker.getNonNullableType(ctxType));
  return mapped?.kind === "func" ? fixed(mapped) : null;
}

function enclosingScope(node: ts.Node): ts.Node | null {
  for (let cur = node.parent; cur !== undefined; cur = cur.parent) {
    if (ts.isSourceFile(cur) || (ts.isFunctionLike(cur) && cur.body !== undefined)) return cur;
  }
  return null;
}

/** The tuple type of a fixed parameter list, interned exactly as the
 * spelled tuple (and `Parameters<F>`) map: positional fields, or the
 * empty-array form for no parameters. */
export function tupleTypeOfParams(lowerer: Lowerer, params: readonly IrType[]): IrType {
  if (params.length === 0) return arrayOf(unitOnlyUnion(lowerer.unions));
  const fields = params.map((type, i) => ({ name: String(i), type }));
  fields.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { kind: "record", shapeId: lowerer.shapes.intern(fields, true) };
}

/** The ABI shapes of a typed-arguments function: one required slot per
 * position of its target signature. */
export function typedArgumentsShapes(target: IrType & { kind: "func" }): ParamShape[] {
  return target.params.map((type) => ({ type, mode: "required" }));
}

/** Declares the hidden positional slots of a typed-arguments function and
 * binds its `arguments` to their tuple. */
export function declareTypedArguments(
  lowerer: Lowerer,
  node: ts.FunctionExpression,
  shapes: readonly ParamShape[],
  params: IrParam[],
  prologue: IrStmt[],
): void {
  const loc = locOf(node);
  const slots = shapes.map((shape, i) => {
    const slot = lowerer.declareHiddenLocal(`%arguments.${i}`, shape.type);
    params.push({ localId: slot.id, name: `%arguments.${i}`, type: shape.type });
    return slot;
  });
  const tupleType = tupleTypeOfParams(
    lowerer,
    shapes.map((s) => s.type),
  );
  const local = lowerer.declareHiddenLocal("%arguments", tupleType);
  lowerer.ctx.argumentsLocal = local;
  // Pure forwarding (every read is forwarded, counted, or aliased by a
  // binding that is itself only forwarded): no tuple exists at all.
  if (
    onlyForwarded(lowerer, node, (id) => id.text === "arguments" && argumentsOwner(id) === node)
  ) {
    lowerer.ctx.pureTuples.set(local.id, slots);
    return;
  }
  prologue.push({
    kind: "varDecl",
    localId: local.id,
    init: lowerer.tupleOfSlots(slots, tupleType, node, loc),
    loc,
  });
}

/** The binding an identifier reads: its symbol, or for the name of a
 * shorthand property (`{ xs }`) the variable whose value the property takes. */
export function bindingSymbolOfRead(lowerer: Lowerer, id: ts.Identifier): ts.Symbol | undefined {
  const parent = id.parent;
  if (parent && ts.isShorthandPropertyAssignment(parent) && parent.name === id)
    return lowerer.checker.getShorthandAssignmentValueSymbol(parent);
  return lowerer.checker.getSymbolAtLocation(id);
}

/** Whether every read of a tuple binding in `fn` (identified by `isRoot`)
 * only forwards it: `f.apply(t, x)`, `g(...x)` into a program function,
 * `x.length`, or a const alias whose own reads only forward. Reads inside
 * nested functions (arrows included) capture the binding and need the
 * tuple. Type assertions around a read never matter. */
export function onlyForwarded(
  lowerer: Lowerer,
  fn: ts.Node,
  isRoot: (id: ts.Identifier) => boolean,
): boolean {
  const body = (fn as ts.Node & { body?: ts.Node }).body;
  if (body === undefined) return false;
  const roots: ((id: ts.Identifier) => boolean)[] = [isRoot];
  let ok = true;
  const visit = (scope: ts.Node, test: (id: ts.Identifier) => boolean): void => {
    ts.walkPreorder(scope, (n) => {
      if (!ok) return "stop";
      if (ts.isTypeNode(n)) return "skip";
      if (!ts.isIdentifier(n) || !test(n)) return undefined;
      for (let cur = n.parent; cur !== undefined && cur !== fn; cur = cur.parent) {
        if (ts.isFunctionLike(cur)) {
          ok = false;
          return "stop";
        }
      }
      let top: ts.Node = n;
      while (
        top.parent &&
        (ts.isParenthesizedExpression(top.parent) ||
          ts.isAsExpression(top.parent) ||
          ts.isTypeAssertion(top.parent) ||
          ts.isSatisfiesExpression(top.parent) ||
          ts.isNonNullExpression(top.parent))
      )
        top = top.parent;
      const p = top.parent;
      if (!p) {
        ok = false;
        return "stop";
      }
      if (ts.isPropertyAccessExpression(p) && p.expression === top && p.name.text === "length")
        return undefined;
      if (
        ts.isCallExpression(p) &&
        p.arguments.nodes.length === 2 &&
        p.arguments.nodes[1] === top &&
        ts.isPropertyAccessExpression(p.expression) &&
        p.expression.name.text === "apply" &&
        p.expression.questionDotToken === undefined
      )
        return undefined;
      if (ts.isSpreadElement(p) && p.parent && ts.isCallExpression(p.parent)) {
        const sigs = lowerer.checker.getCallSignatures(
          lowerer.checker.getNonNullableType(lowerer.typeOf(p.parent.expression)),
        );
        const decl = sigs.length === 1 ? sigs[0]!.declaration : undefined;
        if (decl && !ts.getSourceFileOfNode(decl).isDeclarationFile) return undefined;
      }
      if (
        ts.isVariableDeclaration(p) &&
        p.initializer === top &&
        ts.isIdentifier(p.name) &&
        (ts.getCombinedNodeFlags(p) & ts.NodeFlags.Const) !== 0
      ) {
        const alias = lowerer.checker.getSymbolAtLocation(p.name);
        const aliasName = p.name;
        if (alias) {
          roots.push((id) => id !== aliasName && bindingSymbolOfRead(lowerer, id) === alias);
          return undefined;
        }
      }
      ok = false;
      return "stop";
    });
  };
  for (let i = 0; i < roots.length && ok; i++) visit(body, roots[i]!);
  return ok;
}

/** The native slots of a pure-forwarded tuple binding read at `node` in
 * the current function, or null when the tuple is materialized. */
function pureSlotsOf(lowerer: Lowerer, node: ts.Expression): IrLocal[] | null {
  const operand = stripTypeWrappers(node);
  if (!ts.isIdentifier(operand)) return null;
  const local =
    operand.text === "arguments" ? lowerer.ctx.argumentsLocal : lowerer.peekLocal(operand);
  return local ? (lowerer.ctx.pureTuples.get(local.id) ?? null) : null;
}

/** The positional values `node` forwards when it is a pure-forwarded tuple
 * (slot reads, in order), or null. */
export function pureForwardedValues(lowerer: Lowerer, node: ts.Expression): IrExpr[] | null {
  const slots = pureSlotsOf(lowerer, node);
  if (!slots) return null;
  const loc = locOf(node);
  return slots.map((slot) => ({ kind: "varRef", localId: slot.id, type: slot.type, loc }));
}

/** Whether `node` reads a tuple-typed `arguments` binding: the nearest
 * ordinary function (arrows inherit it) is a typed-arguments function.
 * Looks the binding up without allocating captures. */
function isTypedArgumentsRead(lowerer: Lowerer, node: ts.Expression): boolean {
  if (!ts.isIdentifier(node) || node.text !== "arguments") return false;
  const stack = lowerer.fnStack;
  let owner = stack.length - 1;
  while (owner > 0 && stack[owner]!.inheritsArguments) owner--;
  const own = owner >= 0 ? stack[owner]!.argumentsLocal : undefined;
  return own !== undefined && own !== null && own.type.kind !== "dyn";
}

/** The fixed tuple `node` forwards, or null: the typed `arguments`, a
 * fixed-tuple rest parameter, or a const alias of either — seen through
 * type assertions, which never change the value. */
export function forwardedTupleType(lowerer: Lowerer, node: ts.Expression): IrType | null {
  const operand = stripTypeWrappers(node);
  if (!ts.isIdentifier(operand)) return null;
  if (operand.text === "arguments") {
    if (!isTypedArgumentsRead(lowerer, operand)) return null;
    return captureContextArguments(lowerer.fnStack)!.type;
  }
  const symbol = lowerer.resolveValueSymbol(operand);
  if (!symbol) return null;
  const alias = lowerer.tupleAliasSymbols.get(symbol);
  if (alias) return alias;
  const decl = symbol.valueDeclaration;
  if (
    decl !== undefined &&
    ts.isParameter(decl) &&
    decl.dotDotDotToken !== undefined &&
    ts.isIdentifier(decl.name) &&
    !isJsSourceFile(ts.getSourceFileOfNode(decl)) &&
    // Checker-only probe first: an ordinary array rest never maps here.
    restTupleElementTypes(lowerer.typeOf(operand), lowerer.typeCtx) !== null
  ) {
    // A tuple with optional positions has no value type of its own; its
    // forwarded-only binding carries the slots' tuple (declareRestTupleParam).
    const t = lowerer.mapTypeOf(lowerer.typeOf(operand)) ?? lowerer.peekLocal(operand)?.type;
    if (t && isTupleValueType(lowerer, t)) return t;
  }
  return null;
}

function isTupleValueType(lowerer: Lowerer, t: IrType): boolean {
  if (t.kind === "record") return lowerer.shapes.get(t.shapeId)?.tuple === true;
  // The empty tuple's representation (mapType's `[]` rule): an array over
  // the unit-only union. Looked up, never interned, so probing a value
  // leaves the registries untouched.
  if (t.kind !== "array" || t.elem.kind !== "union") return false;
  const arms = lowerer.unions.get(t.elem.unionId)?.arms;
  return (
    arms !== undefined &&
    arms.length === 2 &&
    arms.some((a) => a.kind === "nullT") &&
    arms.some((a) => a.kind === "undefinedT")
  );
}

/** The positional reads of a forwarded tuple value (already saved in a
 * local), in order. */
function tupleReads(
  lowerer: Lowerer,
  ref: () => IrExpr,
  tupleType: IrType,
  loc: IrExpr["loc"],
): IrExpr[] {
  if (tupleType.kind !== "record") return [];
  const shape = lowerer.shapes.get(tupleType.shapeId)!;
  return [...shape.fields]
    .sort((a, b) => Number(a.name) - Number(b.name))
    .map((field) => ({
      kind: "recordGet" as const,
      obj: ref(),
      shapeId: tupleType.shapeId,
      field: field.name,
      type: field.type,
      loc,
    }));
}

/** `f.apply(thisArg, args)` where `args` forwards a fixed tuple and `f` is a
 * fixed-arity function value: a direct call of `f` with the tuple's
 * positions and `thisArg` as the call-time receiver. Null for every other
 * form (the existing Function.prototype paths keep them). */
export function lowerForwardingApply(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  if (access.name.text !== "apply" || access.questionDotToken !== undefined) return null;
  const argNodes = call.arguments.nodes;
  if (argNodes.length !== 2 || argNodes.some(ts.isSpreadElement)) return null;
  const tupleType = forwardedTupleType(lowerer, argNodes[1]!);
  if (!tupleType) return null;
  const callee = tryLowerExpression(lowerer, access.expression);
  if (callee?.type.kind !== "func") return null;
  const fnType = callee.type;
  const loc = locOf(call);
  if (fnType.rest === true) {
    lowerer.unsupported(
      "SC1090",
      call,
      "forwarding a fixed argument tuple through 'apply' to a variadic function value",
    );
  }
  const savedFn = lowerer.declareHiddenLocal("%applyFn", fnType);
  const savedThis = lowerer.declareHiddenLocal("%applyThis", DYN);
  const stmts: IrStmt[] = [
    { kind: "varDecl", localId: savedFn.id, init: callee, loc },
    {
      kind: "varDecl",
      localId: savedThis.id,
      init: lowerer.lowerExprExpecting(argNodes[0]!, DYN),
      loc,
    },
  ];
  let reads = pureForwardedValues(lowerer, argNodes[1]!);
  if (!reads) {
    const savedArgs = lowerer.declareHiddenLocal("%applyArgs", tupleType);
    stmts.push({
      kind: "varDecl",
      localId: savedArgs.id,
      init: lowerer.lowerExpr(stripTypeWrappers(argNodes[1]!)),
      loc,
    });
    reads = tupleReads(
      lowerer,
      () => ({ kind: "varRef", localId: savedArgs.id, type: tupleType, loc }),
      tupleType,
      loc,
    );
  }
  // JS drops surplus positions and fills missing ones with undefined.
  const args = fnType.params.map((param, i): IrExpr => {
    const read = reads[i];
    if (read) return lowerer.coerceInto(call, read, param);
    const absent = omittedArgFor(lowerer, param, loc);
    if (!absent) {
      lowerer.unsupported(
        "SC1090",
        call,
        "forwarding fewer arguments through 'apply' than the callee's required parameters",
      );
    }
    return absent;
  });
  const invoked: IrExpr = {
    kind: "callValue",
    callee: { kind: "varRef", localId: savedFn.id, type: fnType, loc },
    receiver: { kind: "varRef", localId: savedThis.id, type: DYN, loc },
    args,
    type: fnType.ret,
    loc,
  };
  return { kind: "seqExpr", stmts, result: invoked, type: fnType.ret, loc };
}

/** `const args = arguments as …` (or an alias of a rest tuple) inside a
 * typed-arguments function: the binding holds the tuple itself — the
 * assertion only re-describes the value — and stays a forwarding source. */
export function lowerTupleAliasDecl(lowerer: Lowerer, decl: ts.VariableDeclaration): IrStmt | null {
  if (
    !decl.initializer ||
    !ts.isIdentifier(decl.name) ||
    (ts.getCombinedNodeFlags(decl) & ts.NodeFlags.Const) === 0 ||
    lowerer.fnStack.length === 0
  ) {
    return null;
  }
  const tupleType = forwardedTupleType(lowerer, decl.initializer);
  if (!tupleType) return null;
  const symbol = lowerer.checker.getSymbolAtLocation(decl.name);
  if (!symbol) return null;
  const declared = lowerer.mapTypeOf(lowerer.typeOf(decl.name));
  if (declared && declared.kind !== "dyn" && JSON.stringify(declared) !== JSON.stringify(tupleType))
    return null;
  lowerer.tupleAliasSymbols.set(symbol, tupleType);
  const slots = pureSlotsOf(lowerer, decl.initializer);
  if (slots) {
    // An alias of a pure-forwarded tuple is itself only forwarded
    // (onlyForwarded followed it): it names the same slots.
    const local = lowerer.declareLocal(decl.name, decl.name.text, tupleType, false);
    lowerer.ctx.pureTuples.set(local.id, slots);
    return { kind: "block", body: [], loc: locOf(decl) };
  }
  const init = lowerer.lowerExpr(stripTypeWrappers(decl.initializer));
  const local = lowerer.declareLocal(decl.name, decl.name.text, tupleType, false);
  return { kind: "varDecl", localId: local.id, init, loc: locOf(decl) };
}

/** A spread operand forwarding a fixed tuple (forwardedTupleType),
 * including one that resolved to no positions at all. */
export function isForwardedTupleSpread(lowerer: Lowerer, node: ts.Expression): boolean {
  return forwardedTupleType(lowerer, node) !== null;
}

/** `arguments` read inside a typed-arguments function: its fixed arity. */
export function typedArgumentsArity(lowerer: Lowerer, node: ts.Expression): number | null {
  if (!ts.isIdentifier(node)) return null;
  const t = forwardedTupleType(lowerer, node);
  if (!t) return null;
  if (t.kind !== "record") return 0;
  const fields = lowerer.shapes.get(t.shapeId)?.fields ?? [];
  // A position that may be undefined may also be absent at the call: the
  // native signature always passes it, so the count is not static.
  if (
    fields.some(
      (f) => f.type.kind === "union" && lowerer.armTag(f.type.unionId, { kind: "undefinedT" }) >= 0,
    )
  ) {
    lowerer.unsupported(
      "SC1090",
      node.parent ?? node,
      "'length' of an argument tuple whose positions may be omitted (the native signature always passes every position, so the count is not static)",
    );
  }
  return fields.length;
}

/** The function whose `arguments` an identifier reads: the nearest
 * enclosing non-arrow function. */
export function argumentsOwner(node: ts.Node): ts.Node | null {
  for (let cur = node.parent; cur !== undefined; cur = cur.parent) {
    if (ts.isFunctionLike(cur) && !ts.isArrowFunction(cur)) return cur;
    if (ts.isSourceFile(cur)) return null;
  }
  return null;
}
