import { strLit, varRef } from "../../ir/build.js";
import {
  BOOL,
  DATE_T,
  DYN,
  F64,
  STRING,
  VOID,
  typeKey,
  type IrExpr,
  type IrStmt,
  type IrType,
  type SrcLoc,
} from "../../ir/ir.js";
import * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js";
import { accessorCall, findMethodOn, type ClassInfo } from "./lower-classes.js";
import type { ParamShape } from "./call-signatures.js";
import { omittedArgFor } from "./call-arguments.js";
import { isClassCallback, methodsUnreplaced } from "./class-callbacks.js";
import { classPrototypeData } from "./class-prototypes.js";
import { TO_STRING_TAG_FIELD } from "./symbol-fields.js";
import { isSafeToRepeat } from "./expressions/evaluation-safety.js";
import { DATE_TIME_FIELD, dateRootOf } from "./builtins/date-classes.js";
import { dateValueMethod } from "./builtins/dates.js";
import { concatOperand } from "./lower-exprs.js";
import { keyedHelperName } from "./stable-names.js";

/** The ToPrimitive hint of a conversion: `String(x)` and template literals
 * take "string", `+` "default", `Number(x)` "number". */
export type ConversionHint = "string" | "default" | "number";
export type StringConversionHint = "string" | "default";

type ConversionMethod = "sym:toPrimitive" | "valueOf" | "toString";

/** How an instance of one class converts: through one of its methods,
 * through the Date.prototype method `date` of a class declared `extends
 * Date`, or through Object.prototype.toString ("[object Object]"). */
type Plan =
  | { method: ConversionMethod; ret: IrType }
  | { method: null; date?: "toString" | "valueOf"; tag?: ToStringTag };

/** Where Object.prototype.toString finds a class's Symbol.toStringTag: a
 * string field (`[Symbol.toStringTag] = "LRUCache"`) or a getter that
 * returns a string, declared on `owner`. */
interface ToStringTag {
  owner: ClassInfo;
  getter: boolean;
}

const PRIMITIVE_KINDS = new Set(["f64", "string", "bool", "bigint", "undefinedT", "nullT"]);
const OBJECT_ARMS_TO_STRING = new Set(["url", "bytes", "date", "regex"]);

/** ToString(ToPrimitive(value, hint)) of a program class instance, as Node
 * computes it: `[Symbol.toPrimitive](hint)` when the class defines it, then
 * `toString` (hint "string") or `valueOf` and then `toString` (hint
 * "default"), and "[object Object]" when the class defines neither. The
 * methods dispatch like calls of them; subclasses that convert through a
 * different method are tested first. Null for values whose class is not a
 * plain program class (builtin classes and their subclasses keep their own
 * conversions). */
export function classToStringConversion(
  lowerer: Lowerer,
  value: IrExpr,
  hint: StringConversionHint,
  node: ts.Node,
): IrExpr | null {
  return classConversion(lowerer, value, hint, node, STRING, (primitive) =>
    lowerer.ensureString(primitive, node),
  );
}

/** Object.prototype.toString of a program class instance: "[object " +
 * its Symbol.toStringTag + "]" (an own tag field, else an inherited
 * getter), or "[object Object]". The class's own conversion methods do not
 * take part. Null as for classToStringConversion, and for Date subclasses. */
export function classObjectTag(lowerer: Lowerer, value: IrExpr, node: ts.Node): IrExpr | null {
  if (value.type.kind !== "object") return null;
  const info = lowerer.classes.get(value.type.className);
  if (!info || dateRootOf(info) !== null) return null;
  return classConversion(lowerer, value, "tag", node, STRING, (tag) => tag);
}

/** ToNumber(ToPrimitive(value, "number")) of a program class instance
 * (`Number(x)`): `[Symbol.toPrimitive]("number")`, then `valueOf` and then
 * `toString`, and NaN for "[object Object]". Null as for
 * classToStringConversion. */
export function classToNumberConversion(
  lowerer: Lowerer,
  value: IrExpr,
  node: ts.Node,
  operator: "Number" | "unary plus" = "Number",
): IrExpr | null {
  return classConversion(
    lowerer,
    value,
    "number",
    node,
    F64,
    (primitive) => numberOfPrimitive(lowerer, primitive, node, operator),
    operator,
  );
}

/** ToNumber of a primitive value: `Number(primitive)`, or unary plus,
 * which throws for a BigInt instead of converting it. */
function numberOfPrimitive(
  lowerer: Lowerer,
  value: IrExpr,
  node: ts.Node,
  operator: "Number" | "unary plus",
): IrExpr {
  const loc = value.loc;
  if (operator === "unary plus" && mayBeBigint(lowerer, value.type))
    lowerer.unsupported(
      "SC1090",
      node,
      "unary plus of class instances whose conversion can return a bigint",
    );
  switch (value.type.kind) {
    case "f64":
      return value;
    case "string":
      return { kind: "libCall", fn: "num.fromString", args: [value], type: F64, loc };
    case "bool":
      return {
        kind: "ternary",
        cond: value,
        then: { kind: "numLit", value: 1, type: F64, loc },
        else_: { kind: "numLit", value: 0, type: F64, loc },
        type: F64,
        loc,
      };
    case "bigint":
      return { kind: "libCall", fn: "bigint.toF64", args: [value], type: F64, loc };
    default:
      if (!lowerer.dynConvertible(value.type))
        lowerer.unsupported("SC1090", node, "number conversions of this class's primitive value");
      return {
        kind: "libCall",
        fn: "dyn.numberConstructor",
        args: [lowerer.coerceToExpected(value, DYN)],
        type: F64,
        loc,
      };
  }
}

function mayBeBigint(lowerer: Lowerer, type: IrType): boolean {
  if (type.kind === "bigint") return true;
  return (
    type.kind === "union" &&
    lowerer.unions.get(type.unionId)?.arms.some((arm) => arm.kind === "bigint") === true
  );
}

function classConversion(
  lowerer: Lowerer,
  value: IrExpr,
  hint: ConversionHint | "tag",
  node: ts.Node,
  resultType: IrType,
  finish: (primitive: IrExpr) => IrExpr,
  operator: "Number" | "unary plus" = "Number",
): IrExpr | null {
  if (value.type.kind !== "object") return null;
  const info = lowerer.classes.get(value.type.className);
  if (!info || !plainProgramClass(info)) return null;
  const classes = subtree(lowerer, info);
  if (hint !== "tag") {
    // A conversion method the program may replace at run time (an own
    // property an unbounded write may store, a prototype write) converts
    // through the declared methods while the instance's methods are still
    // the declared ones, and through the runtime's conversion otherwise.
    // Every class is judged: one with a field of a conversion method's name
    // is refused whatever its relatives' methods are.
    const replaceable = classes.map((cls) => replacedConversion(lowerer, cls, node)).includes(true);
    if (replaceable)
      return guardedConversion(lowerer, value, hint, node, resultType, finish, info, operator);
  }
  return plannedConversion(lowerer, value, hint, node, resultType, finish, info, classes);
}

/** classConversion behind the exact test that no method of the instance
 * was replaced (methodsUnreplaced): its own property table is still absent
 * and no prototype object of its class family exists. Otherwise the
 * instance converts as a checked-dynamic value, whose view holds its own
 * properties and its classes' prototype data, so ToPrimitive finds the
 * methods JavaScript would. */
function guardedConversion(
  lowerer: Lowerer,
  value: IrExpr,
  hint: ConversionHint,
  node: ts.Node,
  resultType: IrType,
  finish: (primitive: IrExpr) => IrExpr,
  info: ClassInfo,
  operator: "Number" | "unary plus",
): IrExpr {
  const loc = value.loc;
  const local = lowerer.declareHiddenLocal("%converted", value.type);
  const receiver = varRef(local.id, value.type, loc);
  const unreplaced = methodsUnreplaced(lowerer, receiver, info, loc);
  const classes = subtree(lowerer, info);
  if (unreplaced === null) {
    for (const cls of classes) refuseReplacedConversions(lowerer, cls, node);
    return plannedConversion(lowerer, value, hint, node, resultType, finish, info, classes);
  }
  for (const cls of classes) classPrototypeData(lowerer, cls, loc, receiver);
  const declaredPath = plannedConversion(
    lowerer,
    receiver,
    hint,
    node,
    resultType,
    finish,
    info,
    classes,
  );
  const boxed = lowerer.coerceToExpected(receiver, DYN);
  const primitive: IrExpr =
    hint === "number"
      ? // Number() converts a BigInt the conversion answers; unary plus
        // throws Node's TypeError for it (ToNumber).
        {
          kind: "libCall",
          fn: operator === "unary plus" ? "dyn.toNumberCoerce" : "dyn.numberConstructor",
          args: [boxed],
          type: F64,
          loc,
        }
      : hint === "default"
        ? // `+` takes ToPrimitive's default hint: the runtime's addition of
          // the empty string and the value computes exactly that.
          {
            kind: "libCall",
            fn: "dyn.add",
            args: [{ kind: "dynFrom", value: strLit("", loc), type: DYN, loc }, boxed],
            type: DYN,
            loc,
          }
        : boxed;
  const runtimePath =
    hint === "number"
      ? finish(primitive)
      : lowerer.coerceToExpected(lowerer.ensureString(primitive, node), resultType);
  return {
    kind: "seqExpr",
    stmts: [{ kind: "varDecl", localId: local.id, init: value, loc }],
    result: {
      kind: "ternary",
      cond: unreplaced,
      then: declaredPath,
      else_: runtimePath,
      type: resultType,
      loc,
    },
    type: resultType,
    loc,
  };
}

function plannedConversion(
  lowerer: Lowerer,
  value: IrExpr,
  hint: ConversionHint | "tag",
  node: ts.Node,
  resultType: IrType,
  finish: (primitive: IrExpr) => IrExpr,
  info: ClassInfo,
  classes: ClassInfo[],
): IrExpr {
  const plans = new Map(classes.map((cls) => [cls, planOf(lowerer, cls, hint, node)]));
  // A class whose plan differs from its base's starts a group; the deepest
  // groups are tested first, so each instance takes its own class's plan.
  const tops = classes
    .filter((cls) => {
      if (cls === info) return false;
      const base = cls.base;
      return base !== null && plans.has(base) && !samePlan(plans.get(base)!, plans.get(cls)!);
    })
    .sort((a, b) => depth(b) - depth(a));
  const loc = value.loc;
  const prefix: IrStmt[] = [];
  let receiver = value;
  if (tops.length > 0 && !isSafeToRepeat(value)) {
    const local = lowerer.declareHiddenLocal("%converted", value.type);
    prefix.push({ kind: "varDecl", localId: local.id, init: value, loc });
    receiver = varRef(local.id, value.type, loc);
  }
  const convert = (cls: ClassInfo, object: IrExpr): IrExpr => {
    const plan = plans.get(cls)!;
    if (plan.method === null && plan.date) {
      const root = dateRootOf(cls)!;
      const time: IrExpr = {
        kind: "fieldGet",
        obj: lowerer.upcastTo(object, root.def.name),
        className: root.def.name,
        field: DATE_TIME_FIELD,
        type: DATE_T,
        loc,
      };
      return finish(dateValueMethod(plan.date, time, loc)!);
    }
    if (plan.method === null && plan.tag) {
      // Object.prototype.toString: "[object " + the tag + "]".
      const owner = plan.tag.owner.def.name;
      const tag: IrExpr = plan.tag.getter
        ? accessorCall(
            lowerer,
            owner,
            "get:sym:toStringTag",
            lowerer.upcastTo(object, owner),
            [],
            STRING,
            loc,
          )
        : {
            kind: "fieldGet",
            obj: lowerer.upcastTo(object, owner),
            className: owner,
            field: TO_STRING_TAG_FIELD,
            type: STRING,
            loc,
          };
      return finish({
        kind: "strConcat",
        left: {
          kind: "strConcat",
          left: { kind: "strLit", value: "[object ", type: STRING, loc },
          right: tag,
          type: STRING,
          loc,
        },
        right: { kind: "strLit", value: "]", type: STRING, loc },
        type: STRING,
        loc,
      });
    }
    if (plan.method === null)
      return finish({ kind: "strLit", value: "[object Object]", type: STRING, loc });
    const args: IrExpr[] =
      plan.method === "sym:toPrimitive" ? [{ kind: "strLit", value: hint, type: STRING, loc }] : [];
    return finish(accessorCall(lowerer, cls.def.name, plan.method, object, args, plan.ret, loc));
  };
  // "[object Object]" reads nothing of the instance, but the receiver
  // expression still runs, once.
  const own = plans.get(info)!;
  if (tops.length === 0 && own.method === null && !own.date && !own.tag && !isSafeToRepeat(value))
    prefix.push({ kind: "exprStmt", expr: value, loc });
  let result = convert(info, receiver);
  for (let i = tops.length - 1; i >= 0; i--) {
    const top = tops[i]!;
    const narrowed: IrExpr = {
      kind: "downcast",
      value: receiver,
      type: { kind: "object", className: top.def.name },
      loc,
    };
    result = {
      kind: "ternary",
      cond: { kind: "instanceOf", value: receiver, className: top.def.name, type: BOOL, loc },
      then: convert(top, narrowed),
      else_: result,
      type: resultType,
      loc,
    };
  }
  return prefix.length > 0
    ? { kind: "seqExpr", stmts: prefix, result, type: resultType, loc }
    : result;
}

/** The conversion method an instance of `info` runs where the value is
 * untyped (String(value), a template, a property key, `%s`): a declared
 * [Symbol.toPrimitive], called with "string", else a declared toString —
 * the order classConversion takes for the "string" hint. Null when the
 * class declares neither, and for the shapes the untyped conversion cannot
 * run faithfully: a method the program can replace at run time (an
 * instance field, a callback member or a prototype write), an abstract
 * method with no implementation below (the direct call refuses it), and a
 * conversion Node calls without arguments but the compiled method needs
 * them. Those keep the runtime's refusal by name. A declared answer that
 * is not a primitive registers too: the runtime throws Node's TypeError
 * when the conversion produces it. */
export function classStringMethod(
  lowerer: Lowerer,
  info: ClassInfo,
  loc: SrcLoc,
): {
  method: "sym:toPrimitive" | "toString";
  ret: IrType;
  params: ParamShape[];
} | null {
  const exotic = declared(lowerer, info, "sym:toPrimitive");
  const to = exotic ?? declared(lowerer, info, "toString");
  const method = exotic ? "sym:toPrimitive" : "toString";
  if (!to) return null;
  if (!exotic) {
    if (info.fields.has("toString") || isClassCallback(lowerer, info, "toString")) return null;
    if (lowerer.prototypeMethodAccesses.has("toString")) return null;
  }
  const found = findMethodOn(lowerer, info, method)!;
  // A builtin base's conversion (Error.prototype.toString, Array's) is the
  // runtime's, not a compiled method: the runtime's own paths answer it.
  if (found.declarer.def.runtime) return null;
  if (found.sig.abstract === true && !lowerer.overrideBelow(info, method)) return null;
  const params = found.sig.params;
  // The conversion calls the method the way Node does: the hint and no
  // other argument. A declared parameter past the hint must have an absent
  // spelling (an optional or defaulted parameter); a required one, a rest
  // one, or the hidden `arguments` slot would need an argument Node does
  // not pass, so the class keeps the runtime's refusal.
  const supplied = method === "sym:toPrimitive" && params.length > 0 ? 1 : 0;
  if (supplied === 1 && params[0]!.mode !== "required" && params[0]!.mode !== "omittable")
    return null;
  for (let i = supplied; i < params.length; i++) {
    const param = params[i]!;
    if (param.mode !== "omittable" || omittedArgFor(lowerer, param.type, loc) === null) return null;
  }
  return { method, ret: to.ret, params };
}

/** `%util.clsString.<n>(self): dyn` — the class's conversion method over a
 * checked instance, its primitive answer boxed. The runtime calls it when a
 * conversion meets an instance of the class among an untyped value
 * (scr_dyn_typed_ref_string_view). */
function classToStringDynHelper(
  lowerer: Lowerer,
  t: IrType & { kind: "object" },
  method: "sym:toPrimitive" | "toString",
  ret: IrType,
  params: ParamShape[],
  loc: SrcLoc,
): string {
  const name = keyedHelperName(lowerer, "%util.clsString", typeKey(t));
  const args: IrExpr[] = [];
  if (method === "sym:toPrimitive" && params.length > 0) {
    args.push(lowerer.coerceToExpected(strLit("string", loc), params[0]!.type));
  }
  for (let i = args.length; i < params.length; i++) {
    args.push(omittedArgFor(lowerer, params[i]!.type, loc)!);
  }
  const call = accessorCall(lowerer, t.className, method, varRef("v.0", t, loc), args, ret, loc);
  const body: IrStmt[] = [
    {
      kind: "varDecl",
      localId: "v.0",
      init: lowerer.coerceToExpected(varRef("self.0", DYN, loc), t),
      loc,
    },
    { kind: "return", value: lowerer.coerceToExpected(call, DYN), loc },
  ];
  lowerer.liftedFns.push({
    name,
    params: [{ localId: "self.0", name: "self", type: DYN }],
    returnType: DYN,
    locals: [
      { id: "self.0", name: "self", type: DYN, mutable: false },
      { id: "v.0", name: "v", type: t, mutable: false },
    ],
    body,
    loc,
  });
  return name;
}

/** The statements %main runs first, in every thread: each class whose
 * instances the program can construct and whose conversion the untyped
 * path cannot otherwise run registers its compiled String(instance) under
 * its instances' typed-ref type key (scr_dyn_register_class_to_string). */
export function classToStringRegistrations(lowerer: Lowerer, loc: SrcLoc): IrStmt[] {
  const stmts: IrStmt[] = [];
  for (const info of lowerer.classes.values()) {
    if (info.def.runtime || info.def.abstract) continue;
    const plan = classStringMethod(lowerer, info, loc);
    if (!plan) continue;
    const t = { kind: "object" as const, className: info.def.name };
    const fn = classToStringDynHelper(lowerer, t, plan.method, plan.ret, plan.params, loc);
    stmts.push({
      kind: "exprStmt",
      expr: {
        kind: "libCall",
        fn: "dyn.registerClassToString",
        args: [
          strLit(typeKey(t), loc),
          {
            kind: "dynFrom",
            value: {
              kind: "closure",
              fnName: fn,
              captures: [],
              type: { kind: "func", params: [DYN], ret: DYN },
              loc,
            },
            type: DYN,
            loc,
          },
        ],
        type: VOID,
        loc,
      },
      loc,
    });
  }
  return stmts;
}

/** A class of the program whose chain reaches no builtin base: its
 * instances inherit Object.prototype's conversions. */
function plainProgramClass(info: ClassInfo): boolean {
  for (let cls: ClassInfo | null = info; cls; cls = cls.base) {
    if (
      cls.def.runtime ||
      cls.builtinError ||
      cls.builtinEmitter ||
      cls.builtinStream ||
      cls.callableBase !== undefined
    )
      return false;
  }
  return true;
}

function subtree(lowerer: Lowerer, info: ClassInfo): ClassInfo[] {
  const out: ClassInfo[] = [];
  const visit = (cls: ClassInfo): void => {
    out.push(cls);
    for (const child of cls.subclasses) visit(child);
  };
  visit(info);
  return out.filter(
    (cls) => cls === info || lowerer.classCanBeConstructed(cls) || cls.subclasses.length > 0,
  );
}

function depth(info: ClassInfo): number {
  let n = 0;
  for (let cls = info.base; cls; cls = cls.base) n++;
  return n;
}

function samePlan(a: Plan, b: Plan): boolean {
  if (a.method !== null || b.method !== null) return a.method === b.method;
  return a.date === b.date && a.tag?.owner === b.tag?.owner && a.tag?.getter === b.tag?.getter;
}

/** The class's Symbol.toStringTag, when it has one: the class at the top
 * of the chain whose layout holds the tag field (an own property, which
 * shadows any getter), or its getter. Other tag types would make
 * Object.prototype.toString answer "Object" or the value depending on the
 * run, and are refused. */
function toStringTagOf(lowerer: Lowerer, info: ClassInfo, node: ts.Node): ToStringTag | null {
  const type = info.fields.get(TO_STRING_TAG_FIELD);
  if (type !== undefined) {
    if (type.kind !== "string") refuse(lowerer, node, info, "a non-string Symbol.toStringTag");
    let owner = info;
    while (owner.base?.fields.has(TO_STRING_TAG_FIELD)) owner = owner.base;
    return { owner, getter: false };
  }
  const getter = findMethodOn(lowerer, info, "get:sym:toStringTag");
  if (!getter) return null;
  if (getter.sig.ret.kind !== "string")
    refuse(lowerer, node, info, "a non-string Symbol.toStringTag");
  return { owner: getter.declarer, getter: true };
}

/** A conversion method the class declares or inherits (a field of that
 * name is an instance property the program sets, refused separately). */
function declared(
  lowerer: Lowerer,
  info: ClassInfo,
  method: ConversionMethod,
): { ret: IrType } | null {
  if (info.fields.has(method)) return null;
  const found = findMethodOn(lowerer, info, method);
  return found ? { ret: found.sig.ret } : null;
}

function planOf(
  lowerer: Lowerer,
  info: ClassInfo,
  hint: ConversionHint | "tag",
  node: ts.Node,
): Plan {
  if (hint === "tag") {
    const tag = toStringTagOf(lowerer, info, node);
    return tag ? { method: null, tag } : { method: null };
  }
  const exotic = declared(lowerer, info, "sym:toPrimitive");
  if (exotic) {
    if (!primitive(lowerer, exotic.ret))
      refuse(lowerer, node, info, "a [Symbol.toPrimitive] method that can return an object");
    return { method: "sym:toPrimitive", ret: exotic.ret };
  }
  // OrdinaryToPrimitive: "string" tries toString first, which every object
  // has (Object.prototype.toString answers a string); "default" and
  // "number" try valueOf first, whose Object.prototype version answers the
  // object itself. Date.prototype[Symbol.toPrimitive] takes "default" as
  // "string", and Date.prototype answers both methods with primitives.
  const date = dateRootOf(info) !== null;
  const order: ConversionMethod[] =
    hint === "string" || (date && hint === "default") ? ["toString"] : ["valueOf", "toString"];
  for (const method of order) {
    const found = declared(lowerer, info, method);
    if (!found) {
      if (date && method !== "sym:toPrimitive") return { method: null, date: method };
      continue;
    }
    if (!primitive(lowerer, found.ret))
      refuse(lowerer, node, info, `a '${method}' method that can return an object`);
    return { method, ret: found.ret };
  }
  const tag = toStringTagOf(lowerer, info, node);
  return tag ? { method: null, tag } : { method: null };
}

function primitive(lowerer: Lowerer, type: IrType): boolean {
  if (type.kind === "union")
    return (
      lowerer.unions.get(type.unionId)?.arms.every((arm) => PRIMITIVE_KINDS.has(arm.kind)) === true
    );
  return PRIMITIVE_KINDS.has(type.kind);
}

/** Conversions the program can change at run time (an instance property
 * of a method's name, a prototype write, a Symbol.toStringTag) would not be
 * the class's declared methods. */
function refuseReplacedConversions(lowerer: Lowerer, info: ClassInfo, node: ts.Node): void {
  for (const method of ["toString", "valueOf"] as const) {
    if (info.fields.has(method) || isClassCallback(lowerer, info, method))
      refuse(lowerer, node, info, `a '${method}' instance property`);
    if (lowerer.prototypeMethodAccesses.has(method))
      refuse(lowerer, node, info, `a '${method}' the program reaches through a prototype`);
  }
}

/** Whether the program may replace a conversion method of `info` at run
 * time by a write the census could not bound: a callback member or a
 * prototype access of the name. A field of the name is a declared instance
 * property, which no run-time test can tell from the method, and stays
 * refused. */
function replacedConversion(lowerer: Lowerer, info: ClassInfo, node: ts.Node): boolean {
  let replaced = false;
  for (const method of ["toString", "valueOf"] as const) {
    if (info.fields.has(method)) refuse(lowerer, node, info, `a '${method}' instance property`);
    if (isClassCallback(lowerer, info, method) || lowerer.prototypeMethodAccesses.has(method))
      replaced = true;
  }
  return replaced;
}

/** Whether ensureString converts a value of this record or array type by
 * itself: a record that is not a tuple and declares no `toString` member
 * (Object.prototype.toString's text, or the conversion of the source it
 * keeps), and an array whose elements its join prints (numbers, strings,
 * booleans, dates, checked-dynamic values, and unions of the scalars with
 * unit arms). The other shapes keep ensureString's refusal. */
function convertsAloneToString(lowerer: Lowerer, type: IrType): boolean {
  if (type.kind === "record") {
    const shape = lowerer.shapes.get(type.shapeId);
    return shape !== undefined && !shape.tuple && !shape.fields.some((f) => f.name === "toString");
  }
  if (type.kind !== "array") return false;
  const elem = type.elem;
  const scalar = (t: IrType): boolean =>
    t.kind === "f64" || t.kind === "string" || t.kind === "bool" || t.kind === "date";
  if (scalar(elem) || elem.kind === "dyn") return true;
  if (elem.kind !== "union") return false;
  const arms = lowerer.unions.get(elem.unionId)?.arms;
  return (
    arms !== undefined &&
    arms.every((arm) => scalar(arm) || arm.kind === "undefinedT" || arm.kind === "nullT")
  );
}

function refuse(lowerer: Lowerer, node: ts.Node, info: ClassInfo, what: string): never {
  lowerer.unsupported(
    "SC1090",
    node,
    `conversions of '${info.def.jsName ?? info.def.name}' instances to primitives (the class has ${what})`,
  );
}

/** ToString(ToPrimitive(value, hint)) of a union whose arms are program
 * class instances, URLs, typed arrays, dates, regular expressions and
 * primitives (`Box | undefined`, `string | URL`, `URL | Uint8Array`): each
 * arm converts as it would alone. With `plainArms`, which ensureString
 * passes once its own rules have declined, plain records and arrays are
 * arms too (`{ limit?: number } | undefined`, `number[] | string`). Null
 * for other unions. */
export function classUnionToString(
  lowerer: Lowerer,
  value: IrExpr,
  hint: StringConversionHint,
  node: ts.Node,
  plainArms = false,
): IrExpr | null {
  if (value.type.kind !== "union") return null;
  const unionId = value.type.unionId;
  const arms = lowerer.unions.get(unionId)?.arms;
  if (!arms || arms.every((arm) => PRIMITIVE_KINDS.has(arm.kind))) return null;
  const plain = (arm: IrType): boolean => arm.kind === "record" || arm.kind === "array";
  // Without class or URL arms both hints give the same text, and
  // ensureString, which tries the checker's narrowed arm first, converts
  // the union with the string hint. A record arm keeps the hint: a record
  // that kept its source adds as the source does, which can prefer valueOf.
  if (
    hint === "default" &&
    !arms.some((arm) => arm.kind === "object" || arm.kind === "url") &&
    !(plainArms && arms.some(plain))
  )
    return null;
  const convertible = (arm: IrType): boolean => {
    if (PRIMITIVE_KINDS.has(arm.kind)) return true;
    // These arms convert as ensureString converts them alone, with the
    // same result for both hints: a URL through its href, a typed array
    // through its join, a date through toString, a regular expression
    // through its source and flags.
    if (OBJECT_ARMS_TO_STRING.has(arm.kind)) return true;
    if (plain(arm)) return plainArms && convertsAloneToString(lowerer, arm);
    if (arm.kind !== "object") return false;
    const info = lowerer.classes.get(arm.className);
    return info !== undefined && plainProgramClass(info);
  };
  if (!arms.every(convertible)) return null;
  const loc = value.loc;
  const prefix: IrStmt[] = [];
  let stable = value;
  if (!isSafeToRepeat(value)) {
    const local = lowerer.declareHiddenLocal("%converted", value.type);
    prefix.push({ kind: "varDecl", localId: local.id, init: value, loc });
    stable = varRef(local.id, value.type, loc);
  }
  const convertArm = (tag: number): IrExpr => {
    const arm = arms[tag]!;
    if (arm.kind === "undefinedT" || arm.kind === "nullT")
      return {
        kind: "strLit",
        value: arm.kind === "nullT" ? "null" : "undefined",
        type: STRING,
        loc,
      };
    const narrowed: IrExpr = { kind: "unionNarrow", unionId, tag, value: stable, type: arm, loc };
    if (arm.kind === "object") return classToStringConversion(lowerer, narrowed, hint, node)!;
    if (arm.kind === "record" && hint === "default") return concatOperand(lowerer, narrowed, node);
    return lowerer.ensureString(narrowed, node);
  };
  let result = convertArm(arms.length - 1);
  for (let tag = arms.length - 2; tag >= 0; tag--) {
    result = {
      kind: "ternary",
      cond: { kind: "unionIsTag", unionId, tag, negated: false, value: stable, type: BOOL, loc },
      then: convertArm(tag),
      else_: result,
      type: STRING,
      loc,
    };
  }
  return prefix.length > 0 ? { kind: "seqExpr", stmts: prefix, result, type: STRING, loc } : result;
}
