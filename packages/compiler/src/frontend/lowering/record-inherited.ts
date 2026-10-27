/* Object.prototype's methods on typed records.
 *
 * A record is an ordinary object, so `r.toString()`, `r.hasOwnProperty(k)`
 * and the other Object.prototype methods answer from its prototype unless
 * the record holds an own entry under that name. Method calls with a
 * constant name call an own entry when the record's type lets one be
 * callable and otherwise run the built-in natively with the record as its
 * receiver. Keyed reads of records whose values are functions or checked
 * values answer the built-in as a native function value on the miss path,
 * so truthiness, typeof and calls behave as in Node; hits are untouched.
 * Records of other value types keep reading undefined for these names
 * (a documented limitation). No dynamic-tier unit is involved: every
 * built-in is a small lifted function over the record. */
import * as ts from "../ts7/adapter.js";
import { dynUndefinedExpr, nodeThrowExpr, varRef } from "../../ir/build.js";
import {
  BOOL,
  DYN,
  STRING,
  UNDEFINED_T,
  isUnitType,
  typeEquals,
  typeKey,
  type IrExpr,
  type IrLocal,
  type IrStmt,
  type IrType,
  type SrcLoc,
} from "../../ir/ir.js";
import type { Lowerer } from "./lowerer.js";
import { locOf } from "../program.js";
import { keyedHelperName } from "./stable-names.js";
import { isSafeToRepeat } from "./expressions/evaluation-safety.js";
import { nullProtoRecordShape, recordNullProtoTest } from "./null-prototype.js";
import { recordHasOwnHelper } from "./lower-calls.js";
import { OTHER_ARM_FAILURE_MESSAGE } from "./coercions/unions.js";

/** Object.prototype's methods a record answers from its prototype. */
export const RECORD_INHERITED_METHODS: ReadonlySet<string> = new Set([
  "toString",
  "toLocaleString",
  "valueOf",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
]);

type FuncType = IrType & { kind: "func" };

/** Declares a hidden local in the function being built: the lowerer's
 * current function, or a lifted helper's own local list. */
type DeclareLocal = (name: string, type: IrType) => string;

function liftedLocals(): { declare: DeclareLocal; locals: IrLocal[] } {
  const locals: IrLocal[] = [];
  return {
    locals,
    declare: (name, type) => {
      const id = `${name}.${locals.length}`;
      locals.push({ id, name, type, mutable: false });
      return id;
    },
  };
}

/** The form a read of `type` gives a built-in method value: the union's one
 * function arm (beside an undefined arm), a checked value, or null when the
 * type cannot hold a function. */
function methodValueForm(lowerer: Lowerer, type: IrType): FuncType | "dyn" | null {
  if (type.kind === "dyn") return "dyn";
  if (type.kind !== "union") return null;
  const arms = lowerer.unions.get(type.unionId)?.arms ?? [];
  if (!arms.some((arm) => arm.kind === "undefinedT")) return null;
  const funcs = arms.filter((arm): arm is FuncType => arm.kind === "func");
  if (funcs.length !== 1 || funcs[0]!.restAbi !== undefined) return null;
  return funcs[0]!;
}

/** A value of `type` may be a function that a call can enter. */
function callableType(lowerer: Lowerer, type: IrType): boolean {
  if (type.kind === "func" || type.kind === "dyn") return true;
  if (type.kind !== "union") return false;
  return (lowerer.unions.get(type.unionId)?.arms ?? []).some(
    (arm) => arm.kind === "func" || arm.kind === "dyn",
  );
}

/** A keyed record read (`r[k]`, `r["toString"]`) whose miss answers the
 * inherited Object.prototype method for those names. Hits keep the
 * ordinary read; only the miss path tests the key. `bound`: the read is
 * the callee of a call (`r[k](…)`, `r[k]?.(…)`), whose `this` is the
 * record; any other read yields the method as a plain value, whose calls
 * see an undefined `this` as in Node. */
export function withInheritedMethods(
  lowerer: Lowerer,
  read: IrExpr & { kind: "recordKeyGet" },
  litKey: string | null,
  bound: boolean,
): IrExpr {
  if (litKey !== null && !RECORD_INHERITED_METHODS.has(litKey)) return read;
  if (read.missNaN === true) return read;
  const form = methodValueForm(lowerer, read.type);
  const shape = lowerer.shapes.get(read.shapeId);
  if (form === null || !shape || shape.tuple) return read;
  const loc = read.loc;
  const stmts: IrStmt[] = [];
  const repeatable = (value: IrExpr): boolean => isSafeToRepeat(value) || value.kind === "strLit";
  const stable = (value: IrExpr, name: string, keep: boolean): IrExpr => {
    if (keep) return value;
    const local = lowerer.declareHiddenLocal(name, value.type);
    stmts.push({ kind: "varDecl", localId: local.id, init: value, loc });
    return varRef(local.id, value.type, loc);
  };
  // The receiver is evaluated before the key: when computing the key runs
  // code (it may reassign the receiver's variable), the receiver is held
  // first, even when reading it again would be safe on its own.
  const keyRepeatable = repeatable(read.key);
  const obj = stable(read.obj, "%inheritedRecv", repeatable(read.obj) && keyRepeatable);
  const key = stable(read.key, "%inheritedKey", keyRepeatable);
  const helper = inheritedReadHelper(lowerer, read.shapeId, read.type, form, bound, loc);
  const fallback: IrExpr = { kind: "call", callee: helper, args: [obj, key], type: read.type, loc };
  if (
    form !== "dyn" &&
    read.type.kind === "union" &&
    !(lowerer.unions.get(read.type.unionId)?.arms ?? []).some((arm) => arm.kind === "nullT")
  ) {
    // `r[k] ?? inherited(r, k)`: the hit is the read's own value, untouched.
    const coalesced: IrExpr = {
      kind: "nullish",
      left: { ...read, obj, key },
      right: fallback,
      type: read.type,
      loc,
    };
    return stmts.length === 0
      ? coalesced
      : { kind: "seqExpr", stmts, result: coalesced, type: read.type, loc };
  }
  const value = lowerer.declareHiddenLocal("%inheritedRead", read.type);
  stmts.push({ kind: "varDecl", localId: value.id, init: { ...read, obj, key }, loc });
  const found = varRef(value.id, read.type, loc);
  let missing: IrExpr;
  if (form === "dyn") {
    missing = { kind: "dynTest", test: "undefined", value: found, type: BOOL, loc } as IrExpr;
  } else {
    const unionId = (read.type as IrType & { kind: "union" }).unionId;
    const tag = (lowerer.unions.get(unionId)?.arms ?? []).findIndex(
      (arm) => arm.kind === "undefinedT",
    );
    missing = { kind: "unionIsTag", unionId, tag, negated: false, value: found, type: BOOL, loc };
  }
  return {
    kind: "seqExpr",
    stmts,
    result: {
      kind: "ternary",
      cond: missing,
      then: fallback,
      else_: found,
      type: read.type,
      loc,
    },
    type: read.type,
    loc,
  };
}

/** `%rec.inherited.<n>(o, k)`: the inherited method `k` names as a value
 * of `readType` (bound to `o`), or undefined. */
function inheritedReadHelper(
  lowerer: Lowerer,
  shapeId: string,
  readType: IrType,
  form: FuncType | "dyn",
  bound: boolean,
  loc: SrcLoc,
): string {
  const key = `rec.inherited:${bound ? "bound" : "value"}:${shapeId}:${typeKey(readType)}`;
  const existing = lowerer.arrHofHelpers.get(key);
  if (existing) return existing;
  const name = keyedHelperName(lowerer, "%rec.inherited", key);
  lowerer.arrHofHelpers.set(key, name);
  const recT: IrType = { kind: "record", shapeId };
  const o = varRef("o.0", recT, loc);
  const k = varRef("k.0", STRING, loc);
  const fnType: FuncType =
    form === "dyn" ? ({ kind: "func", params: [DYN], ret: DYN } as FuncType) : form;
  const undefinedValue: IrExpr =
    form === "dyn"
      ? dynUndefinedExpr(loc)
      : lowerer.coerceToExpected(
          { kind: "unitLit", unit: "undefined", type: UNDEFINED_T, loc },
          readType,
        );
  const named = (method: string): IrExpr => ({
    kind: "strEq",
    negated: false,
    left: k,
    right: { kind: "strLit", value: method, type: STRING, loc },
    type: BOOL,
    loc,
  });
  const methods = [...RECORD_INHERITED_METHODS];
  let anyName: IrExpr = named(methods[0]!);
  for (const method of methods.slice(1))
    anyName = { kind: "logical", op: "||", left: anyName, right: named(method), type: BOOL, loc };
  const body: IrStmt[] = [
    // Most misses name no inherited method: one comparison chain, nothing else.
    {
      kind: "if",
      cond: { kind: "unary", op: "!", operand: anyName, type: BOOL, loc },
      then: [{ kind: "return", value: { ...undefinedValue }, loc }],
      else_: null,
      loc,
    },
    // An own key holding undefined shadows the prototype like any own key.
    {
      kind: "if",
      cond: {
        kind: "call",
        callee: recordHasOwnHelper(lowerer, shapeId, loc),
        args: [o, k],
        type: BOOL,
        loc,
      },
      then: [{ kind: "return", value: { ...undefinedValue }, loc }],
      else_: null,
      loc,
    },
  ];
  if (nullProtoRecordShape(lowerer, recT))
    body.push({
      kind: "if",
      cond: recordNullProtoTest(o, shapeId, loc),
      then: [{ kind: "return", value: { ...undefinedValue }, loc }],
      else_: null,
      loc,
    });
  for (const method of methods) {
    const value: IrExpr = bound
      ? {
          kind: "call",
          callee: boundMethodFactory(lowerer, shapeId, method, fnType, loc),
          args: [o],
          type: fnType,
          loc,
        }
      : {
          kind: "closure",
          fnName: unboundMethodImpl(lowerer, method, fnType, loc),
          captures: [],
          type: fnType,
          loc,
        };
    body.push({
      kind: "if",
      cond: named(method),
      then: [
        {
          kind: "return",
          value: lowerer.coerceToExpected(value, form === "dyn" ? DYN : readType),
          loc,
        },
      ],
      else_: null,
      loc,
    });
  }
  body.push({ kind: "return", value: { ...undefinedValue }, loc });
  lowerer.liftedFns.push({
    name,
    params: [
      { localId: "o.0", name: "o", type: recT },
      { localId: "k.0", name: "k", type: STRING },
    ],
    returnType: readType,
    locals: [
      { id: "o.0", name: "o", type: recT, mutable: false },
      { id: "k.0", name: "k", type: STRING, mutable: false },
    ],
    body,
    loc,
  });
  return name;
}

/** `%rec.bind.<n>(o)`: the built-in `method` bound to `o` as a closure. */
function boundMethodFactory(
  lowerer: Lowerer,
  shapeId: string,
  method: string,
  fnType: FuncType,
  loc: SrcLoc,
): string {
  const key = `rec.bind:${shapeId}:${method}:${typeKey(fnType)}`;
  const existing = lowerer.arrHofHelpers.get(key);
  if (existing) return existing;
  const name = keyedHelperName(lowerer, "%rec.bind", key);
  lowerer.arrHofHelpers.set(key, name);
  const recT: IrType = { kind: "record", shapeId };
  lowerer.liftedFns.push({
    name,
    params: [{ localId: "o.0", name: "o", type: recT }],
    returnType: fnType,
    locals: [{ id: "o.0", name: "o", type: recT, mutable: false, boxed: true }],
    body: [
      {
        kind: "return",
        value: {
          kind: "closure",
          fnName: inheritedMethodImpl(lowerer, shapeId, method, fnType, loc),
          captures: ["o.0"],
          type: fnType,
          loc,
        },
        loc,
      },
    ],
    loc,
  });
  return name;
}

/** The lifted body of one built-in bound to its record, with the read's
 * function signature: the built-in's answer converted to the signature's
 * return type, or the checked-conversion TypeError where it cannot be. */
function inheritedMethodImpl(
  lowerer: Lowerer,
  shapeId: string,
  method: string,
  fnType: FuncType,
  loc: SrcLoc,
): string {
  const key = `rec.inheritedImpl:${shapeId}:${method}:${typeKey(fnType)}`;
  const existing = lowerer.arrHofHelpers.get(key);
  if (existing) return existing;
  const name = keyedHelperName(lowerer, `%rec.${method}`, key);
  lowerer.arrHofHelpers.set(key, name);
  const recT: IrType = { kind: "record", shapeId };
  const o = varRef("o.0", recT, loc);
  const params = fnType.params.map((type, i) => ({ localId: `p${i}.0`, name: `p${i}`, type }));
  const args = params.map((p) => varRef(p.localId, p.type, loc));
  const body: IrStmt[] = [];
  const hidden = liftedLocals();
  const answer = builtinAnswer(lowerer, hidden.declare, o, shapeId, method, args, fnType.ret, loc);
  body.push(...returnAs(lowerer, answer, fnType.ret, loc));
  lowerer.liftedFns.push({
    name,
    params,
    returnType: fnType.ret,
    captures: [{ localId: "o.0", name: "o", type: recT }],
    locals: [
      { id: "o.0", name: "o", type: recT, mutable: false, boxed: true },
      ...params.map((p) => ({ id: p.localId, name: p.name, type: p.type, mutable: false })),
      ...hidden.locals,
    ],
    body,
    loc,
  });
  return name;
}

/** One built-in as a plain function value (no receiver): its answer for an
 * undefined `this`, converted like inheritedMethodImpl's. */
function unboundMethodImpl(
  lowerer: Lowerer,
  method: string,
  fnType: FuncType,
  loc: SrcLoc,
): string {
  const key = `rec.unboundImpl:${method}:${typeKey(fnType)}`;
  const existing = lowerer.arrHofHelpers.get(key);
  if (existing) return existing;
  const name = keyedHelperName(lowerer, `%obj.${method}`, key);
  lowerer.arrHofHelpers.set(key, name);
  const params = fnType.params.map((type, i) => ({ localId: `p${i}.0`, name: `p${i}`, type }));
  const arg: IrExpr | undefined = params[0] && varRef(params[0].localId, params[0].type, loc);
  const coerce = "Cannot convert undefined or null to object";
  let answer: IrExpr;
  switch (method) {
    case "toString":
      answer = { kind: "strLit", value: "[object Undefined]", type: STRING, loc };
      break;
    case "toLocaleString":
      answer = nodeThrowExpr(
        1,
        "",
        "Object.prototype.toLocaleString called on null or undefined",
        STRING,
        loc,
      );
      break;
    case "isPrototypeOf": {
      // A primitive argument answers false before `this` converts.
      const no: IrExpr = { kind: "boolLit", value: false, type: BOOL, loc };
      const kind = arg?.type.kind;
      if (
        arg === undefined ||
        isUnitType(arg.type) ||
        kind === "string" ||
        kind === "f64" ||
        kind === "bool" ||
        kind === "bigint"
      )
        answer = no;
      else if (kind === "dyn")
        answer = {
          kind: "ternary",
          cond: {
            kind: "logical",
            op: "||",
            left: { kind: "dynTest", test: "object", value: arg, type: BOOL, loc },
            right: { kind: "dynTest", test: "function", value: arg, type: BOOL, loc },
            type: BOOL,
            loc,
          } as IrExpr,
          then: nodeThrowExpr(1, "", coerce, BOOL, loc),
          else_: no,
          type: BOOL,
          loc,
        };
      else answer = nodeThrowExpr(1, "", coerce, BOOL, loc);
      break;
    }
    default:
      answer = nodeThrowExpr(1, "", coerce, method === "valueOf" ? DYN : BOOL, loc);
  }
  const body: IrStmt[] =
    answer.kind === "libCall" && answer.fn === "error.nodeThrow"
      ? [
          {
            kind: "return",
            value: nodeThrowExpr(
              1,
              "",
              (answer.args[2] as IrExpr & { kind: "strLit" }).value,
              fnType.ret,
              loc,
            ),
            loc,
          },
        ]
      : returnAs(lowerer, answer, fnType.ret, loc);
  lowerer.liftedFns.push({
    name,
    params,
    returnType: fnType.ret,
    locals: params.map((p) => ({ id: p.localId, name: p.name, type: p.type, mutable: false })),
    body,
    loc,
  });
  return name;
}

/** The built-in's answer with `o` as its receiver. `want` is the type the
 * caller needs (valueOf answers the record itself). */
function builtinAnswer(
  lowerer: Lowerer,
  declare: DeclareLocal,
  o: IrExpr,
  shapeId: string,
  method: string,
  args: readonly IrExpr[],
  want: IrType,
  loc: SrcLoc,
): IrExpr {
  switch (method) {
    case "toString":
      return { kind: "strLit", value: "[object Object]", type: STRING, loc };
    case "toLocaleString":
      // Object.prototype.toLocaleString calls this.toString().
      return callOwnOrBuiltin(
        lowerer,
        declare,
        o,
        shapeId,
        "toString",
        [],
        STRING,
        "toString",
        loc,
      );
    case "valueOf":
      return want.kind === "dyn" ? lowerer.coerceToExpected(o, DYN) : o;
    case "isPrototypeOf":
      // No object is created with a typed record as its prototype.
      return { kind: "boolLit", value: false, type: BOOL, loc };
    default: {
      // hasOwnProperty and propertyIsEnumerable: ToPropertyKey keeps a
      // symbol a symbol, and a record's own keys are strings, so a symbol
      // key is no entry of it.
      const no: IrExpr = { kind: "boolLit", value: false, type: BOOL, loc };
      const arg = args[0];
      if (arg?.type.kind === "symbol") return sequence(arg, no, loc);
      const has = (key: IrExpr): IrExpr => ({
        kind: "call",
        callee: recordHasOwnHelper(lowerer, shapeId, loc),
        args: [o, key],
        type: BOOL,
        loc,
      });
      if (arg === undefined || !mayBeSymbol(arg.type)) return has(propertyKeyOf(lowerer, arg, loc));
      const id = declare("%protoKey", DYN);
      const held = varRef(id, DYN, loc);
      return {
        kind: "seqExpr",
        stmts: [{ kind: "varDecl", localId: id, init: lowerer.coerceToExpected(arg, DYN), loc }],
        result: {
          kind: "ternary",
          cond: { kind: "dynTest", test: "symbol", value: held, type: BOOL, loc } as IrExpr,
          then: no,
          else_: has(propertyKeyOf(lowerer, held, loc)),
          type: BOOL,
          loc,
        },
        type: BOOL,
        loc,
      };
    }
  }
}

/** Whether a value of `type` may be a symbol at run time. */
function mayBeSymbol(type: IrType): boolean {
  return !(
    isUnitType(type) ||
    type.kind === "string" ||
    type.kind === "f64" ||
    type.kind === "bool"
  );
}

/** ToPropertyKey of a built-in's key argument (absent: "undefined"), for
 * keys that are not symbols. */
function propertyKeyOf(lowerer: Lowerer, arg: IrExpr | undefined, loc: SrcLoc): IrExpr {
  if (arg === undefined || isUnitType(arg.type))
    return {
      kind: "strLit",
      value: arg?.type.kind === "nullT" ? "null" : "undefined",
      type: STRING,
      loc,
    };
  if (arg.type.kind === "string") return arg;
  if (arg.type.kind === "f64" || arg.type.kind === "bool")
    return { kind: "toString", operand: arg, type: STRING, loc };
  return {
    kind: "libCall",
    fn: "dyn.toStringCoerce",
    args: [lowerer.coerceToExpected(arg, DYN)],
    type: STRING,
    loc,
  };
}

/** `value` returned as `ret`: as is, wrapped into a union arm or a checked
 * value, discarded for void, or the checked-conversion TypeError. */
function returnAs(lowerer: Lowerer, value: IrExpr, ret: IrType, loc: SrcLoc): IrStmt[] {
  const converted = convertTo(lowerer, value, ret);
  if (converted !== null) return [{ kind: "return", value: converted, loc }];
  if (ret.kind === "void")
    return [
      { kind: "exprStmt", expr: value, loc },
      { kind: "return", value: null, loc },
    ];
  return [
    { kind: "exprStmt", expr: value, loc },
    { kind: "return", value: nodeThrowExpr(1, "", OTHER_ARM_FAILURE_MESSAGE, ret, loc), loc },
  ];
}

function convertTo(lowerer: Lowerer, value: IrExpr, want: IrType): IrExpr | null {
  if (typeEquals(value.type, want)) return value;
  if (want.kind === "dyn" && lowerer.dynConvertible(value.type))
    return lowerer.coerceToExpected(value, DYN);
  if (want.kind === "union" && lowerer.armTag(want.unionId, value.type) >= 0)
    return lowerer.coerceToExpected(value, want);
  return null;
}

/** `o.method(...args)` on a record: an own callable entry when the record
 * holds one, else the built-in. `calleeText` names the callee for Node's
 * "is not a function". */
function callOwnOrBuiltin(
  lowerer: Lowerer,
  declare: DeclareLocal,
  o: IrExpr,
  shapeId: string,
  method: string,
  args: readonly IrExpr[],
  want: IrType,
  calleeText: string,
  loc: SrcLoc,
  resolved?: { has: IrExpr; own: IrExpr },
): IrExpr {
  const shape = lowerer.shapes.get(shapeId)!;
  const field = shape.fields.find((f) => f.name === method);
  const ownType = field ? field.type : shape.indexValue;
  let builtin = builtinAnswer(lowerer, declare, o, shapeId, method, args, want, loc);
  const recT: IrType = { kind: "record", shapeId };
  if (nullProtoRecordShape(lowerer, recT))
    builtin = {
      kind: "ternary",
      cond: recordNullProtoTest(o, shapeId, loc),
      then: nodeThrowExpr(1, "", `${calleeText} is not a function`, builtin.type, loc),
      else_: builtin,
      type: builtin.type,
      loc,
    };
  const builtinAsWant = convertTo(lowerer, builtin, want) ?? builtin;
  if (ownType === undefined || !callableType(lowerer, ownType)) return builtinAsWant;
  const own = resolved?.own ?? ownEntryRead(lowerer, o, shapeId, method, loc);
  const called = callOwn(lowerer, declare, own, args, builtinAsWant.type, calleeText, loc);
  return {
    kind: "ternary",
    cond: resolved?.has ?? ownEntryTest(lowerer, o, shapeId, method, loc),
    then: called,
    else_: builtinAsWant,
    type: builtinAsWant.type,
    loc,
  };
}

/** Whether the record holds an own entry named `method`. */
function ownEntryTest(
  lowerer: Lowerer,
  o: IrExpr,
  shapeId: string,
  method: string,
  loc: SrcLoc,
): IrExpr {
  return {
    kind: "call",
    callee: recordHasOwnHelper(lowerer, shapeId, loc),
    args: [o, { kind: "strLit", value: method, type: STRING, loc }],
    type: BOOL,
    loc,
  };
}

/** The record's own entry named `method`: its field, or its overflow entry
 * (undefined when absent). */
function ownEntryRead(
  lowerer: Lowerer,
  o: IrExpr,
  shapeId: string,
  method: string,
  loc: SrcLoc,
): IrExpr {
  const shape = lowerer.shapes.get(shapeId)!;
  const field = shape.fields.find((f) => f.name === method);
  return field
    ? { kind: "recordGet", obj: o, shapeId, field: method, type: field.type, loc }
    : {
        kind: "recordKeyGet",
        obj: o,
        shapeId,
        key: { kind: "strLit", value: method, type: STRING, loc },
        overflowOnly: true,
        type: lowerer.withUndefinedArmOf(shape.indexValue!) ?? shape.indexValue!,
        loc,
      };
}

/** Call the own entry `own` (present, of any stored type) with `args`. A
 * non-function throws Node's "is not a function"; a function whose
 * parameters or result cannot carry the call throws the checked-conversion
 * TypeError (the program's types claimed otherwise). */
function callOwn(
  lowerer: Lowerer,
  declare: DeclareLocal,
  own: IrExpr,
  args: readonly IrExpr[],
  want: IrType,
  calleeText: string,
  loc: SrcLoc,
): IrExpr {
  const notFunction = nodeThrowExpr(1, "", `${calleeText} is not a function`, want, loc);
  const lie = nodeThrowExpr(1, "", OTHER_ARM_FAILURE_MESSAGE, want, loc);
  const localId = declare("%ownMethod", own.type);
  const value = varRef(localId, own.type, loc);
  const enter = (fn: IrExpr): IrExpr => {
    if (fn.type.kind === "dyn") {
      const result: IrExpr = {
        kind: "dynCall",
        callee: fn,
        calleeName: calleeText,
        args: args.map((a) => lowerer.coerceToExpected(a, DYN)),
        type: DYN,
        loc,
      } as IrExpr;
      return convertTo(lowerer, result, want) ?? sequence(result, lie, loc);
    }
    const sig = fn.type as FuncType;
    if (sig.restAbi !== undefined) return lie;
    const passed: IrExpr[] = [];
    for (let i = 0; i < sig.params.length; i++) {
      const param = sig.params[i]!;
      const arg = args[i];
      const given =
        arg === undefined
          ? convertTo(
              lowerer,
              { kind: "unitLit", unit: "undefined", type: UNDEFINED_T, loc },
              param,
            )
          : convertTo(lowerer, arg, param);
      if (given === null) return lie;
      passed.push(given);
    }
    const result: IrExpr = { kind: "callValue", callee: fn, args: passed, type: sig.ret, loc };
    if (sig.ret.kind === "void") return sequence(result, lie, loc);
    return convertTo(lowerer, result, want) ?? sequence(result, lie, loc);
  };
  let call: IrExpr;
  if (own.type.kind === "func" || own.type.kind === "dyn") call = enter(value);
  else if (own.type.kind === "union") {
    const unionId = own.type.unionId;
    const arms = lowerer.unions.get(unionId)?.arms ?? [];
    call = notFunction;
    for (let tag = arms.length - 1; tag >= 0; tag--) {
      const arm = arms[tag]!;
      if (arm.kind !== "func" && arm.kind !== "dyn") continue;
      call = {
        kind: "ternary",
        cond: { kind: "unionIsTag", unionId, tag, negated: false, value, type: BOOL, loc },
        then: enter({ kind: "unionNarrow", unionId, tag, value, type: arm, loc }),
        else_: call,
        type: want,
        loc,
      };
    }
  } else call = notFunction;
  return {
    kind: "seqExpr",
    stmts: [{ kind: "varDecl", localId, init: own, loc }],
    result: call,
    type: want,
    loc,
  };
}

function sequence(first: IrExpr, result: IrExpr, loc: SrcLoc): IrExpr {
  return {
    kind: "seqExpr",
    stmts: [{ kind: "exprStmt", expr: first, loc }],
    result,
    type: result.type,
    loc,
  };
}

/** `r.toString()`, `r.hasOwnProperty(k)` and the other Object.prototype
 * methods called by name on a typed record (the checker resolved the
 * member to Object.prototype's). Null for other calls. */
export function lowerRecordInheritedCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  const method = access.name.text;
  if (
    call.questionDotToken ||
    access.questionDotToken ||
    !RECORD_INHERITED_METHODS.has(method) ||
    call.arguments.nodes.some(ts.isSpreadElement) ||
    !lowerer.isStdlibMember(access)
  )
    return null;
  const recvT = lowerer.mapTypeOf(lowerer.typeOf(access.expression));
  if (recvT?.kind !== "record") return null;
  const shape = lowerer.shapes.get(recvT.shapeId);
  if (!shape || shape.tuple) return null;
  const want =
    method === "valueOf"
      ? (lowerer.mapTypeOf(lowerer.typeOf(call)) ?? recvT)
      : method === "toString" || method === "toLocaleString"
        ? STRING
        : BOOL;
  // Without a possible own function, toString and the own-key tests keep
  // their existing lowerings (with the special record views they know).
  if (
    (method === "hasOwnProperty" || method === "propertyIsEnumerable" || method === "toString") &&
    !shape.fields.some((f) => f.name === method && callableType(lowerer, f.type)) &&
    !(shape.indexValue && callableType(lowerer, shape.indexValue))
  )
    return null;
  const loc = locOf(call);
  const stmts: IrStmt[] = [];
  const receiver = lowerer.lowerExpr(access.expression);
  if (receiver.type.kind !== "record") return null;
  const recvLocal = lowerer.declareHiddenLocal("%protoRecv", receiver.type);
  stmts.push({ kind: "varDecl", localId: recvLocal.id, init: receiver, loc });
  const o = varRef(recvLocal.id, receiver.type, loc);
  // `o.m(...)` reads the member before its arguments run: an argument that
  // adds, deletes or replaces the own method does not change the callee.
  const field = shape.fields.find((f) => f.name === method);
  const ownType = field ? field.type : shape.indexValue;
  let resolved: { has: IrExpr; own: IrExpr } | undefined;
  if (ownType !== undefined && callableType(lowerer, ownType)) {
    const shapeId = receiver.type.shapeId;
    const hasLocal = lowerer.declareHiddenLocal("%protoHas", BOOL);
    stmts.push({
      kind: "varDecl",
      localId: hasLocal.id,
      init: ownEntryTest(lowerer, o, shapeId, method, loc),
      loc,
    });
    const read = ownEntryRead(lowerer, o, shapeId, method, loc);
    const ownLocal = lowerer.declareHiddenLocal("%protoOwn", read.type);
    stmts.push({ kind: "varDecl", localId: ownLocal.id, init: read, loc });
    resolved = { has: varRef(hasLocal.id, BOOL, loc), own: varRef(ownLocal.id, read.type, loc) };
  }
  const args: IrExpr[] = [];
  for (const node of call.arguments.nodes) {
    const arg = lowerer.lowerExpr(node);
    const local = lowerer.declareHiddenLocal("%protoArg", arg.type);
    stmts.push({ kind: "varDecl", localId: local.id, init: arg, loc });
    args.push(varRef(local.id, arg.type, loc));
  }
  const result = callOwnOrBuiltin(
    lowerer,
    (name, type) => lowerer.declareHiddenLocal(name, type).id,
    o,
    receiver.type.shapeId,
    method,
    args,
    want,
    ts.getTextOfNode(access),
    loc,
    resolved,
  );
  return { kind: "seqExpr", stmts, result, type: result.type, loc };
}

/** `r.toString` and the other Object.prototype methods read by name (not
 * called) on an index-signature record: an own entry of the member's
 * function type when the record holds one, else the built-in as a plain
 * function value. An own entry of another type than the member's (a
 * function of another signature) throws the checked-conversion TypeError:
 * the program's types claimed the member. Null when the checker's member
 * type is not a function. */
export function lowerRecordInheritedMember(
  lowerer: Lowerer,
  receiver: IrExpr,
  expr: ts.PropertyAccessExpression,
): IrExpr | null {
  const method = expr.name.text;
  if (!RECORD_INHERITED_METHODS.has(method) || !lowerer.isStdlibMember(expr)) return null;
  if (receiver.type.kind !== "record") return null;
  const want = lowerer.mapTypeOf(lowerer.typeOf(expr));
  if (want?.kind !== "func" || want.restAbi !== undefined) return null;
  const shapeId = receiver.type.shapeId;
  const shape = lowerer.shapes.get(shapeId);
  if (!shape || shape.tuple) return null;
  const loc = locOf(expr);
  const builtin: IrExpr = {
    kind: "closure",
    fnName: unboundMethodImpl(lowerer, method, want, loc),
    captures: [],
    type: want,
    loc,
  };
  const recvLocal = lowerer.declareHiddenLocal("%protoRecv", receiver.type);
  const o = varRef(recvLocal.id, receiver.type, loc);
  const stmts: IrStmt[] = [{ kind: "varDecl", localId: recvLocal.id, init: receiver, loc }];
  let result: IrExpr = builtin;
  if (shape.indexValue && typeEquals(shape.indexValue, want)) {
    const ownType = lowerer.withUndefinedArmOf(want);
    if (ownType?.kind === "union") {
      const read: IrExpr = {
        kind: "recordKeyGet",
        obj: o,
        shapeId,
        key: { kind: "strLit", value: method, type: STRING, loc },
        overflowOnly: true,
        type: ownType,
        loc,
      };
      const tag = lowerer.armTag(ownType.unionId, want);
      const ownLocal = lowerer.declareHiddenLocal("%ownMethod", ownType);
      const own = varRef(ownLocal.id, ownType, loc);
      stmts.push({ kind: "varDecl", localId: ownLocal.id, init: read, loc });
      result = {
        kind: "ternary",
        cond: {
          kind: "unionIsTag",
          unionId: ownType.unionId,
          tag,
          negated: false,
          value: own,
          type: BOOL,
          loc,
        },
        then: { kind: "unionNarrow", unionId: ownType.unionId, tag, value: own, type: want, loc },
        else_: builtin,
        type: want,
        loc,
      };
    }
  } else if (shape.indexValue && callableType(lowerer, shape.indexValue)) {
    result = {
      kind: "ternary",
      cond: ownEntryTest(lowerer, o, shapeId, method, loc),
      then: nodeThrowExpr(1, "", OTHER_ARM_FAILURE_MESSAGE, want, loc),
      else_: builtin,
      type: want,
      loc,
    };
  }
  return { kind: "seqExpr", stmts, result, type: want, loc };
}
