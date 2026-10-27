/* Classes declared `extends Array`. An instance is an array of the class's
 * element type: its struct begins with the runtime's array header (the
 * reference count is the array's) and the class's own fields follow it, so
 * every array operation applies to the instance unchanged and passing it
 * where a plain array is expected passes the same object. The class's
 * TypeScript type maps to its element array type; the class's own members,
 * construction and `instanceof` view the array as the class object
 * (arrayClassView). */
import * as ts from "../../ts7/adapter.js";
import { type Lowerer } from "../lowerer.js";
import { isJsSourceFile, locOf } from "../../program.js";
import { stripTypeWrappers } from "../typed-arguments.js";
import { keyedHelperName } from "../stable-names.js";
import { dynUndefinedExpr, nodeThrowExpr } from "../../../ir/build.js";
import { lowerArrayFromCall, lowerArrayOfCall } from "../containers/array-construction.js";
import { boundedArrayHofHelper } from "../containers/array-callbacks.js";
import { storedClassValueType, type ClassInfo } from "../lower-classes.js";
import {
  BOOL,
  DYN,
  F64,
  STRING,
  UNDEFINED_T,
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
 * type, narrowed back to the class by `instanceof`) is refused. */
export function arrayClassReceiver(
  lowerer: Lowerer,
  info: ClassInfo,
  value: IrExpr,
  node: ts.Node,
): IrExpr {
  if (value.type.kind !== "array") return value;
  const root = arrayRootOf(info);
  if (root?.extendsArray === undefined || !typeEquals(value.type.elem, root.extendsArray.elem))
    lowerer.unsupported(
      "SC1090",
      node,
      "members of an Array subclass on an array whose elements are another type (a species result narrowed back to the class)",
    );
  return arrayClassView(info, value, locOf(node));
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
  const key = stripTypeWrappers(access.expression);
  lowerer.stagedArguments.set(key, { localId: local.id, type: receiver.type });
  let result: IrExpr | null;
  try {
    result = lower();
  } finally {
    lowerer.stagedArguments.delete(key);
  }
  if (result === null || result.type.kind !== "array") return result;
  const receiverRef: IrExpr = { kind: "varRef", localId: local.id, type: receiver.type, loc };
  if (mode.callback) {
    // The species constructor runs before the first callback: the
    // arguments are evaluated in order, the receiver's length is read, the
    // instance is created (with that length for map, 0 otherwise), then
    // the method runs to that length and its elements move into the
    // instance.
    const bounded =
      result.kind === "call" &&
      result.args[0]?.kind === "varRef" &&
      result.args[0].localId === local.id
        ? boundedArrayHofHelper(lowerer, result.callee)
        : null;
    if (bounded === null || result.kind !== "call")
      lowerer.unsupported(
        "SC1090",
        call,
        `'${access.name.text}' in this form when the program declares a class that extends Array`,
      );
    const stmts: IrStmt[] = [{ kind: "varDecl", localId: local.id, init: receiver, loc }];
    const args: IrExpr[] = [receiverRef];
    for (const arg of result.args.slice(1)) {
      const held = lowerer.declareHiddenLocal("%speciesArgument", arg.type);
      stmts.push({ kind: "varDecl", localId: held.id, init: arg, loc });
      args.push({ kind: "varRef", localId: held.id, type: arg.type, loc });
    }
    const bound = lowerer.declareHiddenLocal("%speciesLength", F64);
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
    args.push(boundRef);
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
          { ...result, callee: bounded, args },
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
