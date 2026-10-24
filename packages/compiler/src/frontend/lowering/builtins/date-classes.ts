import * as ts from "../../ts7/adapter.js";
import { type Lowerer } from "../lowerer.js";
import { locOf } from "../../program.js";
import { type ClassInfo } from "../lower-classes.js";
import {
  DATE_METHOD_HINT,
  dateJsonType,
  dateSetterTime,
  dateValueMethod,
  isDateSetter,
} from "./dates.js";
import { dynUndefinedExpr, varRef } from "../../../ir/build.js";
import {
  BOOL,
  DATE_T,
  DYN,
  F64,
  NULL_T,
  STRING,
  VOID,
  typeKey,
  type IrExpr,
  type IrStmt,
  type IrType,
  type SrcLoc,
} from "../../../ir/ir.js";

/** The hidden field holding the time value of a class declared `extends
 * Date`, the first field of its layout. */
export const DATE_TIME_FIELD = "%time";

/** The class declared `extends Date` at the root of `info`'s base chain, or
 * null. */
export function dateRootOf(info: ClassInfo | null | undefined): ClassInfo | null {
  for (let c = info ?? null; c; c = c.base) if (c.extendsDate) return c;
  return null;
}

/** Whether the program declares a class that extends Date. */
export function programDeclaresDateClass(lowerer: Lowerer): boolean {
  for (const info of lowerer.classes.values()) if (info.extendsDate) return true;
  return false;
}

/** The Date.prototype methods a class declared `extends Date` inherits.
 * Those without a lowering refuse at the call. */
const DATE_PROTOTYPE_METHODS: ReadonlySet<string> = new Set([
  "getTime",
  "valueOf",
  "toISOString",
  "toUTCString",
  "toJSON",
  "toString",
  "toDateString",
  "toTimeString",
  "toGMTString",
  "toLocaleString",
  "toLocaleDateString",
  "toLocaleTimeString",
  "getFullYear",
  "getUTCFullYear",
  "getYear",
  "getMonth",
  "getUTCMonth",
  "getDate",
  "getUTCDate",
  "getDay",
  "getUTCDay",
  "getHours",
  "getUTCHours",
  "getMinutes",
  "getUTCMinutes",
  "getSeconds",
  "getUTCSeconds",
  "getMilliseconds",
  "getUTCMilliseconds",
  "getTimezoneOffset",
  "setTime",
  "setFullYear",
  "setUTCFullYear",
  "setYear",
  "setMonth",
  "setUTCMonth",
  "setDate",
  "setUTCDate",
  "setHours",
  "setUTCHours",
  "setMinutes",
  "setUTCMinutes",
  "setSeconds",
  "setUTCSeconds",
  "setMilliseconds",
  "setUTCMilliseconds",
]);

export const DATE_PROTOTYPE_METHOD_NAMES: readonly string[] = [...DATE_PROTOTYPE_METHODS];

export function isDatePrototypeMethod(name: string): boolean {
  return DATE_PROTOTYPE_METHODS.has(name);
}

/** Whether `name` is a Date method an instance of `info` inherits from
 * Date.prototype: its class chain is rooted at a class declared `extends
 * Date` and declares no member of that name. The runtime's view of the
 * instance answers it (scr_dyn_date_class_method). */
export function dateInheritedMember(lowerer: Lowerer, info: ClassInfo, name: string): boolean {
  return (
    dateRootOf(info) !== null &&
    DATE_PROTOTYPE_METHODS.has(name) &&
    !lowerer.findMethodOn(info, name) &&
    !info.fields.has(name)
  );
}

/** super(...args) in a class declared `extends Date`: the time value the
 * Date constructor computes from the argument vector `args` (one dyn
 * array), stored in the hidden field. */
export function dateSuperCall(thisRef: IrExpr, info: ClassInfo, args: IrExpr, loc: SrcLoc): IrStmt {
  return {
    kind: "fieldSet",
    obj: thisRef,
    className: info.def.name,
    field: DATE_TIME_FIELD,
    value: { kind: "libCall", fn: "date.argumentsTime", args: [args], type: DATE_T, loc },
    loc,
  };
}

/** The time value of `receiver`, an instance of a class rooted at `root`. */
function timeOf(lowerer: Lowerer, receiver: IrExpr, root: ClassInfo, loc: SrcLoc): IrExpr {
  return {
    kind: "fieldGet",
    obj: lowerer.upcastTo(receiver, root.def.name),
    className: root.def.name,
    field: DATE_TIME_FIELD,
    type: DATE_T,
    loc,
  };
}

/** `receiver.name()` with no arguments where the static class `info` does
 * not declare `name`: the subclasses of `info` that declare it run theirs,
 * any other instance the Date method. `receiver` is a variable read. */
function instanceMethodCall(
  lowerer: Lowerer,
  blame: ts.Node,
  info: ClassInfo,
  receiver: IrExpr,
  name: string,
  inherited: IrExpr,
  loc: SrcLoc,
): IrExpr {
  const found = lowerer.findMethodOn(info, name);
  if (found) {
    if (found.sig.params.length > 0)
      lowerer.unsupported(
        "SC1090",
        blame,
        `a '${name}' declaration with parameters in a class that extends Date, called by an inherited Date method`,
      );
    const args: IrExpr[] = [];
    if (lowerer.overrideBelow(info, name)) {
      lowerer.noteVirtualEdge(info, name);
      return {
        kind: "virtualCall",
        className: info.def.name,
        method: name,
        args: [lowerer.upcastTo(receiver, info.def.name), ...args],
        type: found.sig.ret,
        loc,
      };
    }
    lowerer.noteEdge(`%${found.declarer.def.name}.${name}`);
    return {
      kind: "call",
      callee: `%${found.declarer.def.name}.${name}`,
      args: [lowerer.upcastTo(receiver, found.declarer.def.name), ...args],
      type: found.sig.ret,
      loc,
    };
  }
  let result = inherited;
  // Deeper declarations are tested first.
  const declaring: ClassInfo[] = [];
  const visit = (c: ClassInfo): void => {
    for (const sub of c.subclasses) {
      if (sub.methods.has(name)) declaring.push(sub);
      else visit(sub);
    }
  };
  visit(info);
  for (const sub of declaring) {
    const call = instanceMethodCall(
      lowerer,
      blame,
      sub,
      { kind: "downcast", value: receiver, type: { kind: "object", className: sub.def.name }, loc },
      name,
      inherited,
      loc,
    );
    const type = result.type;
    result = {
      kind: "ternary",
      cond: { kind: "instanceOf", value: receiver, className: sub.def.name, type: BOOL, loc },
      then: lowerer.coerceToExpected(call, type),
      else_: result,
      type,
      loc,
    };
  }
  return result;
}

/** ToNumber of `value`, the lowered value of `node`. */
function numberValue(lowerer: Lowerer, node: ts.Expression, value: IrExpr, loc: SrcLoc): IrExpr {
  if (value.type.kind === "f64") return value;
  if (value.type.kind === "dyn")
    return { kind: "libCall", fn: "dyn.toNumberCoerce", args: [value], type: F64, loc };
  if (lowerer.dynConvertible(value.type))
    return {
      kind: "libCall",
      fn: "dyn.toNumberCoerce",
      args: [{ kind: "dynFrom", value, type: DYN, loc }],
      type: F64,
      loc,
    };
  return lowerer.coerceInto(node, value, F64);
}

/** A Date.prototype method a class rooted at `root` does not declare,
 * called on `receiver` (an instance of `info`, evaluated here once). The
 * method reads or sets the hidden time value; toJSON calls the instance's
 * toISOString, as Date.prototype.toJSON does. */
export function lowerInheritedDateMethodCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  name: string,
  info: ClassInfo,
  receiver: IrExpr,
): IrExpr {
  const root = dateRootOf(info)!;
  const loc = locOf(call);
  const local = lowerer.declareHiddenLocal("%dateReceiver", receiver.type);
  const value = varRef(local.id, receiver.type, loc);
  const stmts: IrStmt[] = [{ kind: "varDecl", localId: local.id, init: receiver, loc }];
  const args = call.arguments.nodes;
  if (args.some(ts.isSpreadElement))
    lowerer.unsupported("SC1090", call, `spread arguments to 'Date.prototype.${name}'`);
  const done = (result: IrExpr): IrExpr => ({
    kind: "seqExpr",
    stmts,
    result,
    type: result.type,
    loc,
  });
  if (isDateSetter(name) && name !== "setTime") {
    // The field setters change the Date the class's time slot holds once
    // the arguments are evaluated: an argument that calls setTime on the
    // instance gives the slot a new Date.
    const date = lowerer.declareHiddenLocal("%dateTime", DATE_T);
    const current = varRef(date.id, DATE_T, loc);
    const time: IrExpr = { kind: "libCall", fn: "date.getTime", args: [current], type: F64, loc };
    const next = dateSetterTime(lowerer, call, name, stmts, time);
    stmts.push({
      kind: "varDecl",
      localId: date.id,
      init: timeOf(lowerer, value, root, loc),
      loc,
    });
    return done({ kind: "libCall", fn: "date.store", args: [current, next], type: F64, loc });
  }
  if (name === "setTime") {
    // Every argument is evaluated before setTime converts the first one.
    let ms: IrExpr = { kind: "numLit", value: Number.NaN, type: F64, loc };
    if (args[0]) {
      const first = lowerer.lowerExpr(args[0]);
      const saved = lowerer.declareHiddenLocal("%dateArgument", first.type);
      stmts.push({ kind: "varDecl", localId: saved.id, init: first, loc: locOf(args[0]) });
      ms = numberValue(lowerer, args[0], varRef(saved.id, first.type, loc), loc);
    }
    for (const arg of args.slice(1))
      stmts.push({ kind: "exprStmt", expr: lowerer.lowerExpr(arg), loc: locOf(arg) });
    const time = lowerer.declareHiddenLocal("%dateTime", DATE_T);
    stmts.push(
      {
        kind: "varDecl",
        localId: time.id,
        init: { kind: "libCall", fn: "date.newMs", args: [ms], type: DATE_T, loc },
        loc,
      },
      {
        kind: "fieldSet",
        obj: lowerer.upcastTo(value, root.def.name),
        className: root.def.name,
        field: DATE_TIME_FIELD,
        value: varRef(time.id, DATE_T, loc),
        loc,
      },
    );
    return done({
      kind: "libCall",
      fn: "date.getTime",
      args: [varRef(time.id, DATE_T, loc)],
      type: F64,
      loc,
    });
  }
  for (const arg of args) {
    if (name !== "toJSON")
      lowerer.noLowering(`Date.prototype.${name} with arguments`, call, DATE_METHOD_HINT);
    stmts.push({ kind: "exprStmt", expr: lowerer.lowerExpr(arg), loc: locOf(arg) });
  }
  if (name === "toJSON") return done(dateClassToJson(lowerer, call, info, value, loc));
  const result = dateValueMethod(name, timeOf(lowerer, value, root, loc), loc);
  if (!result) lowerer.noLowering(`Date.prototype.${name}`, call, DATE_METHOD_HINT);
  return done(result);
}

/** Date.prototype.toJSON on `value` (a variable read of an instance of
 * `info`): null for an invalid time, else the instance's toISOString(). */
function dateClassToJson(
  lowerer: Lowerer,
  blame: ts.Node,
  info: ClassInfo,
  value: IrExpr,
  loc: SrcLoc,
): IrExpr {
  const root = dateRootOf(info)!;
  const time: IrExpr = {
    kind: "libCall",
    fn: "date.getTime",
    args: [timeOf(lowerer, value, root, loc)],
    type: F64,
    loc,
  };
  const type = dateJsonType(lowerer);
  const iso = instanceMethodCall(
    lowerer,
    blame,
    info,
    value,
    "toISOString",
    {
      kind: "libCall",
      fn: "date.toISOStringValue",
      args: [timeOf(lowerer, value, root, loc)],
      type: STRING,
      loc,
    },
    loc,
  );
  return {
    kind: "ternary",
    // An invalid date's time value is NaN, the one value unequal to itself.
    cond: { kind: "bin", op: "!==", left: time, right: time, type: BOOL, loc },
    then: lowerer.coerceToExpected({ kind: "unitLit", unit: "null", type: NULL_T, loc }, type),
    else_: lowerer.coerceToExpected(iso, type),
    type,
    loc,
  };
}

/** `super.name(...)` in a class whose base chain declares no `name`, when
 * the chain is rooted at a class declared `extends Date`. */
export function lowerDateSuperMethodCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  name: string,
  cls: ClassInfo,
  thisRef: IrExpr,
): IrExpr | null {
  if (!dateRootOf(cls) || !isDatePrototypeMethod(name)) return null;
  // Date.prototype.toJSON reads this.toISOString, which this class or a
  // subclass may declare.
  return lowerInheritedDateMethodCall(lowerer, call, name, cls, thisRef);
}

const DATE_CLASS_TIME = "%date.classTime";
const DATE_CLASS_METHOD = "%date.classMethod";

/** The classes of a program rooted at a class declared `extends Date`. */
function dateClasses(lowerer: Lowerer): ClassInfo[] {
  return [...lowerer.classes.values()].filter(
    (info) => !info.def.runtime && !info.generic && dateRootOf(info) !== null,
  );
}

const PARAMS = ["op", "value", "argument"];

/** A lifted `(op, value, argument)` function over checked-dynamic values. */
function liftOperation(lowerer: Lowerer, name: string, body: IrStmt[], loc: SrcLoc): void {
  lowerer.liftedFns.push({
    name,
    params: PARAMS.map((p) => ({ localId: p, name: p, type: DYN })),
    returnType: DYN,
    locals: PARAMS.map((p) => ({ id: p, name: p, type: DYN, mutable: false })),
    body,
    loc,
  });
}

function opIs(code: number, loc: SrcLoc): IrExpr {
  return {
    kind: "bin",
    op: "===",
    left: { kind: "dynCheck", value: varRef("op", DYN, loc), type: F64, loc },
    right: { kind: "numLit", value: code, type: F64, loc },
    type: BOOL,
    loc,
  };
}

/** Lifts `%date.classMethod(op, value, argument)` when the program declares
 * a class that extends Date: ops 2 to 5 call `value`'s toISOString,
 * toJSON(argument), toString and valueOf as checked-dynamic method calls,
 * which the class dispatch resolves to each class's declarations and the
 * runtime to the inherited Date methods. Called before the class dispatch
 * runs over the lowered functions. */
export function noteDateClassMethods(lowerer: Lowerer): void {
  if (lowerer.liftedFnNamed(DATE_CLASS_METHOD)) return;
  const classes = dateClasses(lowerer);
  if (classes.length === 0) return;
  const loc = classes[0]!.def.loc;
  const value = varRef("value", DYN, loc);
  const body: IrStmt[] = ["toISOString", "toJSON", "toString", "valueOf"].map(
    (method, index): IrStmt => ({
      kind: "if",
      cond: opIs(index + 2, loc),
      then: [
        {
          kind: "return",
          value: {
            kind: "dynInvoke",
            recv: value,
            method,
            calleeName: method,
            args: method === "toJSON" ? [varRef("argument", DYN, loc)] : [],
            type: DYN,
            loc,
          },
          loc,
        },
      ],
      else_: null,
      loc,
    }),
  );
  body.push({ kind: "return", value: dynUndefinedExpr(loc), loc });
  liftOperation(lowerer, DATE_CLASS_METHOD, body, loc);
}

/** %main's installation of the functions the runtime calls for a
 * checked-dynamic value that holds an instance of a class declared `extends
 * Date` (scr_date_class_operation_install). `%date.classTime(op, value,
 * argument)` answers the time value for op 0 (undefined for any other
 * value), sets it from the number `argument` for op 1 and answers the
 * class's name for op 6; `%date.classMethod` (noteDateClassMethods) calls
 * its methods. */
export function dateClassOperationPrelude(lowerer: Lowerer, loc: SrcLoc): IrStmt[] {
  const classes = dateClasses(lowerer);
  if (classes.length === 0) return [];
  noteDateClassMethods(lowerer);
  const value = varRef("value", DYN, loc);
  const argument = varRef("argument", DYN, loc);
  const body: IrStmt[] = [];
  for (const info of classes) {
    const root = dateRootOf(info)!;
    const type: IrType = { kind: "object", className: info.def.name };
    const instance: IrExpr = { kind: "dynCheck", value, type, loc };
    body.push({
      kind: "if",
      cond: {
        kind: "libCall",
        fn: "dyn.typedRefIs",
        args: [value, { kind: "strLit", value: typeKey(type), type: STRING, loc }],
        type: BOOL,
        loc,
      },
      then: [
        {
          kind: "if",
          cond: opIs(6, loc),
          then: [
            {
              kind: "return",
              value: {
                kind: "dynFrom",
                value: {
                  kind: "strLit",
                  value: info.def.jsName ?? info.def.name,
                  type: STRING,
                  loc,
                },
                type: DYN,
                loc,
              },
              loc,
            },
          ],
          else_: null,
          loc,
        },
        {
          kind: "if",
          cond: opIs(1, loc),
          then: [
            {
              kind: "fieldSet",
              obj: lowerer.upcastTo(instance, root.def.name),
              className: root.def.name,
              field: DATE_TIME_FIELD,
              value: {
                kind: "libCall",
                fn: "date.newMs",
                args: [{ kind: "dynCheck", value: argument, type: F64, loc }],
                type: DATE_T,
                loc,
              },
              loc,
            },
          ],
          else_: null,
          loc,
        },
        {
          kind: "return",
          value: {
            kind: "dynFrom",
            value: {
              kind: "libCall",
              fn: "date.getTime",
              args: [timeOf(lowerer, instance, root, loc)],
              type: F64,
              loc,
            },
            type: DYN,
            loc,
          },
          loc,
        },
      ],
      else_: null,
      loc,
    });
  }
  body.push({ kind: "return", value: dynUndefinedExpr(loc), loc });
  liftOperation(lowerer, DATE_CLASS_TIME, body, loc);
  const closure = (fnName: string): IrExpr => ({
    kind: "dynFrom",
    value: {
      kind: "closure",
      fnName,
      captures: [],
      type: { kind: "func", params: [DYN, DYN, DYN], ret: DYN },
      loc,
    },
    type: DYN,
    loc,
  });
  return [
    {
      kind: "exprStmt",
      expr: {
        kind: "libCall",
        fn: "date.classOperation",
        args: [closure(DATE_CLASS_TIME), closure(DATE_CLASS_METHOD)],
        type: VOID,
        loc,
      },
      loc,
    },
  ];
}
