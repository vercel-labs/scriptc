/* Classes declared `extends Array`. An instance is an array of the class's
 * element type: its struct begins with the runtime's array header (the
 * reference count is the array's) and the class's own fields follow it, so
 * every array operation applies to the instance unchanged and passing it
 * where a plain array is expected passes the same object. The class's
 * TypeScript type maps to its element array type; the class's own members,
 * construction and `instanceof` view the array as the class object
 * (arrayClassView). */
import * as ts from "../../ts7/adapter.js";
import { withoutParenthesesTypeWrappers } from "../../outer-expressions.js";
import { type Lowerer } from "../lowerer.js";
import { isJsSourceFile, locOf } from "../../program.js";
import { keyedHelperName } from "../stable-names.js";
import { dynUndefinedExpr, nodeThrowExpr } from "../../../ir/build.js";
import { completeArgs, completeFuncValueArgs } from "../call-arguments.js";
import { lowerArrayFromCall, lowerArrayOfCall } from "../containers/array-construction.js";
import { boundedArrayHofHelper } from "../containers/array-callbacks.js";
import {
  findGenericMethodOn,
  lowerClassGenericMethodCall,
  storedClassValueType,
  type ClassInfo,
} from "../lower-classes.js";
import { isClassCallback } from "../class-callbacks.js";
import { isSafeToRepeat } from "../expressions/evaluation-safety.js";
import { mapExprChildren, mapStmtChildren } from "../../../ir/traverse.js";
import { ARRAY_METHODS } from "../surfaces.js";
import { v8CalleeText } from "../expressions/narrowing.js";
import {
  BOOL,
  DYN,
  F64,
  STRING,
  UNDEFINED_T,
  VOID,
  arrayOf,
  typeEquals,
  type IrExpr,
  type IrFunction,
  type IrLocal,
  type IrStmt,
  type IrType,
  type SrcLoc,
} from "../../../ir/ir.js";

/** The element type of `class X extends Array<T>` (`extends Array` in
 * JavaScript reads `any[]`, whose elements are checked-dynamic). */
export function arrayClassBase(
  lowerer: Lowerer,
  heritage: ts.ExpressionWithTypeArguments,
): { elem: IrType } {
  const decl = heritage.parent?.parent;
  const self =
    decl && ts.isClassLikeDeclaration(decl)
      ? lowerer.checker.getSymbolAtLocation(decl.name ?? decl)
      : undefined;
  const element = heritage.typeArguments?.nodes[0];
  if (
    self &&
    element &&
    mentionsClass(lowerer, lowerer.checker.getTypeAtLocation(element), self, new Set())
  )
    lowerer.unsupported("SC1090", heritage, "classes that extend an Array of their own instances");
  const mapped = lowerer.mapTypeOf(lowerer.checker.getTypeAtLocation(heritage));
  // `extends Array` in JavaScript reads `any[]`: dyn elements.
  if (isJsSourceFile(ts.getSourceFileOfNode(heritage)) && mapped?.kind !== "array")
    return { elem: DYN };
  if (mapped?.kind !== "array")
    lowerer.unsupported(
      "SC1090",
      heritage,
      "extending Array with an element type that does not compile",
    );
  return { elem: mapped!.kind === "array" ? mapped!.elem : DYN };
}

/** Whether `type` is the class `self`'s instance type, or holds it through
 * unions, intersections or type arguments (`Group | null`, `Group[]`,
 * `Map<string, Group>`): the class's array type would contain itself.
 * Another class's members do not count, its instances are references. */
function mentionsClass(
  lowerer: Lowerer,
  type: ts.Type,
  self: ts.Symbol,
  seen: Set<ts.Type>,
): boolean {
  if (seen.has(type)) return false;
  seen.add(type);
  if (type.getSymbol() === self) return true;
  if (type.isUnionType() || type.isIntersectionType())
    return ts.constituentTypes(type).some((part) => mentionsClass(lowerer, part, self, seen));
  return lowerer.checker
    .getTypeArguments(type as ts.TypeReference)
    .some((argument) => mentionsClass(lowerer, argument, self, seen));
}

/** The class declared `extends Array` at the root of `info`'s chain, or null. */
export function arrayRootOf(info: ClassInfo | null | undefined): ClassInfo | null {
  for (let c = info ?? null; c; c = c.base) if (c.extendsArray) return c;
  return null;
}

/** Whether a class declared `extends Array` over the elements of `array`
 * declares the field, method or accessor `name`: an array of that type can be one
 * of its instances. (Whether the class is constructed is known only once
 * lowering has reached every `new`; the dispatch tests constructed classes
 * only.) */
export function arrayClassDeclaresMember(
  lowerer: Lowerer,
  array: Extract<IrType, { kind: "array" }>,
  name: string,
): boolean {
  for (const info of lowerer.classes.values()) {
    const elem = info.extendsArray?.elem;
    if (elem === undefined || !typeEquals(elem, array.elem)) continue;
    if (
      info.fields.has(name) ||
      lowerer.findMethodOn(info, name) ||
      lowerer.findMethodOn(info, `get:${name}`) ||
      lowerer.findMethodOn(info, `set:${name}`)
    )
      return true;
  }
  return false;
}

/** The array a class instance is (a reinterpret: the same object). */
export function arrayOfClassInstance(info: ClassInfo, value: IrExpr, loc: SrcLoc): IrExpr {
  const root = arrayRootOf(info)!;
  return { kind: "upcast", value, type: arrayOf(root.extendsArray!.elem), loc };
}

/** The class object an instance of `info` is, viewed from its array type
 * (a reinterpret; the value is known to be an instance of the class). */
export function arrayClassView(info: ClassInfo, value: IrExpr, loc: SrcLoc): IrExpr {
  return { kind: "downcast", value, type: { kind: "object", className: info.def.name }, loc };
}

/** The receiver of a member that `info` declares, read on `value` (the
 * lowered `node`): an array value is viewed as the class object. An array
 * whose elements are not the class's (a species result of another element
 * type, narrowed back to the class by `instanceof`) is refused. An element
 * read of an array of instances (`live[i].refresh()`) holds the array with
 * the element hole's unit arm: an absent element throws Node's TypeError
 * for reading (or setting) `member`, and a present one is the instance. */
export function arrayClassReceiver(
  lowerer: Lowerer,
  info: ClassInfo,
  value: IrExpr,
  node: ts.Expression,
  member: string,
  action: "read" | "set" = "read",
  deferred?: DeferredArrayClassCheck[],
): IrExpr {
  const root = arrayRootOf(info);
  if (value.type.kind === "union" && root?.extendsArray !== undefined) {
    const present = lowerer.runtimeOptionalPropertyReceiver(
      node,
      value,
      arrayOf(root.extendsArray.elem),
      member,
      action,
    );
    if (present !== null) value = present;
  }
  if (value.type.kind !== "array") return value;
  if (root?.extendsArray === undefined || !typeEquals(value.type.elem, root.extendsArray.elem))
    lowerer.unsupported(
      "SC1090",
      node,
      "members of an Array subclass on an array whose elements are another type (a species result narrowed back to the class)",
    );
  return checkedArrayClassView(lowerer, info, value, node, member, action, deferred);
}

/** The class test of a method call's receiver that waits for its
 * arguments (applyDeferredArrayClassCheck): `local` holds the receiver
 * array, which `value` computes. */
export interface DeferredArrayClassCheck {
  local: string;
  value: IrExpr;
  info: ClassInfo;
  message: string;
  loc: SrcLoc;
  /** The call whose written arguments evaluate before the TypeError. */
  call: ts.CallExpression;
}

/** The class object of `value`, an array the checker types as an instance
 * of `info`. The class's type is its array type, so a plain array reaches
 * here as well: one parsed from JSON into a `C[]` parameter, or an array
 * asserted to be the class (`xs as C`). Only an array whose class is `info`
 * has the class's fields after its header, so any other array throws the
 * catchable TypeError: Node's "is not a function" for a method call, and
 * for a field or accessor, which Node would read as a missing property of
 * the plain array, a TypeError naming the member. `this` inside the class
 * (an instance viewed as its array) is an instance already. */
function checkedArrayClassView(
  lowerer: Lowerer,
  info: ClassInfo,
  value: IrExpr,
  node: ts.Expression,
  member: string,
  action: "read" | "set",
  deferred: DeferredArrayClassCheck[] | undefined,
): IrExpr {
  const loc = locOf(node);
  if (
    value.kind === "upcast" &&
    value.value.type.kind === "object" &&
    value.value.type.className === info.def.name
  )
    return value.value;
  const objectType: IrType = { kind: "object", className: info.def.name };
  const repeat = isSafeToRepeat(value);
  const stable = repeat ? null : lowerer.declareHiddenLocal("%arrayClassRecv", value.type);
  const ref = (): IrExpr =>
    repeat ? value : { kind: "varRef", localId: stable!.id, type: value.type, loc };
  const access = node.parent;
  const callExpr =
    access !== undefined &&
    ts.isCallExpression(access.parent) &&
    access.parent.expression === access
      ? access.parent
      : null;
  const className = info.def.jsName ?? info.def.name;
  const message = callExpr
    ? `${v8CalleeText(callExpr.expression)} is not a function`
    : `Cannot ${action} '${member}' of an array that is not a ${className} instance`;
  // A method call reads the callee, then evaluates the arguments, and only
  // then finds the callee is not a function: the call's lowering tests the
  // class after the arguments (applyDeferredArrayClassCheck).
  if (callExpr !== null && deferred !== undefined) {
    const local = lowerer.declareHiddenLocal("%arrayClassRecv", value.type);
    deferred.push({ local: local.id, value, info, message, loc, call: callExpr });
    return arrayClassView(info, { kind: "varRef", localId: local.id, type: value.type, loc }, loc);
  }
  const result: IrExpr = {
    kind: "ternary",
    cond: { kind: "instanceOf", value: ref(), className: info.def.name, type: BOOL, loc },
    then: arrayClassView(info, ref(), loc),
    else_: nodeThrowExpr(1, "", message, objectType, loc),
    type: objectType,
    loc,
  };
  if (stable === null) return result;
  return {
    kind: "seqExpr",
    stmts: [{ kind: "varDecl", localId: stable.id, init: value, loc }],
    result,
    type: objectType,
    loc,
  };
}

/** The method call `result` with its receiver's deferred class test: the
 * receiver array and each argument evaluate in order into locals, and the
 * call runs on the class view only when the array is an instance, where
 * Node's "is not a function" TypeError is thrown otherwise. For a call
 * shape without the receiver in its first argument, an array that is not
 * an instance evaluates the arguments on a path of its own before the
 * TypeError. */
export function applyDeferredArrayClassCheck(
  lowerer: Lowerer,
  result: IrExpr,
  check: DeferredArrayClassCheck,
): IrExpr {
  const { local, value, info, message, loc } = check;
  const array: IrExpr = { kind: "varRef", localId: local, type: value.type, loc };
  const isInstance: IrExpr = {
    kind: "instanceOf",
    value: array,
    className: info.def.name,
    type: BOOL,
    loc,
  };
  const failUnless: IrStmt = {
    kind: "if",
    cond: { kind: "unary", op: "!", operand: isInstance, type: BOOL, loc },
    then: [{ kind: "exprStmt", expr: nodeThrowExpr(1, "", message, { kind: "void" }, loc), loc }],
    else_: null,
    loc,
  };
  const holdsReceiver = (arg: IrExpr | undefined): boolean => {
    let e = arg;
    while (e?.kind === "upcast") e = e.value;
    return e?.kind === "downcast" && e.value.kind === "varRef" && e.value.localId === local;
  };
  let found = false;
  const rewriteStmt = (stmt: IrStmt): IrStmt => mapStmtChildren(stmt, rewrite, rewriteStmt);
  const rewrite = (expr: IrExpr): IrExpr => {
    if (found) return expr;
    if ((expr.kind === "call" || expr.kind === "virtualCall") && holdsReceiver(expr.args[0])) {
      found = true;
      const stmts: IrStmt[] = [{ kind: "varDecl", localId: local, init: value, loc }];
      const args = expr.args.map((arg, i) => {
        // A literal keeps its value; any other argument is held, since a
        // later argument can change what it reads (`m(x, x = 2)`).
        if (i === 0 || arg.kind === "numLit" || arg.kind === "strLit" || arg.kind === "boolLit")
          return arg;
        const held = lowerer.declareHiddenLocal("%arrayClassArg", arg.type);
        stmts.push({ kind: "varDecl", localId: held.id, init: arg, loc });
        return { kind: "varRef", localId: held.id, type: arg.type, loc } as IrExpr;
      });
      // A statement throws, so a method that returns nothing needs no value
      // on the failing path.
      stmts.push(failUnless);
      return { kind: "seqExpr", stmts, result: { ...expr, args }, type: expr.type, loc };
    }
    return mapExprChildren(expr, rewrite, rewriteStmt);
  };
  const rewritten = rewrite(result);
  if (found) return rewritten;
  // Another call shape (a method a program can replace through its
  // prototype reads its slot from the instance before the arguments): an
  // array that is not an instance evaluates the written arguments, packed
  // as the dynamic arguments of a call, and then throws, and an instance
  // runs the call as it was lowered.
  const effects = lowerer.completeArgs(
    check.call.arguments.nodes,
    [{ type: DYN, mode: "dynRest" }],
    loc,
    check.call,
  );
  return {
    kind: "seqExpr",
    stmts: [
      { kind: "varDecl", localId: local, init: value, loc },
      {
        kind: "if",
        cond: { kind: "unary", op: "!", operand: isInstance, type: BOOL, loc },
        then: [
          ...effects.map((expr): IrStmt => ({ kind: "exprStmt", expr, loc })),
          { kind: "exprStmt", expr: nodeThrowExpr(1, "", message, { kind: "void" }, loc), loc },
        ],
        else_: null,
        loc,
      },
    ],
    result,
    type: result.type,
    loc,
  };
}

function thisArray(info: ClassInfo, thisLocal: IrLocal, loc: SrcLoc): IrExpr {
  return arrayOfClassInstance(
    info,
    {
      kind: "varRef",
      localId: thisLocal.id,
      type: { kind: "object", className: info.def.name },
      loc,
    },
    loc,
  );
}

/** The implicit constructor's super(...args): `pack` is its dyn argument
 * array, applied with the Array constructor's length-or-elements rule. */
export function arraySuperCall(
  info: ClassInfo,
  thisRef: IrExpr,
  pack: IrExpr,
  loc: SrcLoc,
): IrStmt {
  const elem = arrayRootOf(info)!.extendsArray!.elem;
  return {
    kind: "exprStmt",
    expr: {
      kind: "libCall",
      fn: "array.subclassConstructDyn",
      args: [
        arrayOfClassInstance(info, thisRef, loc),
        pack,
        { kind: "boolLit", value: elem.kind === "dyn", type: BOOL, loc },
      ],
      type: { kind: "void" },
      loc,
    },
    loc,
  };
}

/** An explicit super(...) in a class declared `extends Array`: one number
 * argument sets the length; otherwise the arguments (spreads included)
 * become the elements, with the same one-number rule at run time. */
export function lowerArraySuperCall(
  lowerer: Lowerer,
  info: ClassInfo,
  thisLocal: IrLocal,
  superCall: ts.CallExpression,
): IrStmt[] {
  const loc = locOf(superCall);
  const elem = arrayRootOf(info)!.extendsArray!.elem;
  const args = superCall.arguments.nodes;
  if (args.length === 0) return [];
  const only = args.length === 1 && !ts.isSpreadElement(args[0]!) ? args[0]! : null;
  if (only !== null && (lowerer.typeOf(only).flags & ts.TypeFlags.NumberLike) !== 0) {
    return [
      {
        kind: "arraySetLength",
        arr: thisArray(info, thisLocal, loc),
        length: lowerer.lowerExprExpecting(only, { kind: "f64" }),
        loc,
      },
    ];
  }
  const arrT = arrayOf(elem);
  const elements: IrExpr[] = [];
  const spreads: number[] = [];
  for (const arg of args) {
    if (ts.isSpreadElement(arg)) {
      spreads.push(elements.length);
      elements.push(lowerer.lowerExprExpecting(arg.expression, arrT));
    } else elements.push(lowerer.lowerExprExpecting(arg, elem));
  }
  const pack: IrExpr = {
    kind: "arrayLit",
    elems: elements,
    ...(spreads.length > 0 ? { spreads } : {}),
    type: arrT,
    loc,
  } as IrExpr;
  return [
    {
      kind: "exprStmt",
      expr: {
        kind: "libCall",
        fn: "array.subclassConstruct",
        args: [
          thisArray(info, thisLocal, loc),
          pack,
          { kind: "boolLit", value: elem.kind === "dyn", type: BOOL, loc },
        ],
        type: { kind: "void" },
        loc,
      },
      loc,
    },
  ];
}

/** The ClassInfo of a class declared `extends Array`, by its declaration. */
export function arrayClassOfDecl(
  lowerer: Lowerer,
  decl: ts.ClassLikeDeclaration,
): ClassInfo | null {
  const symbol = decl.name ? lowerer.checker.getSymbolAtLocation(decl.name) : undefined;
  let info = symbol ? lowerer.classBySymbol.get(symbol) : undefined;
  if (!info)
    for (const candidate of lowerer.classes.values()) if (candidate.decl === decl) info = candidate;
  return info && arrayRootOf(info) ? info : null;
}

/** The class that declares the member `access` names when that class is
 * declared `extends Array` (its own fields, methods and accessors), or null
 * for the Array members it inherits and every other access. */
export function arrayClassMemberOwner(
  lowerer: Lowerer,
  access: ts.PropertyAccessExpression,
): ClassInfo | null {
  const symbol = lowerer.checker.getSymbolAtLocation(access.name);
  const decl = symbol?.declarations?.[0];
  const owner = decl?.parent;
  if (owner === undefined || !ts.isClassLikeDeclaration(owner)) return null;
  const declarer = arrayClassOfDecl(lowerer, owner);
  if (declarer === null) return null;
  // The receiver's own class (a subclass member reached through a base
  // spelling is the same instance).
  const receiver = lowerer.typeOf(access.expression).getSymbol()?.valueDeclaration;
  if (receiver !== undefined && ts.isClassLikeDeclaration(receiver))
    return arrayClassOfDecl(lowerer, receiver) ?? declarer;
  return declarer;
}

/** `x instanceof Array` on a static array (always true: every array value,
 * subclass instances included, is an Array) and `x instanceof X` for a
 * class X declared `extends Array`: the array's class, read from its ext
 * at run time. Null for every other instanceof. */
export function lowerArrayClassInstanceOf(
  lowerer: Lowerer,
  expr: ts.BinaryExpression,
  loc: SrcLoc,
): IrExpr | null {
  if (!ts.isIdentifier(expr.right)) return null;
  const leftType = lowerer.mapTypeOf(lowerer.typeOf(expr.left));
  if (lowerer.isStdlibGlobal(expr.right, "Array")) {
    // A checked-dynamic value: the Array.isArray test (one realm).
    if (leftType?.kind === "dyn")
      return {
        kind: "dynTest",
        test: "array",
        value: lowerer.coerceInto(expr.left, lowerer.lowerExpr(expr.left), DYN),
        type: BOOL,
        loc,
      } as IrExpr;
    if (leftType?.kind !== "array") return null;
    return {
      kind: "seqExpr",
      stmts: [{ kind: "exprStmt", expr: lowerer.lowerExpr(expr.left), loc }],
      result: { kind: "boolLit", value: true, type: BOOL, loc },
      type: BOOL,
      loc,
    };
  }
  const symbol = lowerer.resolveValueSymbol(expr.right);
  const decl = symbol?.valueDeclaration;
  let info: ClassInfo | null = null;
  if (decl !== undefined && ts.isClassLikeDeclaration(decl)) {
    info = arrayClassOfDecl(lowerer, decl);
  } else {
    // A binding that holds a class value (`const C = class extends Array
    // {}`): its static class, the only class it can hold while nothing
    // extends that class.
    const stored = storedClassValueType(lowerer, expr.right);
    const held = stored?.kind === "classval" ? lowerer.classes.get(stored.className) : undefined;
    if (held === undefined || arrayRootOf(held) === null) return null;
    if (held.subclasses.length > 0)
      lowerer.unsupported(
        "SC1090",
        expr,
        "'instanceof' against a binding holding a class that extends Array and has subclasses",
      );
    info = held;
  }
  if (info === null) return null;
  const value = lowerer.lowerExpr(expr.left);
  if (value.type.kind === "array")
    return { kind: "instanceOf", value, className: info.def.name, type: BOOL, loc };
  if (value.type.kind === "union") return arrayClassUnionInstanceOf(lowerer, value, info, loc);
  if (value.type.kind === "dyn")
    return {
      kind: "libCall",
      fn: "array.dynIsClass",
      args: [value, { kind: "strLit", value: info.def.name, type: STRING, loc }],
      type: BOOL,
      loc,
    };
  if (value.type.kind === "object" && value.type.className === info.def.name)
    return {
      kind: "seqExpr",
      stmts: [{ kind: "exprStmt", expr: value, loc }],
      result: { kind: "boolLit", value: true, type: BOOL, loc },
      type: BOOL,
      loc,
    };
  return null;
}

/** `x instanceof X` for a class X declared `extends Array` on a union (an
 * element read of an array of X instances is `X | undefined`): an array arm
 * tests the array's class at run time, a checked-dynamic arm asks the
 * runtime, and every other arm is no instance. */
function arrayClassUnionInstanceOf(
  lowerer: Lowerer,
  value: IrExpr,
  info: ClassInfo,
  loc: SrcLoc,
): IrExpr | null {
  if (value.type.kind !== "union") return null;
  const unionId = value.type.unionId;
  const arms = lowerer.unions.get(unionId)?.arms;
  if (arms === undefined) return null;
  const className = info.def.name;
  const key = `instanceof.arrayClass:${unionId}:${className}`;
  let helper = lowerer.valueHelpers.get(key);
  if (!helper) {
    helper = keyedHelperName(lowerer, "%instanceof.arrayClass", key);
    lowerer.valueHelpers.set(key, helper);
    const param: IrExpr = { kind: "varRef", localId: "value.0", type: value.type, loc };
    const body: IrStmt[] = [];
    arms.forEach((arm, tag) => {
      if (arm.kind !== "array" && arm.kind !== "dyn") return;
      const narrowed: IrExpr = { kind: "unionNarrow", unionId, tag, value: param, type: arm, loc };
      const test: IrExpr =
        arm.kind === "array"
          ? { kind: "instanceOf", value: narrowed, className, type: BOOL, loc }
          : {
              kind: "libCall",
              fn: "array.dynIsClass",
              args: [narrowed, { kind: "strLit", value: className, type: STRING, loc }],
              type: BOOL,
              loc,
            };
      body.push({
        kind: "if",
        cond: { kind: "unionIsTag", unionId, tag, negated: false, value: param, type: BOOL, loc },
        then: [{ kind: "return", value: test, loc }],
        else_: null,
        loc,
      });
    });
    body.push({ kind: "return", value: { kind: "boolLit", value: false, type: BOOL, loc }, loc });
    lowerer.liftedFns.push({
      name: helper,
      params: [{ localId: "value.0", name: "value", type: value.type }],
      returnType: BOOL,
      locals: [{ id: "value.0", name: "value", type: value.type, mutable: false }],
      body,
      loc,
    });
  }
  return { kind: "call", callee: helper, args: [value], type: BOOL, loc };
}

/** The class declared `extends Array` that a value of `type` is an instance
 * of, or null. */
export function arrayClassOfType(lowerer: Lowerer, type: ts.Type): ClassInfo | null {
  const decl = type.getSymbol()?.valueDeclaration;
  return decl !== undefined && ts.isClassLikeDeclaration(decl)
    ? arrayClassOfDecl(lowerer, decl)
    : null;
}

/** `x.constructor` on an instance of a class declared `extends Array`: the
 * class (the class has no subclasses, so the static type names it). */
export function lowerArrayClassConstructorRead(
  lowerer: Lowerer,
  access: ts.PropertyAccessExpression,
  loc: SrcLoc,
): IrExpr | null {
  if (access.name.text !== "constructor") return null;
  const info = arrayClassOfType(lowerer, lowerer.typeOf(access.expression));
  if (info === null) return null;
  const value = lowerer.lowerExpr(access.expression);
  const cls = lowerer.classValueRef(info, access);
  return {
    kind: "seqExpr",
    stmts: [{ kind: "exprStmt", expr: value, loc }],
    result: cls,
    type: cls.type,
    loc,
  };
}

/** `%C.arrayFields(a)`: the own fields of an instance of a class declared
 * `extends Array` as a dyn object, in declaration order (the descriptor's
 * `fields`, which util.inspect and Object.keys read). Fields whose type
 * has no dyn form are left out. Null when the class has no such field. */
export function arrayClassFieldsFn(lowerer: Lowerer, info: ClassInfo): IrFunction | null {
  const elem = arrayRootOf(info)!.extendsArray!.elem;
  const arrT = arrayOf(elem);
  const loc = info.def.loc;
  const fields = info.def.fields.filter(
    (f) => !f.name.startsWith("%") && !f.name.startsWith("#") && lowerer.dynConvertible(f.type),
  );
  if (fields.length === 0) return null;
  const name = `%${info.def.name}.arrayFields`;
  const self = (): IrExpr =>
    arrayClassView(info, { kind: "varRef", localId: "a.0", type: arrT, loc }, loc);
  const value: IrExpr = {
    kind: "dynObjLit",
    fields: fields.map((f) => ({
      key: { kind: "strLit", value: f.name, type: STRING, loc },
      value: lowerer.coerceToExpected(
        {
          kind: "fieldGet",
          obj: self(),
          className: info.def.name,
          field: f.name,
          type: f.type,
          loc,
        },
        DYN,
      ),
    })),
    type: DYN,
    loc,
  };
  return {
    name,
    params: [{ localId: "a.0", name: "a", type: arrT }],
    returnType: DYN,
    locals: [{ id: "a.0", name: "a", type: arrT, mutable: false }],
    body: [{ kind: "return", value, loc }],
    loc,
  };
}

/** `%C.species(n, withLength)`: `new C(n)`, or `new C()` without
 * `withLength`, as ArraySpeciesCreate, Array.of and Array.from call it (the
 * descriptor's `species`). Null when the constructor's parameters cannot
 * take those arguments: they must be none, a forwarding rest (dyn or
 * number), or a number first parameter whose others may be omitted (whose
 * no-argument form throws). */
/** A constructor parameter the species length argument can fill: a
 * number, a checked-dynamic value, or a union with a number arm
 * (`length?: number`). */
function takesLength(lowerer: Lowerer, type: IrType): boolean {
  if (type.kind === "f64" || type.kind === "dyn") return true;
  if (type.kind !== "union") return false;
  return lowerer.unions.get(type.unionId)?.arms.some((arm) => arm.kind === "f64") === true;
}

export function arrayClassSpeciesFn(lowerer: Lowerer, info: ClassInfo): IrFunction | null {
  const elem = arrayRootOf(info)!.extendsArray!.elem;
  const arrT = arrayOf(elem);
  const loc = info.def.loc;
  const n = (): IrExpr => ({ kind: "varRef", localId: "n.0", type: F64, loc });
  const params = info.ctorParams;
  // The constructor arguments with the length and without it (null: that
  // form throws a TypeError).
  let withLength: IrExpr[] | null = null;
  let without: IrExpr[] | null = null;
  if (params.length === 0) {
    withLength = [];
    without = [];
  } else if (params.length === 1 && params[0]!.mode === "dynRest") {
    withLength = [
      {
        kind: "dynArrLit",
        elems: [{ kind: "dynFrom", value: n(), type: DYN, loc }],
        type: DYN,
        loc,
      },
    ];
    without = [{ kind: "dynArrLit", elems: [], type: DYN, loc }];
  } else if (
    params.length === 1 &&
    params[0]!.mode === "rest" &&
    params[0]!.type.kind === "array" &&
    params[0]!.type.elem.kind === "f64"
  ) {
    withLength = [{ kind: "arrayLit", elems: [n()], type: params[0]!.type, loc } as IrExpr];
    without = [{ kind: "arrayLit", elems: [], type: params[0]!.type, loc } as IrExpr];
  } else if (
    (params[0]!.mode === "required" || params[0]!.mode === "omittable") &&
    takesLength(lowerer, params[0]!.type) &&
    params.slice(1).every((p) => p.mode === "omittable")
  ) {
    // An omitted argument is what a call without it passes: the
    // parameter's default, or undefined.
    const blame = info.decl ?? null;
    const omitted = (p: (typeof params)[number]): IrExpr =>
      p.callDefault ??
      (blame
        ? lowerer.undefinedArgFor(p.type, loc, blame)
        : lowerer.coerceToExpected(
            { kind: "unitLit", unit: "undefined", type: UNDEFINED_T, loc } as IrExpr,
            p.type,
          ));
    const rest = params.slice(1).map(omitted);
    // A dyn first parameter (a JavaScript `constructor(size)`) and an
    // optional or defaulted one take the length as a number, and their
    // omitted value in the no-argument form.
    if (params[0]!.type.kind === "dyn" || params[0]!.mode === "omittable")
      without = [
        params[0]!.type.kind === "dyn" ? dynUndefinedExpr(loc) : omitted(params[0]!),
        ...rest,
      ];
    withLength = [
      params[0]!.type.kind === "dyn"
        ? { kind: "dynFrom", value: n(), type: DYN, loc }
        : lowerer.coerceToExpected(n(), params[0]!.type),
      ...params.slice(1).map(omitted),
    ];
  }
  if (withLength === null) return null;
  const construct = (args: IrExpr[]): IrStmt => ({
    kind: "return",
    value: arrayOfClassInstance(
      info,
      {
        kind: "new",
        className: info.def.name,
        args,
        type: { kind: "object", className: info.def.name },
        loc,
      },
      loc,
    ),
    loc,
  });
  const unsupported: IrStmt = {
    kind: "exprStmt",
    expr: nodeThrowExpr(
      1,
      "",
      `constructing ${info.def.jsName ?? info.def.name} without arguments is not supported yet`,
      DYN,
      loc,
    ),
    loc,
  };
  return {
    name: `%${info.def.name}.species`,
    params: [
      { localId: "n.0", name: "n", type: F64 },
      { localId: "w.0", name: "withLength", type: BOOL },
    ],
    returnType: arrT,
    locals: [
      { id: "n.0", name: "n", type: F64, mutable: false },
      { id: "w.0", name: "withLength", type: BOOL, mutable: false },
    ],
    body: [
      {
        kind: "if",
        cond: { kind: "varRef", localId: "w.0", type: BOOL, loc },
        then: [construct(withLength)],
        else_: [without !== null ? construct(without) : unsupported],
        loc,
      },
    ],
    loc,
  };
}

/** Whether the program declares a class that extends Array. Array methods
 * consult species only then. */
export function programDeclaresArrayClass(lowerer: Lowerer): boolean {
  for (const info of lowerer.classes.values()) if (info.extendsArray) return true;
  return false;
}

/** The method names at least one class declared `extends Array` implements.
 * Node looks a method up on the receiver's prototype chain, so a call on an
 * array the checker types as a plain array can reach such a method when the
 * array is an instance; those calls dispatch on the receiver's class
 * (lowerWithArrayOverrideDispatch). Programs with no such method keep the
 * plain lowering, so their IR does not change. */
export function programOverriddenArrayMethods(lowerer: Lowerer): ReadonlySet<string> {
  const names = new Set<string>();
  for (const info of lowerer.classes.values()) {
    if (!info.extendsArray || info.decl === null) continue;
    for (const name of info.methods.keys()) {
      if (
        name.startsWith("get:") ||
        name.startsWith("set:") ||
        name.startsWith("#") ||
        name.startsWith("%")
      )
        continue;
      names.add(name);
    }
    for (const name of info.genericMethods?.keys() ?? []) names.add(name);
    // An own field with an Array method's name shadows the prototype method
    // on the instance, as a class field always does.
    for (const name of info.fields.keys()) {
      if (name.startsWith("#") || name.startsWith("%")) continue;
      names.add(name);
    }
  }
  return names;
}

/** The classes declared `extends Array` that implement `name`, in a stable
 * order: a base-typed call tests the receiver's class against each. A
 * generic method (`map<U>`) counts: it is the only way a TypeScript class
 * can override the generic Array methods. */
function arrayOverrideCandidates(lowerer: Lowerer, name: string): ClassInfo[] {
  const candidates: ClassInfo[] = [];
  for (const info of lowerer.classes.values()) {
    if (!info.extendsArray || info.decl === null) continue;
    const sig = info.methods.get(name);
    if (sig !== undefined && sig.abstract !== true) candidates.push(info);
    else if (info.genericMethods?.has(name)) candidates.push(info);
    else if (info.fields.has(name)) candidates.push(info);
  }
  return candidates.sort((a, b) => (a.def.name < b.def.name ? -1 : 1));
}

/** Why a direct call of `name` on `info` would bypass a prototype value the
 * program may have put there: a legacy decorator wraps it, or the program
 * reads, replaces or defines it on a class prototype. Null when the compiled
 * method is the only answer. */
function prototypeBypass(
  lowerer: Lowerer,
  info: ClassInfo,
  name: string,
): "decorated" | "replaced" | null {
  if (
    info.legacyMemberDecorations?.some((d) => !d.static && d.kind === "method" && d.name === name)
  )
    return "decorated";
  return lowerer.prototypeMethodAccesses.has(name) ? "replaced" : null;
}

/** Throws the named refusal for a prototype value a direct call would
 * bypass. */
function refusePrototypeBypass(
  lowerer: Lowerer,
  access: ts.PropertyAccessExpression,
  name: string,
  why: "decorated" | "replaced",
): never {
  return lowerer.unsupported(
    "SC1090",
    access,
    why === "decorated"
      ? `calling '${name}' on an array where a class that extends Array has a decorated '${name}' (Node calls the prototype's wrapped method; a compiled direct call would bypass the decorator)`
      : `calling '${name}' on an array where a class that extends Array's '${name}' is read, replaced or defined through its prototype (bind the receiver to the class's own type first)`,
  );
}

/** The call `name` on the class `info`'s own method, over the array `ref`
 * viewed as the class's instance. */
function arrayOverrideCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
  ref: IrExpr,
  info: ClassInfo,
  want: IrType,
): IrExpr | null {
  const name = access.name.text;
  const loc = locOf(call);
  const view = arrayClassView(info, ref, loc);
  const found = lowerer.findMethodOn(info, name);
  let direct: IrExpr;
  if (found === null && info.fields.has(name)) {
    // An own field shadowing the Array method: Node calls the field's value
    // (and throws its "is not a function" TypeError when it is not
    // callable), so the field is read off the class view and called with the
    // call's arguments.
    const fieldType = info.fields.get(name)!;
    const field: IrExpr = {
      kind: "fieldGet",
      obj: view,
      className: info.def.name,
      field: name,
      type: fieldType,
      loc,
    };
    if (fieldType.kind === "func") {
      const args = completeFuncValueArgs(lowerer, call, fieldType, loc);
      direct = {
        kind: "callValue",
        callee: field,
        receiver: lowerer.receiverFreeCallbackFields.has(name)
          ? undefined
          : lowerer.coerceToExpected(view, DYN),
        args,
        type: fieldType.ret,
        loc,
      } as IrExpr;
    } else
      // A field whose value is not a compiled function (an untyped slot, a
      // union, or data): Node calls whatever the field holds, which the
      // builtin signature cannot report. Refuse the call by name instead of
      // running the builtin.
      lowerer.unsupported(
        "SC1090",
        access,
        `calling '${name}' on an array where a class that extends Array declares a field named '${name}' that is not a compiled function (Node calls the field's value; the builtin would run instead)`,
      );
  } else if (found !== null && found.sig.abstract !== true) {
    // A legacy method decorator wraps the override on the prototype, and a
    // program that reads or replaces the method's prototype value may run
    // another function there. The direct call would bypass both, so the
    // base-typed call refuses instead of answering with the compiled body.
    const bypass =
      prototypeBypass(lowerer, info, name) ??
      (isClassCallback(lowerer, info, name) ? ("replaced" as const) : null);
    if (bypass !== null) refusePrototypeBypass(lowerer, access, name, bypass);
    const args = completeArgs(lowerer, call.arguments.nodes, found.sig.params, loc, call);
    lowerer.noteEdge(`%${found.declarer.def.name}.${name}`);
    direct = {
      kind: "call",
      callee: `%${found.declarer.def.name}.${name}`,
      args: [view, ...args],
      type: found.sig.ret,
      loc,
    };
  } else {
    // A generic override (`map<U>`): the only spelling TypeScript accepts
    // for the generic Array methods. It monomorphizes per call site like
    // every generic method.
    const generic = findGenericMethodOn(lowerer, info, name);
    if (generic === null) return null;
    // The same prototype rule as a non-generic override: a program that
    // reads, replaces or defines the method's prototype value may run
    // another function there, which a direct call would bypass. A generic
    // method is no entry in `methods`, so isClassCallback cannot see it.
    const bypass = prototypeBypass(lowerer, info, name);
    if (bypass !== null) refusePrototypeBypass(lowerer, access, name, bypass);
    direct = lowerClassGenericMethodCall(lowerer, call, access, info, generic, view, true);
  }
  return typeEquals(direct.type, want)
    ? direct
    : lowerer.coerceToExpected(direct, want, direct.type);
}

/** A call to an Array prototype method on an array the checker types as a
 * plain array (`const xs: number[] = instance; xs.push(1)`). Node finds the
 * method on the instance's prototype chain, so an instance of a class
 * declared `extends Array` that implements the method runs the class's
 * method; every other array keeps the builtin. The receiver is evaluated
 * once, the way a call evaluates it before its arguments, and only the
 * branch the receiver's class selects runs. Programs whose Array subclasses
 * implement none of the called names keep the plain lowering. */
export function lowerWithArrayOverrideDispatch(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
  lower: () => IrExpr | null,
): IrExpr | null {
  const name = access.name.text;
  if (!programOverriddenArrayMethods(lowerer).has(name)) return lower();
  const mapped = lowerer.mapTypeOf(lowerer.typeOf(access.expression));
  if (mapped?.kind !== "array") return lower();
  // Only a name the builtin lowering answers can be dispatched from:
  // a class member the array lowering does not know (`add`, `top`) is the
  // class path's call, which runs before this one.
  if (!arrayMethodLoweringName(call, name)) return lower();
  const candidates = arrayOverrideCandidates(lowerer, name);
  if (candidates.length === 0) return lower();
  const loc = locOf(call);
  const receiver = lowerer.lowerExpr(access.expression);
  const arrayType = receiver.type;
  if (arrayType.kind !== "array") return lower();
  // An instance has the class's element type: a string[] call never reaches a
  // class that extends Array<number>.
  const matching = candidates.filter((info) => {
    const elem = arrayRootOf(info)?.extendsArray?.elem;
    return elem !== undefined && typeEquals(elem, arrayType.elem);
  });
  if (matching.length === 0) return lower();
  const local = lowerer.declareHiddenLocal("%arrayBaseReceiver", receiver.type);
  const ref: IrExpr = { kind: "varRef", localId: local.id, type: receiver.type, loc };
  const builtin = lowerer.withExpressionOverride(access.expression, ref, lower);
  if (builtin === null) return null;
  const branches: IrExpr[] = [];
  const tests: ClassInfo[] = [];
  for (const info of matching) {
    const branch = arrayOverrideCall(lowerer, call, access, ref, info, builtin.type);
    if (branch === null) continue;
    branches.push(branch);
    tests.push(info);
  }
  if (builtin.type.kind === "void") {
    // A method that returns nothing has no value to select between: the
    // class test becomes control flow, and the call's value is the empty
    // function's.
    let otherwise: IrStmt[] = [{ kind: "exprStmt", expr: builtin, loc }];
    for (let i = branches.length - 1; i >= 0; i--)
      otherwise = [
        {
          kind: "if",
          cond: { kind: "instanceOf", value: ref, className: tests[i]!.def.name, type: BOOL, loc },
          then: [{ kind: "exprStmt", expr: branches[i]!, loc }],
          else_: otherwise,
          loc,
        },
      ];
    return {
      kind: "seqExpr",
      stmts: [{ kind: "varDecl", localId: local.id, init: receiver, loc }, ...otherwise],
      result: { kind: "call", callee: arrayVoidHelper(lowerer, loc), args: [], type: VOID, loc },
      type: VOID,
      loc,
    };
  }
  let result: IrExpr = builtin;
  for (let i = branches.length - 1; i >= 0; i--) {
    result = {
      kind: "ternary",
      cond: { kind: "instanceOf", value: ref, className: tests[i]!.def.name, type: BOOL, loc },
      then: branches[i]!,
      else_: result,
      type: builtin.type,
      loc,
    };
  }
  return {
    kind: "seqExpr",
    stmts: [{ kind: "varDecl", localId: local.id, init: receiver, loc }],
    result,
    type: builtin.type,
    loc,
  };
}

/** Whether lowerArrayMethodCall answers the call `name(...)` (the names it
 * lowers, plus the iterator spellings it takes without arguments). */
function arrayMethodLoweringName(call: ts.CallExpression, name: string): boolean {
  if (ARRAY_METHODS.has(name) || name === "sort" || name === "shift" || name === "splice")
    return true;
  return (
    (name === "values" || name === "keys" || name === "entries") &&
    call.arguments.nodes.length === 0
  );
}

/** The empty function an override dispatch over a void method calls for
 * its value (`forEach` returns nothing). */
function arrayVoidHelper(lowerer: Lowerer, loc: SrcLoc): string {
  const name = "%arrayDispatchVoid";
  if (lowerer.liftedFnNamed(name) === undefined)
    lowerer.liftedFns.push({ name, params: [], returnType: VOID, locals: [], body: [], loc });
  return name;
}

/** The Array methods that create their result through ArraySpeciesCreate:
 * whether the species constructor receives the result's length (map,
 * slice, splice; the others pass 0), whether the length is set after the
 * elements are defined (slice, splice, concat), and whether the method
 * calls back into the program (map, filter, flatMap), which it does after
 * the species constructor ran. */
const SPECIES_METHODS: ReadonlyMap<
  string,
  { resultLength: boolean; setLength: boolean; callback: boolean }
> = new Map([
  ["map", { resultLength: true, setLength: false, callback: true }],
  ["filter", { resultLength: false, setLength: false, callback: true }],
  ["slice", { resultLength: true, setLength: true, callback: false }],
  ["splice", { resultLength: true, setLength: true, callback: false }],
  ["concat", { resultLength: false, setLength: true, callback: false }],
  ["flat", { resultLength: false, setLength: false, callback: false }],
  ["flatMap", { resultLength: false, setLength: false, callback: true }],
]);

/** An Array method call whose result an Array subclass instance creates
 * through its species (scr_arr_species_adopt): the receiver is evaluated
 * once into a hidden local that the method's lowering reads, and the
 * method's plain result passes through the species constructor when the
 * receiver is a subclass instance. Programs that declare no Array subclass
 * keep the plain lowering. */
export function lowerWithArraySpecies(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
  lower: () => IrExpr | null,
): IrExpr | null {
  const mode = SPECIES_METHODS.get(access.name.text);
  if (mode === undefined || !programDeclaresArrayClass(lowerer)) return lower();
  const receiverType = lowerer.mapTypeOf(lowerer.typeOf(access.expression));
  if (receiverType?.kind !== "array") return lower();
  const loc = locOf(call);
  const receiver = lowerer.lowerExpr(access.expression);
  if (receiver.type.kind !== "array") return lower();
  const local = lowerer.declareHiddenLocal("%speciesReceiver", receiver.type);
  const key = withoutParenthesesTypeWrappers(access.expression);
  lowerer.stagedArguments.set(key, { localId: local.id, type: receiver.type });
  let result: IrExpr | null;
  try {
    result = lower();
  } finally {
    lowerer.stagedArguments.delete(key);
  }
  if (result === null) return result;
  if (result.type.kind !== "array")
    // The method lowered through the receiver's checked-dynamic view, not
    // into an array of its own: no species instance is created, but the
    // receiver was staged above and must still be evaluated once, in
    // source order, before the result.
    return {
      kind: "seqExpr",
      stmts: [{ kind: "varDecl", localId: local.id, init: receiver, loc }],
      result,
      type: result.type,
      loc,
    };
  const receiverRef: IrExpr = { kind: "varRef", localId: local.id, type: receiver.type, loc };
  if (mode.callback) {
    // The species constructor runs before the first callback: the
    // arguments are evaluated in order, the receiver's length is read, the
    // instance is created (with that length for map, 0 otherwise), then
    // the method runs to that length and its elements move into the
    // instance.
    const stmts: IrStmt[] = [{ kind: "varDecl", localId: local.id, init: receiver, loc }];
    let bound: IrLocal | undefined;
    const rebound = rebuildSpeciesCall(result, local.id, (inner) => {
      const args: IrExpr[] = [receiverRef];
      for (const arg of inner.args.slice(1)) {
        const held = lowerer.declareHiddenLocal("%speciesArgument", arg.type);
        stmts.push({ kind: "varDecl", localId: held.id, init: arg, loc });
        args.push({ kind: "varRef", localId: held.id, type: arg.type, loc });
      }
      const length = lowerer.declareHiddenLocal("%speciesLength", F64);
      bound = length;
      args.push({ kind: "varRef", localId: length.id, type: F64, loc });
      const helper = boundedArrayHofHelper(lowerer, inner.callee);
      return helper === null ? null : { ...inner, callee: helper, args };
    });
    if (rebound === null || bound === undefined)
      lowerer.unsupported(
        "SC1090",
        call,
        `'${access.name.text}' in this form when the program declares a class that extends Array`,
      );
    stmts.push({
      kind: "varDecl",
      localId: bound.id,
      init: {
        kind: "arrIntrinsic",
        method: "length",
        receiver: receiverRef,
        args: [],
        type: F64,
        loc,
      },
      loc,
    });
    const boundRef: IrExpr = { kind: "varRef", localId: bound.id, type: F64, loc };
    const instance = lowerer.declareHiddenLocal("%speciesInstance", receiver.type);
    const length: IrExpr = mode.resultLength
      ? boundRef
      : { kind: "numLit", value: 0, type: F64, loc };
    stmts.push({
      kind: "varDecl",
      localId: instance.id,
      init: {
        kind: "libCall",
        fn: "array.speciesCreate",
        args: [receiverRef, length],
        type: receiver.type,
        loc,
      },
      loc,
    });
    return {
      kind: "seqExpr",
      stmts,
      result: {
        kind: "libCall",
        fn: "array.speciesFinish",
        args: [
          { kind: "varRef", localId: instance.id, type: receiver.type, loc },
          rebound,
          { kind: "boolLit", value: mode.setLength, type: BOOL, loc },
        ],
        type: result.type,
        loc,
      },
      type: result.type,
      loc,
    };
  }
  return {
    kind: "seqExpr",
    stmts: [{ kind: "varDecl", localId: local.id, init: receiver, loc }],
    result: {
      kind: "libCall",
      fn: "array.speciesAdopt",
      args: [
        receiverRef,
        result,
        { kind: "numLit", value: mode.resultLength ? -1 : 0, type: F64, loc },
        { kind: "boolLit", value: mode.setLength, type: BOOL, loc },
      ],
      type: result.type,
      loc,
    },
    type: result.type,
    loc,
  };
}

/** `e` with the `%arr.<method>` helper call over `receiverLocal` rebuilt by
 * `rebuild`, or null when `e` holds no such call. The helper call is the
 * one taking the receiver as its first argument; a filter whose callback
 * narrows converts the filtered array after the helper ran, so the call
 * can sit behind a wrapper (the checked-narrowing call), which this
 * rebuild leaves in place. */
function rebuildSpeciesCall(
  e: IrExpr,
  receiverLocal: string,
  rebuild: (inner: IrExpr & { kind: "call" }) => IrExpr | null,
): IrExpr | null {
  if (e.kind !== "call") return null;
  const first = e.args[0];
  if (first !== undefined && first.kind === "varRef" && first.localId === receiverLocal)
    return rebuild(e);
  for (let i = 0; i < e.args.length; i++) {
    const replaced = rebuildSpeciesCall(e.args[i]!, receiverLocal, rebuild);
    if (replaced === null) continue;
    const args = e.args.slice();
    args[i] = replaced;
    return { ...e, args };
  }
  return null;
}

/** `C.of(...items)` and `C.from(iterable)` on a class declared `extends
 * Array` that declares neither: Array.of / Array.from's elements, in an
 * instance the class constructs (`new C(items.length)` for of, `new C()`
 * for an iterable's from), as Node's inherited statics do. */
export function lowerArrayClassStaticCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  const name = access.name.text;
  if (name !== "of" && name !== "from") return null;
  if (!ts.isIdentifier(access.expression)) return null;
  const symbol = lowerer.resolveValueSymbol(access.expression);
  const decl = symbol?.valueDeclaration;
  if (decl === undefined || !ts.isClassLikeDeclaration(decl)) return null;
  const info = arrayClassOfDecl(lowerer, decl);
  if (info === null || lowerer.findStaticOn(info, name)) return null;
  const loc = locOf(call);
  const args = call.arguments.nodes;
  let ctorLength: number;
  if (name === "of") {
    if (args.some(ts.isSpreadElement))
      lowerer.unsupported("SC1090", call, "spreading arguments into Array.of on an Array subclass");
    ctorLength = args.length;
  } else {
    const source = args[0] ? lowerer.mapTypeOf(lowerer.typeOf(args[0])) : null;
    if (
      source?.kind !== "array" &&
      source?.kind !== "string" &&
      source?.kind !== "set" &&
      source?.kind !== "map"
    )
      lowerer.unsupported(
        "SC1090",
        call,
        "Array.from on an Array subclass over a value that is not an array, string, Set or Map",
      );
    ctorLength = -1;
  }
  const plain =
    name === "of"
      ? lowerArrayOfCall(lowerer, call, access, true)
      : lowerArrayFromCall(lowerer, call, access, true);
  if (plain === null || plain.type.kind !== "array") return plain;
  return {
    kind: "libCall",
    fn: "array.classConstructAdopt",
    args: [
      { kind: "strLit", value: info.def.name, type: STRING, loc },
      plain,
      { kind: "numLit", value: ctorLength, type: F64, loc },
    ],
    type: plain.type,
    loc,
  };
}

/** A class declared `extends Array` that defines `static [Symbol.species]`
 * (Node would construct method results through that constructor). */
export function refuseArrayClassSpecies(lowerer: Lowerer, decl: ts.ClassLikeDeclaration): void {
  for (const member of decl.members.nodes) {
    const name = member.name;
    if (
      name !== undefined &&
      ts.isComputedPropertyName(name) &&
      ts.isPropertyAccessExpression(name.expression) &&
      name.expression.name.text === "species" &&
      ts.isIdentifier(name.expression.expression) &&
      name.expression.expression.text === "Symbol"
    )
      lowerer.unsupported(
        "SC1090",
        member,
        "Symbol.species on a class that extends Array (its methods' results construct the class itself)",
      );
  }
}
