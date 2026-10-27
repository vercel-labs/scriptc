import * as ts from "../../ts7/adapter.js";
import { type Lowerer, own } from "../lowerer.js";
import { lowerCheckedPredicateValue } from "../lower-builtin-values.js";
import { isJsSourceFile, locOf } from "../../program.js";
import { BOOL, F64, STRING, type IrExpr, type IrLibFn } from "../../../ir/ir.js";
import { lowerBuiltinValuePreservingUndefined, lowerOptionalNumberPredicate } from "./arguments.js";
import { tryLowerExpression } from "../expressions/try-lower-expression.js";
import { lowerStaticNumberGlobal } from "../lower-calls.js";
import { isUnitType, type IrType } from "../../../ir/ir.js";

/** A string, or a union of a string with undefined/null (the optional
 * forms the static parsers accept). */
function isStringLike(lowerer: Lowerer, type: IrType): boolean {
  if (type.kind === "string") return true;
  if (type.kind !== "union") return false;
  const arms = lowerer.unions.get(type.unionId)?.arms ?? [];
  return (
    arms.some((a) => a.kind === "string") && arms.every((a) => a.kind === "string" || isUnitType(a))
  );
}

/** The lowered Number statics, by member name. The predicate quartet has
 * static C implementations (JS-exact: the ES2015 statics never coerce, so
 * only f64-typed arguments route through — anything else fences honestly
 * instead of folding to false past possible side effects). */
const NUMBER_STATIC_PREDICATES: Record<string, IrLibFn | undefined> = {
  isFinite: "number.isFinite",
  isNaN: "number.isNaN",
  isInteger: "number.isInteger",
  isSafeInteger: "number.isSafeInteger",
};

/** The Number constants, baked as literals — non-finite ones included
 * (numLits carry NaN and the infinities; the backend preserves them). */
const NUMBER_CONSTANTS: Record<string, number | undefined> = {
  MAX_SAFE_INTEGER: 9007199254740991,
  MIN_SAFE_INTEGER: -9007199254740991,
  EPSILON: 2.220446049250313e-16,
  MAX_VALUE: 1.7976931348623157e308,
  MIN_VALUE: 5e-324,
  NaN: NaN,
  POSITIVE_INFINITY: Infinity,
  NEGATIVE_INFINITY: -Infinity,
};

export function lowerNumberStaticCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  if (call.questionDotToken) return null;
  const member = lowerer.stdlibGlobalMember(access, "Number");
  if (member === null) return null;
  const loc = locOf(call);
  const fn = own(NUMBER_STATIC_PREDICATES, member);
  if (fn !== undefined) {
    if (call.arguments.nodes.length !== 1) {
      lowerer.noLowering(`Number.${member} with ${call.arguments.nodes.length} arguments`, call);
    }
    const argNode = call.arguments.nodes[0]!;
    const arg = lowerBuiltinValuePreservingUndefined(lowerer, argNode);

    const optional = lowerOptionalNumberPredicate(lowerer, arg, fn, loc);
    if (optional) return optional;
    if (arg.type.kind !== "f64") {
      lowerer.noLowering(
        `Number.${member} of '${lowerer.fmt(arg.type)}' values`,
        argNode,
        "the Number statics never coerce — a statically non-number argument is constantly false in JS (narrow unions first, or write the constant)",
      );
    }
    return { kind: "libCall", fn, args: [arg], type: BOOL, loc };
  }
  if (member === "parseFloat" || member === "parseInt") {
    const count = call.arguments.nodes.length;
    if (count < 1 || count > (member === "parseFloat" ? 1 : 2)) {
      lowerer.noLowering(`Number.${member} with ${count} argument${count === 1 ? "" : "s"}`, call);
    }
    // Number.parseFloat/Number.parseInt ARE the global parsers: over a
    // string argument they lower to the same static parse (parseInt with
    // its radix, or radix 0 when it is missing); only the coercing argument
    // shapes are refused.
    const probed = tryLowerExpression(lowerer, call.arguments.nodes[0]!);
    if (probed !== null && isStringLike(lowerer, probed.type)) {
      const parsed = lowerStaticNumberGlobal(lowerer, member, call, call.arguments.nodes, loc);
      if (parsed !== null) return parsed;
    }
    // A checked-dynamic argument (`Number.parseInt(env.FORCE_COLOR, 10)`
    // over a JavaScript dictionary read): the parsers' own ToString,
    // exactly the global parseFloat's dyn form.
    if (probed?.type.kind === "dyn") {
      const text: IrExpr = {
        kind: "libCall",
        fn: "dyn.toStringCoerce",
        args: [probed],
        type: STRING,
        loc,
      };
      if (member === "parseFloat")
        return { kind: "libCall", fn: "num.parseFloat", args: [text], type: F64, loc };
      const radixNode = call.arguments.nodes[1];
      const radix: IrExpr = radixNode
        ? lowerer.lowerExprExpecting(radixNode, F64)
        : { kind: "numLit", value: 0, type: F64, loc };
      return { kind: "libCall", fn: "num.parseInt", args: [text, radix], type: F64, loc };
    }
    // JavaScript whose argument does not lower on its own (zod's
    // `Number.parseInt(val.toFixed(n).replace(".", ""))` over an untyped
    // parameter): the global parser's own JavaScript forms.
    if (probed === null && member === "parseInt" && isJsSourceFile(ts.getSourceFileOfNode(call))) {
      const parsed = lowerStaticNumberGlobal(lowerer, member, call, call.arguments.nodes, loc);
      if (parsed !== null) return parsed;
    }
    const argText =
      probed !== null
        ? lowerer.fmt(probed.type)
        : lowerer.checker.typeToString(lowerer.checker.getTypeAtLocation(call.arguments.nodes[0]!));
    lowerer.refuseUnsupportedApi(
      `'Number.${member}' with a '${argText}' argument`,
      call,
      "only a string argument compiles statically: convert the argument explicitly first (for example String(x), or narrow the union)",
    );
  }
  return null; // other Number statics land on the member fence
}

/** Property READS on THE `Number` global: the finite constants bake as
 * number literals. NaN/POSITIVE_INFINITY/NEGATIVE_INFINITY and method
 * members as values fall through to the member fence. Null for
 * non-Number receivers. */
export function lowerNumberStaticProperty(
  lowerer: Lowerer,
  expr: ts.PropertyAccessExpression,
): IrExpr | null {
  const member = lowerer.stdlibGlobalMember(expr, "Number");
  if (member === null) return null;
  const predicate = own(NUMBER_STATIC_PREDICATES, member);
  if (predicate)
    return lowerCheckedPredicateValue(
      lowerer,
      `Number.${member}`,
      "number",
      locOf(expr),
      predicate,
    );
  const value = own(NUMBER_CONSTANTS, member);
  if (value === undefined) return null;
  return { kind: "numLit", value, type: F64, loc: locOf(expr) };
}

/** The Event phase constants (Event.NONE ... Event.BUBBLING_PHASE),
 * which CustomEvent inherits through its constructor. */
const EVENT_PHASES: Record<string, number | undefined> = {
  NONE: 0,
  CAPTURING_PHASE: 1,
  AT_TARGET: 2,
  BUBBLING_PHASE: 3,
};

export function lowerEventStaticProperty(
  lowerer: Lowerer,
  expr: ts.PropertyAccessExpression,
): IrExpr | null {
  const member =
    lowerer.stdlibGlobalMember(expr, "Event") ?? lowerer.stdlibGlobalMember(expr, "CustomEvent");
  if (member === null) return null;
  const value = own(EVENT_PHASES, member);
  if (value === undefined) return null;
  return { kind: "numLit", value, type: F64, loc: locOf(expr) };
}
