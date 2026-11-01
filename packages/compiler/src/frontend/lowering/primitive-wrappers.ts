/* Primitive wrapper objects (`new String(s)`, `new Number(n)`, `new
 * Boolean(b)`, `Object(primitive)`) in JavaScript sources. A wrapper is an
 * ordinary dynamic object (scr_js_wrapper.c): its prototype is the
 * wrapper unit's String/Number/Boolean prototype object, whose valueOf,
 * toString and methods read the [[PrimitiveValue]] slot, and a String
 * wrapper owns its index properties and `length`. Every generic dynamic
 * operation (ToPrimitive, property reads, method calls, key listing,
 * identity, typeof) already handles that shape; this module builds the
 * values and routes the few consumers that must see the slot itself. */
import * as ts from "../ts7/adapter.js";
import {
  BOOL,
  DYN,
  F64,
  STRING,
  type IrExpr,
  type IrFunction,
  type IrStmt,
  type SrcLoc,
} from "../../ir/ir.js";
import { transformStmtList } from "../../ir/traverse.js";
import { isJsSourceFile, locOf } from "../program.js";
import type { Lowerer } from "./lowerer.js";
import { primitiveCtorClosure } from "./lower-exprs.js";

export type WrapperKind = "String" | "Number" | "Boolean";

/** The runtime's kind numbers (scr_js_wrapper.c SCR_JS_WRAPPER_*). */
export const WRAPPER_KIND_NUMBER: Record<WrapperKind, number> = {
  String: 0,
  Number: 1,
  Boolean: 2,
};

/** Whether any compiled source creates a primitive wrapper: a `new` of the
 * stdlib String, Number or Boolean constructor (with or without an
 * argument: `new String()` is a wrapper over "", `new Number()` over 0 and
 * `new Boolean()` over false), or a call of the stdlib Object with an
 * argument. `new Object()` without one is a fresh plain object, so it is
 * not a wrapper. Until a program has one, no value is a wrapper, so the
 * boxed interface types keep their primitive mapping and every fold that
 * relies on it stays. */
export function programCreatesWrappers(lowerer: Lowerer): boolean {
  for (const sf of lowerer.program.getSourceFiles()) {
    if (sf.isDeclarationFile || !isJsSourceFile(sf)) continue;
    const text = sf.text;
    if (
      !text.includes("String") &&
      !text.includes("Number") &&
      !text.includes("Boolean") &&
      !text.includes("Object")
    )
      continue;
    let found = false;
    const visit = (node: ts.Node): void => {
      if (found) return;
      if (
        (ts.isNewExpression(node) || ts.isCallExpression(node)) &&
        ts.isIdentifier(node.expression)
      ) {
        const name = node.expression.text;
        // A `new` of a boxed constructor is a wrapper even without an
        // argument; Object is a wrapper site only when it converts a value.
        const wrapperNew =
          ts.isNewExpression(node) &&
          (name === "String" || name === "Number" || name === "Boolean");
        const toObject = name === "Object" && (node.arguments?.nodes.length ?? 0) > 0;
        if ((wrapperNew || toObject) && lowerer.isStdlibGlobal(node.expression, name)) {
          found = true;
          return;
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    if (found) return true;
  }
  return false;
}

/** `new String(x)` / `new Number(x)` / `new Boolean(x)` in a JavaScript
 * source: the wrapper over ToString/ToNumber/ToBoolean of the argument
 * (the runtime converts, with the object hooks), or over "", 0, false
 * without one. Null outside JavaScript sources and for other callees. */
export function lowerWrapperNew(lowerer: Lowerer, expr: ts.NewExpression): IrExpr | null {
  if (!isJsSourceFile(ts.getSourceFileOfNode(expr))) return null;
  if (!ts.isIdentifier(expr.expression)) return null;
  const kind = expr.expression.text;
  if (kind !== "String" && kind !== "Number" && kind !== "Boolean") return null;
  if (!lowerer.isStdlibGlobal(expr.expression, kind)) return null;
  const args = expr.arguments?.nodes ?? [];
  if (args.some(ts.isSpreadElement)) return null;
  const loc = locOf(expr);
  // Arguments past the first are evaluated and ignored.
  const value: IrExpr =
    args.length > 0
      ? lowerer.lowerExprExpecting(args[0]!, DYN)
      : lowerer.coerceToExpected(
          kind === "String"
            ? { kind: "strLit", value: "", type: STRING, loc }
            : kind === "Number"
              ? { kind: "numLit", value: 0, type: F64, loc }
              : { kind: "boolLit", value: false, type: BOOL, loc },
          DYN,
        );
  const rest = args.slice(1).map((arg) => ({
    kind: "exprStmt" as const,
    expr: lowerer.lowerExpr(arg),
    loc: locOf(arg),
  }));
  const created: IrExpr = {
    kind: "libCall",
    fn: "wrapper.new",
    args: [
      { kind: "numLit", value: WRAPPER_KIND_NUMBER[kind], type: F64, loc },
      value,
      ...wrapperConstructors(lowerer, loc),
    ],
    type: DYN,
    loc,
  };
  if (rest.length === 0) return created;
  const local = lowerer.declareHiddenLocal("%wrapperArg", DYN);
  return {
    kind: "seqExpr",
    stmts: [{ kind: "varDecl", localId: local.id, init: value, loc }, ...rest],
    result: {
      ...created,
      args: [
        created.args[0]!,
        { kind: "varRef", localId: local.id, type: DYN, loc },
        ...created.args.slice(2),
      ],
    },
    type: DYN,
    loc,
  };
}

/** The String, Number and Boolean constructor values, for the prototypes'
 * `constructor` property (the interned closures `x === String` compares). */
export function wrapperConstructors(lowerer: Lowerer, loc: SrcLoc): IrExpr[] {
  return (["String", "Number", "Boolean"] as const).map((name) =>
    lowerer.coerceToExpected(primitiveCtorClosure(lowerer, name, loc, true), DYN),
  );
}

/** Consumers that walk a dynamic value's whole graph and must see the
 * [[PrimitiveValue]] slot (JSON's unwrapping, util.inspect's `[String:
 * 'x']`, structuredClone's wrapper clone, deep equality's primitive
 * compare). Until they know the slot, a wrapper reaching one refuses: each
 * dynamic argument passes through wrapper.guard, which throws the
 * not-supported Error when the value's own data graph holds a wrapper. */
export const GUARDED_CONSUMERS: ReadonlySet<string> = new Set([
  "json.stringifyValue",
  "json.stringifyReplacer",
  "util.isDeepStrictEqual",
  "dyn.structuredClone",
  "assert.looseDeepDyn",
  "assert.partialDeepDyn",
  "console.dirDyn",
  "insp.format",
  "insp.formatPrimitives",
  "insp.formatList",
  "insp.formatWithOptions",
  "insp.inspect",
  "insp.dynS",
  "insp.dynFormatS",
]);

/** util.types brands that read the [[PrimitiveValue]] slot. */
const WRAPPER_TYPE_PROBES: ReadonlySet<string> = new Set([
  "isStringObject",
  "isNumberObject",
  "isBooleanObject",
  "isBoxedPrimitive",
]);

/** The consumer as the refusal names it. */
export function consumerName(fn: string): string {
  if (fn.startsWith("json.")) return "JSON.stringify";
  if (fn === "dyn.structuredClone") return "structuredClone";
  if (fn === "util.isDeepStrictEqual") return "util.isDeepStrictEqual";
  if (fn.startsWith("assert.")) return "assert's deep equality";
  return "console.log/util.inspect";
}

function guarded(arg: IrExpr, fn: string): IrExpr {
  const consumer = consumerName(fn);
  if (arg.type.kind !== "dyn" && !(arg.type.kind === "array" && arg.type.elem.kind === "dyn"))
    return arg;
  return {
    kind: "libCall",
    fn: arg.type.kind === "dyn" ? "wrapper.guard" : "wrapper.guardList",
    args: [arg, { kind: "strLit", value: consumer, type: STRING, loc: arg.loc }],
    type: arg.type,
    loc: arg.loc,
  };
}

/** In a program that creates wrappers, route the consumers that read
 * internal slots: Object.prototype.toString's tag and the util.types
 * brands answer from the slot (wrapper.objectTag, wrapper.typeIs), and the
 * graph-walking consumers above guard their dynamic arguments. Programs
 * without a wrapper site keep every node unchanged. */
export function routeWrapperConsumers(lowerer: Lowerer, functions: IrFunction[]): void {
  if (!(lowerer.createsWrappers ??= programCreatesWrappers(lowerer))) return;
  const transform = {
    expr: (expr: IrExpr): IrExpr => {
      if (expr.kind === "libCall") {
        if (expr.fn === "dyn.objectTag") return { ...expr, fn: "wrapper.objectTag" };
        if (
          expr.fn === "util.typeIs" &&
          expr.args[1]?.kind === "strLit" &&
          WRAPPER_TYPE_PROBES.has(expr.args[1].value)
        )
          return { ...expr, fn: "wrapper.typeIs" };
        if (GUARDED_CONSUMERS.has(expr.fn))
          return { ...expr, args: expr.args.map((arg) => guarded(arg, expr.fn)) };
      }
      if (
        expr.kind === "intrinsic" &&
        (expr.name === "console.log" || expr.name === "console.error")
      )
        return { ...expr, args: expr.args.map((arg) => guarded(arg, expr.name)) };
      return expr;
    },
    stmt: (stmt: IrStmt): IrStmt => stmt,
  };
  for (const fn of functions) fn.body = transformStmtList(fn.body, transform);
}

/** `Object(x)` / `new Object(x)` over a checked-dynamic `x` in a program
 * that creates wrappers: ToObject (wrapper.toObject), a wrapper for a
 * primitive, the value itself for an object, a fresh object for null and
 * undefined. */
export function lowerWrapperToObject(lowerer: Lowerer, value: IrExpr, loc: SrcLoc): IrExpr {
  const ctors = wrapperConstructors(lowerer, loc);
  return { kind: "libCall", fn: "wrapper.toObject", args: [value, ...ctors], type: DYN, loc };
}
