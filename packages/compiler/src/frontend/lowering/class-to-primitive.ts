import { varRef } from "../../ir/build.js";
import {
  BOOL,
  DATE_T,
  DYN,
  F64,
  STRING,
  type IrExpr,
  type IrStmt,
  type IrType,
} from "../../ir/ir.js";
import * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js";
import { accessorCall, findMethodOn, type ClassInfo } from "./lower-classes.js";
import { isClassCallback } from "./class-callbacks.js";
import { TO_STRING_TAG_FIELD } from "./symbol-fields.js";
import { isSafeToRepeat } from "./expressions/evaluation-safety.js";
import { DATE_TIME_FIELD, dateRootOf } from "./builtins/date-classes.js";
import { dateValueMethod } from "./builtins/dates.js";

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
  return classConversion(lowerer, value, "number", node, F64, (primitive) =>
    numberOfPrimitive(lowerer, primitive, node, operator),
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
): IrExpr | null {
  if (value.type.kind !== "object") return null;
  const info = lowerer.classes.get(value.type.className);
  if (!info || !plainProgramClass(info)) return null;
  const classes = subtree(lowerer, info);
  if (hint !== "tag") for (const cls of classes) refuseReplacedConversions(lowerer, cls, node);
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

function refuse(lowerer: Lowerer, node: ts.Node, info: ClassInfo, what: string): never {
  lowerer.unsupported(
    "SC1090",
    node,
    `conversions of '${info.def.jsName ?? info.def.name}' instances to primitives (the class has ${what})`,
  );
}

/** ToString(ToPrimitive(value, hint)) of a union whose arms are program
 * class instances, URLs and primitives (`Box | undefined`, `string | URL`):
 * each arm converts as it would alone. Null for other unions. */
export function classUnionToString(
  lowerer: Lowerer,
  value: IrExpr,
  hint: StringConversionHint,
  node: ts.Node,
): IrExpr | null {
  if (value.type.kind !== "union") return null;
  const unionId = value.type.unionId;
  const arms = lowerer.unions.get(unionId)?.arms;
  if (!arms || !arms.some((arm) => arm.kind === "object" || arm.kind === "url")) return null;
  const convertible = (arm: IrType): boolean => {
    if (PRIMITIVE_KINDS.has(arm.kind)) return true;
    // A URL arm converts through its href, like String(url).
    if (arm.kind === "url") return true;
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
