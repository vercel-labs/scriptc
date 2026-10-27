import * as ts from "../../ts7/adapter.js";
import { type Lowerer, own } from "../lowerer.js";
import { locOf } from "../../program.js";
import { tryLowerExpression } from "../expressions/try-lower-expression.js";
import { lowerToNumberArguments } from "../lower-exprs.js";
import { programDeclaresDateClass } from "./date-classes.js";
import {
  BOOL,
  DATE_T,
  F64,
  type IrExpr,
  type IrLibFn,
  type IrLocal,
  type IrStmt,
  type IrType,
  NULL_T,
  type SrcLoc,
  STRING,
  typeKey,
} from "../../../ir/ir.js";

const DATE_GETTER_FNS: Readonly<Record<string, IrLibFn>> = {
  getFullYear: "date.getFullYear",
  getUTCFullYear: "date.getUTCFullYear",
  getMonth: "date.getMonth",
  getUTCMonth: "date.getUTCMonth",
  getDate: "date.getDate",
  getUTCDate: "date.getUTCDate",
  getDay: "date.getDay",
  getUTCDay: "date.getUTCDay",
  getHours: "date.getHours",
  getUTCHours: "date.getUTCHours",
  getMinutes: "date.getMinutes",
  getUTCMinutes: "date.getUTCMinutes",
  getSeconds: "date.getSeconds",
  getUTCSeconds: "date.getUTCSeconds",
  getMilliseconds: "date.getMilliseconds",
  getUTCMilliseconds: "date.getUTCMilliseconds",
  getTimezoneOffset: "date.getTimezoneOffset",
};

/** The setters that change calendar fields: the field code
 * scr_date_set_fields takes (scr_number.h SCR_DATE_SET_*; 8 marks the UTC
 * forms) and the most arguments each takes. */
const DATE_FIELD_SETTERS: ReadonlyMap<string, { code: number; max: number }> = new Map([
  ["setMilliseconds", { code: 0, max: 1 }],
  ["setSeconds", { code: 1, max: 2 }],
  ["setMinutes", { code: 2, max: 3 }],
  ["setHours", { code: 3, max: 4 }],
  ["setDate", { code: 4, max: 1 }],
  ["setMonth", { code: 5, max: 2 }],
  ["setFullYear", { code: 6, max: 3 }],
  ["setUTCMilliseconds", { code: 8, max: 1 }],
  ["setUTCSeconds", { code: 9, max: 2 }],
  ["setUTCMinutes", { code: 10, max: 3 }],
  ["setUTCHours", { code: 11, max: 4 }],
  ["setUTCDate", { code: 12, max: 1 }],
  ["setUTCMonth", { code: 13, max: 2 }],
  ["setUTCFullYear", { code: 14, max: 3 }],
]);

/** Whether `name` is a Date setter scriptc lowers: setTime or a field
 * setter. */
export function isDateSetter(name: string): boolean {
  return name === "setTime" || DATE_FIELD_SETTERS.has(name);
}

const DATE_TEXT_FNS: ReadonlyMap<string, IrLibFn> = new Map([
  ["toString", "date.toString"],
  ["toDateString", "date.toDateString"],
  ["toTimeString", "date.toTimeString"],
]);

export const DATE_METHOD_HINT =
  "getTime(), valueOf(), toISOString(), toUTCString(), toJSON(), toString(), toDateString(), toTimeString(), the local/UTC calendar getters and setters, setTime(), and getTimezoneOffset() are supported; locale formatters have no lowering";

/** Date statics and methods on Date objects (a TimeClip'd millisecond
 * time value with identity): getters, text forms and setters.
 * Construction lives in lowerNew. */
export function lowerDateCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  // An optional chain lowers the call again once it has narrowed the
  // receiver (Lowerer.chainHandled).
  if (
    (call.questionDotToken && !lowerer.chainHandled.has(call)) ||
    (access.questionDotToken && !lowerer.chainHandled.has(access))
  )
    return null;
  const loc = locOf(call);
  const member = lowerer.stdlibGlobalMember(access, "Date");
  if (member === "now" || member === "parse" || member === "UTC")
    return lowerDateStaticCall(lowerer, call, member);
  if (lowerer.mapTypeOf(lowerer.typeOf(access.expression))?.kind !== "date") return null;
  if (!lowerer.isStdlibMember(access)) return null;
  const name = access.name.text;
  // A Date a JavaScript file constructs is a checked-dynamic value; a
  // setter on it takes the dynamic method call, which changes the Date the
  // handle holds. So does every Date method on a
  // checked-dynamic receiver when the program declares a class that extends
  // Date: the value can be an instance, whose class may declare the method.
  if (
    (isDateSetter(name) || programDeclaresDateClass(lowerer)) &&
    tryLowerExpression(lowerer, access.expression)?.type.kind === "dyn"
  )
    return null;
  if (name === "toJSON") return lowerDateToJson(lowerer, call, access);
  if (isDateSetter(name)) return lowerDateSetter(lowerer, call, access, name);
  if (call.arguments.nodes.length !== 0) {
    lowerer.noLowering(`Date.prototype.${name} with arguments`, call, DATE_METHOD_HINT);
  }
  const raw = lowerer.lowerExpr(access.expression);
  const receiver: IrExpr =
    raw.type.kind === "dyn"
      ? { kind: "libCall", fn: "date.checkedValue", args: [raw], type: { kind: "date" }, loc }
      : raw;
  if (receiver.type.kind !== "date")
    lowerer.badType(access.expression, lowerer.typeOf(access.expression));
  const result = dateValueMethod(name, receiver, loc);
  if (result) return result;
  lowerer.noLowering(
    `Date.prototype.${name}`,
    call,
    DATE_METHOD_HINT,
    lowerer.checker.getSymbolAtLocation(access.name),
  );
}

/** Date.now(), Date.parse(text) and Date.UTC(...), also called through a
 * class declared `extends Date`, which inherits them. Null for other
 * names. */
export function lowerDateStaticCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  name: string,
): IrExpr | null {
  const loc = locOf(call);
  if (name === "now") {
    if (call.arguments.nodes.length !== 0) {
      lowerer.noLowering(`Date.now with ${call.arguments.nodes.length} arguments`, call);
    }
    return { kind: "libCall", fn: "date.now", args: [], type: F64, loc };
  }
  // Date.parse uses the same date-string parser as new Date(dateString)
  // (V8's grammar in the runtime), so their NaN and TimeClip behavior agree.
  if (name === "parse") {
    if (call.arguments.nodes.length !== 1 || ts.isSpreadElement(call.arguments.nodes[0]!)) {
      lowerer.noLowering(`Date.parse with ${call.arguments.nodes.length} arguments`, call);
    }
    const input = lowerer.lowerExprExpecting(call.arguments.nodes[0]!, STRING);
    return { kind: "libCall", fn: "date.parse", args: [input], type: F64, loc };
  }
  // Date.UTC(year[, month[, date[, hours[, minutes[, seconds[, ms]]]]]]):
  // a pure function of its numbers — the runtime's MakeDay/MakeTime/
  // TimeClip. Omitted trailing arguments complete with the spec's
  // defaults (month 0, date 1, time parts 0); tsc pins every present
  // argument to number, so the seven-f64 ABI is exact.
  if (name === "UTC") {
    if (
      call.arguments.nodes.length < 1 ||
      call.arguments.nodes.length > 7 ||
      call.arguments.nodes.some((a) => ts.isSpreadElement(a))
    ) {
      lowerer.noLowering(`Date.UTC with ${call.arguments.nodes.length} arguments`, call);
    }
    const defaults = [0, 0, 1, 0, 0, 0, 0]; // year is always present (arity ≥ 1)
    const args: IrExpr[] = [];
    for (let i = 0; i < 7; i++) {
      const a = call.arguments.nodes[i];
      args.push(
        a !== undefined
          ? lowerer.lowerExprExpecting(a, F64)
          : { kind: "numLit", value: defaults[i]!, type: F64, loc },
      );
    }
    return { kind: "libCall", fn: "date.utc", args, type: F64, loc };
  }
  return null;
}

/** The Date methods without arguments that have a lowering, applied to the
 * time value `value` (a `date`): getTime, valueOf, toISOString,
 * toUTCString, the calendar getters and the text forms. Null for other
 * names. */
export function dateValueMethod(name: string, value: IrExpr, loc: SrcLoc): IrExpr | null {
  if (name === "getTime" || name === "valueOf") {
    return {
      kind: "libCall",
      fn: name === "getTime" ? "date.getTime" : "date.valueOf",
      args: [value],
      type: F64,
      loc,
    };
  }
  if (name === "toISOString") {
    return { kind: "libCall", fn: "date.toISOStringValue", args: [value], type: STRING, loc };
  }
  if (name === "toUTCString") {
    return { kind: "libCall", fn: "date.toUTCString", args: [value], type: STRING, loc };
  }
  const fn = own(DATE_GETTER_FNS, name);
  if (fn !== undefined) {
    return { kind: "libCall", fn, args: [value], type: F64, loc };
  }
  const textFn = DATE_TEXT_FNS.get(name);
  if (textFn !== undefined) {
    return { kind: "libCall", fn: textFn, args: [value], type: STRING, loc };
  }
  return null;
}

/** `d.toJSON(key?)`: Node answers null for an invalid date and the
 * `toISOString()` string otherwise, as `string | null` (the lib types say
 * `string`). The argument is evaluated and ignored, as the built-in does. */
function lowerDateToJson(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr {
  const loc = locOf(call);
  if (call.arguments.nodes.length > 1 || call.arguments.nodes.some((a) => ts.isSpreadElement(a)))
    lowerer.noLowering(`Date.prototype.toJSON with ${call.arguments.nodes.length} arguments`, call);
  const raw = lowerer.lowerExpr(access.expression);
  const receiver: IrExpr =
    raw.type.kind === "dyn"
      ? { kind: "libCall", fn: "date.checkedValue", args: [raw], type: { kind: "date" }, loc }
      : raw;
  if (receiver.type.kind !== "date")
    lowerer.badType(access.expression, lowerer.typeOf(access.expression));
  const date = lowerer.declareHiddenLocal("%date", receiver.type);
  const stmts: IrStmt[] = [{ kind: "varDecl", localId: date.id, init: receiver, loc }];
  const key = call.arguments.nodes[0];
  if (key) stmts.push({ kind: "exprStmt", expr: lowerer.lowerExpr(key), loc });
  const value: IrExpr = { kind: "varRef", localId: date.id, type: receiver.type, loc };
  const time: IrExpr = { kind: "libCall", fn: "date.getTime", args: [value], type: F64, loc };
  const type = dateJsonType(lowerer);
  return {
    kind: "seqExpr",
    stmts,
    result: {
      kind: "ternary",
      // An invalid date's time value is NaN, the one value unequal to itself.
      cond: { kind: "bin", op: "!==", left: time, right: time, type: BOOL, loc },
      then: lowerer.coerceToExpected({ kind: "unitLit", unit: "null", type: NULL_T, loc }, type),
      else_: lowerer.coerceToExpected(
        { kind: "libCall", fn: "date.toISOStringValue", args: [value], type: STRING, loc },
        type,
      ),
      type,
      loc,
    },
    type,
    loc,
  };
}

/** `string | null`, the type of a Date's `toJSON()` result. */
export function dateJsonType(lowerer: Lowerer): IrType {
  const arms = [STRING, NULL_T].sort((a, b) => (typeKey(a) < typeKey(b) ? -1 : 1));
  return { kind: "union", unionId: lowerer.unions.intern(arms) };
}

/** A Date `toJSON()` call, or a binding initialized by one
 * (Lowerer.dateJsonBindings): its value can be null where the lib types
 * say string. */
export function isDateJsonSource(lowerer: Lowerer, node: ts.Node): boolean {
  while (ts.isParenthesizedExpression(node)) node = node.expression;
  if (ts.isIdentifier(node)) {
    const symbol =
      node.parent && ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node
        ? lowerer.checker.getShorthandAssignmentValueSymbol(node.parent)
        : lowerer.checker.getSymbolAtLocation(node);
    return symbol !== undefined && lowerer.dateJsonBindings.has(symbol);
  }
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return false;
  const access = node.expression;
  return (
    access.name.text === "toJSON" &&
    !node.questionDotToken &&
    !access.questionDotToken &&
    lowerer.mapTypeOf(lowerer.typeOf(access.expression))?.kind === "date" &&
    lowerer.isStdlibMember(access)
  );
}

/** `d.setTime(t)` and the field setters (`d.setHours(h, m?, s?, ms?)` ...)
 * on a Date object: the receiver, then the arguments in order, then the
 * new time value (scr_date_set_fields over the time value the Date holds
 * once the arguments have run) stored into the Date and answered. Missing
 * optional arguments keep their fields; arguments past a setter's last
 * one are evaluated and ignored. A Date local that holds its time value
 * (date-values.ts) takes the new time value itself. */
function lowerDateSetter(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
  name: string,
): IrExpr {
  const loc = locOf(call);
  const nodes = call.arguments.nodes;
  if (nodes.some((node) => ts.isSpreadElement(node)))
    lowerer.noLowering(`Date.prototype.${name} with spread arguments`, call, DATE_METHOD_HINT);
  const timeLocal = timeValueLocalOf(lowerer, access.expression);
  const stmts: IrStmt[] = [];
  let receiver: IrExpr | null = null;
  if (timeLocal === null) {
    // A checked-dynamic receiver takes the dynamic method call
    // (lowerDateCall), so the value here is a Date object.
    const value = lowerer.lowerExpr(access.expression);
    if (value.type.kind !== "date")
      lowerer.badType(access.expression, lowerer.typeOf(access.expression));
    const date = lowerer.declareHiddenLocal("%date", DATE_T);
    stmts.push({ kind: "varDecl", localId: date.id, init: value, loc });
    receiver = { kind: "varRef", localId: date.id, type: DATE_T, loc };
  }
  const time: IrExpr =
    receiver === null
      ? { kind: "varRef", localId: timeLocal!.id, type: F64, loc }
      : { kind: "libCall", fn: "date.getTime", args: [receiver], type: F64, loc };
  const next = dateSetterTime(lowerer, call, name, stmts, time);
  if (receiver === null) {
    stmts.push({ kind: "assign", localId: timeLocal!.id, value: next, loc });
    return {
      kind: "seqExpr",
      stmts,
      result: { kind: "varRef", localId: timeLocal!.id, type: F64, loc },
      type: F64,
      loc,
    };
  }
  return {
    kind: "seqExpr",
    stmts,
    result: { kind: "libCall", fn: "date.store", args: [receiver, next], type: F64, loc },
    type: F64,
    loc,
  };
}

/** The new time value of setter `name` called with `call`'s arguments on a
 * Date whose time value `time` reads: the arguments evaluate into
 * temporaries appended to `stmts` (ToNumber of each, an undefined one is
 * NaN), and the result reads `time` after them. A missing first argument
 * is NaN; missing optional arguments keep their fields; arguments past a
 * setter's last one are evaluated and ignored. */
export function dateSetterTime(
  lowerer: Lowerer,
  call: ts.CallExpression,
  name: string,
  stmts: IrStmt[],
  time: IrExpr,
): IrExpr {
  const loc = locOf(call);
  const converted = lowerToNumberArguments(
    lowerer,
    call.arguments.nodes as readonly ts.Expression[],
  );
  stmts.push(...converted.stmts);
  const args: IrExpr[] = converted.values.map((value) => {
    if (value.kind === "numLit") return value;
    const arg = lowerer.declareHiddenLocal("%dateArg", F64);
    stmts.push({ kind: "varDecl", localId: arg.id, init: value, loc });
    return { kind: "varRef", localId: arg.id, type: F64, loc };
  });
  const number = (value: number): IrExpr => ({ kind: "numLit", value, type: F64, loc });
  if (name === "setTime")
    return {
      kind: "libCall",
      fn: "date.timeClip",
      args: [args[0] ?? number(Number.NaN)],
      type: F64,
      loc,
    };
  const setter = DATE_FIELD_SETTERS.get(name)!;
  // The first argument is required: a missing one is undefined, so NaN.
  const used = args.length === 0 ? [number(Number.NaN)] : args.slice(0, setter.max);
  const operands = [...used];
  while (operands.length < 4) operands.push(number(0));
  return {
    kind: "libCall",
    fn: "date.setFields",
    args: [time, number(setter.code), number(used.length), ...operands],
    type: F64,
    loc,
  };
}

/** The local a Date binding that holds its time value lowers to, for an
 * identifier `node` that names one (date-values.ts); null otherwise. */
function timeValueLocalOf(lowerer: Lowerer, node: ts.Expression): IrLocal | null {
  while (ts.isParenthesizedExpression(node)) node = node.expression;
  if (!ts.isIdentifier(node)) return null;
  const local = lowerer.resolveLocal(node);
  return local !== undefined && local !== null && lowerer.timeValueDateLocals.has(local)
    ? local
    : null;
}

/** `d[Symbol.toPrimitive](hint)` on a Date with a literal hint: "number"
 * answers the time value, "string" and "default" the toString() text (a
 * Date's default hint is a string). Null for other calls. */
export function lowerDateToPrimitiveCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.ElementAccessExpression,
): IrExpr | null {
  const key = access.argumentExpression;
  if (
    !ts.isPropertyAccessExpression(key) ||
    key.name.text !== "toPrimitive" ||
    !ts.isIdentifier(key.expression) ||
    !lowerer.isStdlibGlobal(key.expression, "Symbol") ||
    lowerer.mapTypeOf(lowerer.typeOf(access.expression))?.kind !== "date"
  )
    return null;
  const loc = locOf(call);
  const hint = call.arguments.nodes.length === 1 ? call.arguments.nodes[0]! : null;
  const text = hint !== null && ts.isStringLiteralLike(hint) ? hint.text : null;
  if (text !== "number" && text !== "string" && text !== "default")
    return lowerer.noLowering(
      'Date.prototype[Symbol.toPrimitive] without a "number", "string" or "default" literal hint',
      call,
    );
  const raw = lowerer.lowerExpr(access.expression);
  const date: IrExpr =
    raw.type.kind === "dyn"
      ? { kind: "libCall", fn: "date.checkedValue", args: [raw], type: DATE_T, loc }
      : raw;
  return text === "number"
    ? { kind: "libCall", fn: "date.valueOf", args: [date], type: F64, loc }
    : { kind: "libCall", fn: "date.toString", args: [date], type: STRING, loc };
}
