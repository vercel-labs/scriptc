import * as ts from "../../ts7/adapter.js";
import { type Lowerer, own } from "../lowerer.js";
import { locOf } from "../../program.js";
import {
  BOOL,
  F64,
  type IrExpr,
  type IrLibFn,
  type IrType,
  NULL_T,
  STRING,
  type SrcLoc,
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

const DATE_METHOD_HINT =
  "getTime(), valueOf(), toISOString(), the local/UTC calendar getters, and getTimezoneOffset() are supported; Date setters and locale/string formatters have no lowering";

/** Date.prototype.toJSON returns null when the time is not finite, and
 * otherwise the same ISO string as toISOString. toISOString still throws. */
function dateToJson(lowerer: Lowerer, receiver: IrExpr, loc: SrcLoc): IrExpr {
  const stored = lowerer.declareHiddenLocal("%dateJson", receiver.type);
  const ref: IrExpr = { kind: "varRef", localId: stored.id, type: stored.type, loc };
  const time: IrExpr = { kind: "libCall", fn: "date.getTime", args: [ref], type: F64, loc };
  const finite: IrExpr = { kind: "libCall", fn: "number.isFinite", args: [time], type: BOOL, loc };
  const type: IrType = { kind: "union", unionId: lowerer.unions.intern([STRING, NULL_T]) };
  const text = lowerer.coerceToExpected(
    { kind: "libCall", fn: "date.toISOStringValue", args: [ref], type: STRING, loc },
    type,
  );
  const empty = lowerer.coerceToExpected(
    { kind: "unitLit", unit: "null", type: NULL_T, loc },
    type,
  );
  return {
    kind: "seqExpr",
    stmts: [{ kind: "varDecl", localId: stored.id, init: receiver, loc }],
    result: { kind: "ternary", cond: finite, then: text, else_: empty, type, loc },
    type,
    loc,
  };
}

/** The Date slice: statics plus read-only Date values backed by one
 * TimeClip'd millisecond scalar. Construction lives in lowerNew;
 * identity and mutating methods remain fenced. */
export function lowerDateCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  if (call.questionDotToken || access.questionDotToken) return null;
  const loc = locOf(call);
  if (lowerer.stdlibGlobalMember(access, "Date") === "now") {
    if (call.arguments.length !== 0) {
      lowerer.noLowering(`Date.now with ${call.arguments.length} arguments`, call);
    }
    return { kind: "libCall", fn: "date.now", args: [], type: F64, loc };
  }
  // Date.parse uses the same bounded date-string parser as
  // new Date(dateString).getTime(); keep their NaN and TimeClip behavior
  // identical for the ISO timestamps used by CLI applications.
  if (lowerer.stdlibGlobalMember(access, "Date") === "parse") {
    if (call.arguments.length !== 1 || ts.isSpreadElement(call.arguments[0]!)) {
      lowerer.noLowering(`Date.parse with ${call.arguments.length} arguments`, call);
    }
    const input = lowerer.lowerExprExpecting(call.arguments[0]!, STRING);
    return { kind: "libCall", fn: "date.parse", args: [input], type: F64, loc };
  }
  // Date.UTC(year[, month[, date[, hours[, minutes[, seconds[, ms]]]]]]):
  // a pure function of its numbers — the runtime's MakeDay/MakeTime/
  // TimeClip. Omitted trailing arguments complete with the spec's
  // defaults (month 0, date 1, time parts 0); tsc pins every present
  // argument to number, so the seven-f64 ABI is exact.
  if (lowerer.stdlibGlobalMember(access, "Date") === "UTC") {
    if (
      call.arguments.length < 1 ||
      call.arguments.length > 7 ||
      call.arguments.some((a) => ts.isSpreadElement(a))
    ) {
      lowerer.noLowering(`Date.UTC with ${call.arguments.length} arguments`, call);
    }
    const defaults = [0, 0, 1, 0, 0, 0, 0]; // year is always present (arity ≥ 1)
    const args: IrExpr[] = [];
    for (let i = 0; i < 7; i++) {
      const a = call.arguments[i];
      args.push(
        a !== undefined
          ? lowerer.lowerExprExpecting(a, F64)
          : { kind: "numLit", value: defaults[i]!, type: F64, loc },
      );
    }
    return { kind: "libCall", fn: "date.utc", args, type: F64, loc };
  }
  if (lowerer.mapTypeOf(lowerer.typeOf(access.expression))?.kind !== "date") return null;
  if (!lowerer.isStdlibMember(access)) return null;
  const name = access.name.text;
  if (call.arguments.length !== 0) {
    lowerer.noLowering(`Date.prototype.${name} with arguments`, call, DATE_METHOD_HINT);
  }
  const raw = lowerer.lowerExpr(access.expression);
  const receiver: IrExpr =
    raw.type.kind === "dyn"
      ? { kind: "libCall", fn: "date.checkedValue", args: [raw], type: { kind: "date" }, loc }
      : raw;
  if (receiver.type.kind !== "date")
    lowerer.badType(access.expression, lowerer.typeOf(access.expression));
  if (name === "getTime" || name === "valueOf") {
    return {
      kind: "libCall",
      fn: name === "getTime" ? "date.getTime" : "date.valueOf",
      args: [receiver],
      type: F64,
      loc,
    };
  }
  if (name === "toJSON") return dateToJson(lowerer, receiver, loc);
  if (name === "toISOString") {
    return { kind: "libCall", fn: "date.toISOStringValue", args: [receiver], type: STRING, loc };
  }
  const fn = own(DATE_GETTER_FNS, name);
  if (fn !== undefined) {
    return { kind: "libCall", fn, args: [receiver], type: F64, loc };
  }
  lowerer.noLowering(
    `Date.prototype.${name}`,
    call,
    DATE_METHOD_HINT,
    lowerer.checker.getSymbolAtLocation(access.name),
  );
}
