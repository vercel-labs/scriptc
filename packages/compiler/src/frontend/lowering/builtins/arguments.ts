import { keyedHelperName } from "../stable-names.js";
import {
  BYTES_U8,
  BOOL,
  DYN,
  F64,
  type IrExpr,
  type IrLibFn,
  type IrType,
  STRING,
  type SrcLoc,
  UNDEFINED_T,
  VOID,
  funcOf,
  isUnitType,
  typeEquals,
  typeKey,
} from "../../../ir/ir.js";
import { boolLit, varRef } from "../../../ir/build.js";
import * as ts from "../../ts7/adapter.js";
import { type Lowerer } from "../lowerer.js";
import { locOf } from "../../program.js";
import { lowerAbsenceProbe } from "../lower-exprs.js";
import { bodyReadsArguments } from "../../arguments-usage.js";
import { defaultAfterUndefined, lowerStaticallyUndefinedArgument } from "../optional-arguments.js";
import { voidizedCallback } from "../lower-server.js";
export function optionalStringTags(
  lowerer: Lowerer,
  type: IrType,
): { stringTag: number; undefinedTag: number } | null {
  if (type.kind !== "union") return null;
  const def = lowerer.unions.get(type.unionId);
  if (!def || def.arms.length !== 2) return null;
  const stringTag = lowerer.armTag(type.unionId, STRING);
  const undefinedTag = lowerer.armTag(type.unionId, UNDEFINED_T);
  return stringTag >= 0 && undefinedTag >= 0 ? { stringTag, undefinedTag } : null;
}
export function lowerBuiltinValuePreservingUndefined(
  lowerer: Lowerer,
  node: ts.Expression,
): IrExpr {
  return (
    lowerer.runtimeOptionalIdentifierValue(node)?.value ??
    lowerAbsenceProbe(lowerer, node) ??
    lowerer.lowerExpr(node)
  );
}
export function checkedOptionalBuiltinArm(
  lowerer: Lowerer,
  value: IrExpr,
  target: IrType,
): IrExpr | null {
  const widened = lowerer.runtimeOptionalWidening(value.type, target);
  if (!widened || widened.kind !== "union") return null;
  const helper = lowerer.narrowedArmHelper(widened.unionId, target, value.loc);
  return helper
    ? { kind: "call", callee: helper, args: [value], type: target, loc: value.loc }
    : null;
}
export function lowerOptionalNumberPredicate(
  lowerer: Lowerer,
  value: IrExpr,
  fn: IrLibFn,
  loc: SrcLoc,
): IrExpr | null {
  // Number predicates do not coerce. In a mixed union only the numeric
  // arm runs the predicate; every other arm answers false after evaluating
  // the argument once. This includes the undefined added by array reads.
  const widened = value.type;
  if (widened.kind !== "union" && widened.kind !== "dyn") return null;
  const numberTag = widened.kind === "union" ? lowerer.armTag(widened.unionId, F64) : -1;
  if (widened.kind === "union" && numberTag < 0) return null;
  const key = `number.optionalPredicate:${fn}:${typeKey(widened)}`;
  let helper = lowerer.valueHelpers.get(key);
  if (!helper) {
    helper = keyedHelperName(lowerer, "%number.optionalPredicate", key);
    lowerer.valueHelpers.set(key, helper);
    const input = varRef("value.0", widened, loc);
    lowerer.liftedFns.push({
      name: helper,
      params: [{ localId: "value.0", name: "value", type: widened }],
      returnType: BOOL,
      locals: [{ id: "value.0", name: "value", type: widened, mutable: false }],
      body: [
        {
          kind: "if",
          cond:
            widened.kind === "dyn"
              ? { kind: "dynTest", test: "number", negated: true, value: input, type: BOOL, loc }
              : {
                  kind: "unionIsTag",
                  unionId: widened.unionId,
                  tag: numberTag,
                  negated: true,
                  value: input,
                  type: BOOL,
                  loc,
                },
          then: [{ kind: "return", value: boolLit(false, loc), loc }],
          else_: null,
          loc,
        },
        {
          kind: "return",
          value: {
            kind: "libCall",
            fn,
            args: [
              widened.kind === "dyn"
                ? { kind: "dynCheck", value: input, type: F64, loc }
                : {
                    kind: "unionNarrow",
                    unionId: widened.unionId,
                    tag: numberTag,
                    value: input,
                    type: F64,
                    loc,
                  },
            ],
            type: BOOL,
            loc,
          },
          loc,
        },
      ],
      loc,
    });
  }
  return { kind: "call", callee: helper, args: [value], type: BOOL, loc };
}
/** Complete an optional builtin argument. Statically undefined spellings
 * preserve their effects and select the default; a runtime unit-armed union
 * uses nullish selection when every non-unit arm is the expected type. */
export function lowerBuiltinOptionalDefault(
  lowerer: Lowerer,
  node: ts.Expression,
  expected: IrType,
  dflt: IrExpr,
  nullIsDefault = false,
): IrExpr {
  const undefinedArg = lowerStaticallyUndefinedArgument(lowerer, node);
  if (undefinedArg) return defaultAfterUndefined(undefinedArg, dflt);
  if (nullIsDefault && (lowerer.typeOf(node).flags & ts.TypeFlags.Null) !== 0) {
    return defaultAfterUndefined(lowerer.lowerExpr(node), dflt);
  }
  const value = lowerer.lowerExpr(node);
  if (value.type.kind === "union") {
    const def = lowerer.unions.get(value.type.unionId);
    const allowed = def?.arms.every(
      (arm) =>
        typeEquals(arm, expected) ||
        arm.kind === "undefinedT" ||
        (nullIsDefault && arm.kind === "nullT"),
    );
    if (allowed && def!.arms.some((arm) => isUnitType(arm))) {
      return { kind: "nullish", left: value, right: dflt, type: expected, loc: value.loc };
    }
  }
  return lowerer.coerceInto(node, value, expected);
}

/** Strips the type-only wrappers the require pattern rides in typed
 * code (`require("node:os") as typeof import("node:os")` — the
 * fallback declarations answer `unknown`, so the cast IS the idiom),
 * plus parens, legacy assertions, and non-null suffixes. */
export function stripTypeCasts(e: ts.Expression): ts.Expression {
  let cur = e;
  while (
    ts.isParenthesizedExpression(cur) ||
    ts.isAsExpression(cur) ||
    ts.isTypeAssertion(cur) ||
    ts.isNonNullExpression(cur)
  ) {
    cur = cur.expression;
  }
  return cur;
}

/** The literal `{ flag: true/false }` options shape: every property a
 * plain assignment with an identifier name from `allowed` and a boolean
 * LITERAL value (nothing to evaluate, so folding it away preserves JS
 * semantics exactly). Null for anything else — spreads, computed keys,
 * non-literal values, unknown flags. */
/** An options object literal split into literal-boolean flags (`allowed` —
 * these change WHICH lowering fires, so they must be spelled true/false)
 * and expression-valued members (`exprKeys` — number options like
 * maxRetries, lowered by the caller as ordinary expressions). Null when
 * any other member appears. */
export function literalBoolOptions(
  node: ts.Expression,
  allowed: string[],
  exprKeys: string[] = [],
): { bools: Record<string, boolean>; exprs: Record<string, ts.Expression> } | null {
  if (!ts.isObjectLiteralExpression(node)) return null;
  const bools: Record<string, boolean> = {};
  const exprs: Record<string, ts.Expression> = {};
  for (const p of node.properties.nodes) {
    if (!ts.isPropertyAssignment(p) || !ts.isIdentifier(p.name)) return null;
    if (exprKeys.includes(p.name.text)) {
      exprs[p.name.text] = p.initializer;
      continue;
    }
    if (!allowed.includes(p.name.text)) return null;
    if (p.initializer.kind === ts.SyntaxKind.TrueKeyword) bools[p.name.text] = true;
    else if (p.initializer.kind === ts.SyntaxKind.FalseKeyword) bools[p.name.text] = false;
    else return null;
  }
  return { bools, exprs };
}

/** One member of an options object literal: a plain `name: value`
 * assignment, or the shorthand `{ cwd }` — whose value IS the named
 * binding (the identifier lowers like any other read). Null for spreads,
 * computed keys, and accessors, which the callers fence. */
export function optionMember(
  p: ts.ObjectLiteralElementLike,
): { name: string; value: ts.Expression } | null {
  if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name)) {
    return { name: p.name.text, value: p.initializer };
  }
  if (ts.isShorthandPropertyAssignment(p)) {
    const shName = p.name as ts.Identifier; // shorthand names are identifiers
    return { name: shName.text, value: shName };
  }
  return null;
}

export function errorFirstBytesCallback(
  lowerer: Lowerer,
  node: ts.Expression,
  api: string,
  arrayBuffer = false,
): IrExpr {
  return errorFirstCallback(
    lowerer,
    node,
    api,
    (value) => !arrayBuffer && value.kind === "bytes" && value.elem === "u8",
    arrayBuffer ? "ArrayBuffer" : "Buffer/Uint8Array",
  );
}

/** Whether `type` is an error-first callback's error parameter type:
 * Error | null, optionally with undefined, or dyn. */
export function isErrorFirstErrorType(lowerer: Lowerer, type: IrType): boolean {
  if (type.kind === "dyn") return true;
  if (type.kind !== "union") return false;
  const def = lowerer.unions.get(type.unionId);
  return (
    !!def &&
    def.arms.some((arm) => arm.kind === "nullT") &&
    def.arms.some((arm) => arm.kind === "object" && arm.className === "%Error") &&
    def.arms.every(
      (arm) =>
        arm.kind === "nullT" ||
        arm.kind === "undefinedT" ||
        (arm.kind === "object" && arm.className === "%Error"),
    )
  );
}

/** An error-first callback (error, value) whose error parameter is
 * Error | null or dyn and whose value parameter is dyn or accepted by
 * `acceptValue`; `values` names the accepted values in the refusal. */
export function errorFirstCallback(
  lowerer: Lowerer,
  node: ts.Expression,
  api: string,
  acceptValue: (value: IrType) => boolean,
  values: string,
): IrExpr {
  // A literal here is called only by the callback adapter, which passes
  // null as the error whenever it passes a result (lowerUndefinedResultBody).
  // A named function expression can also call itself, and a function
  // expression can reach itself through `arguments.callee`.
  let literal: ts.Expression = node;
  while (ts.isParenthesizedExpression(literal)) literal = literal.expression;
  if (
    ts.isArrowFunction(literal) ||
    (ts.isFunctionExpression(literal) && literal.name === undefined && !bodyReadsArguments(literal))
  )
    lowerer.errorFirstLiterals.add(literal);
  let callback = lowerer.lowerExpr(node);
  if (callback.type.kind === "dyn") {
    callback = {
      kind: "dynCheck",
      value: callback,
      type: funcOf([DYN, DYN], VOID),
      loc: locOf(node),
    };
  }
  if (callback.type.kind !== "func" || callback.type.params.length > 2) {
    lowerer.unsupported("SC1090", node, `${api} callbacks must accept at most (error, buffer)`);
  }
  const error = callback.type.params[0];
  if (error !== undefined && !isErrorFirstErrorType(lowerer, error))
    lowerer.unsupported("SC1090", node, `${api} callback error parameters must be Error | null`);
  const value = callback.type.params[1];
  if (value !== undefined && value.kind !== "dyn" && !acceptValue(value)) {
    lowerer.unsupported(
      "SC1090",
      node,
      `${api} callback result parameters must be ${values} values`,
    );
  }
  return voidizedCallback(lowerer, callback, locOf(node));
}

export function lowerBuiltinByteInput(
  lowerer: Lowerer,
  node: ts.Expression,
  loc: SrcLoc,
  module: "crypto" | "zlib",
): IrExpr {
  const value = lowerer.lowerExpr(node);
  if (value.type.kind === "bytes" && value.type.elem === "u8") return value;
  if (value.type.kind === "string") {
    return {
      kind: "libCall",
      fn: "buffer.fromStr",
      args: [value, { kind: "strLit", value: "utf8", type: STRING, loc }],
      type: BYTES_U8,
      loc,
    };
  }
  lowerer.noLowering(
    `${module} byte input of '${lowerer.fmt(value.type)}' values`,
    node,
    "string and Buffer/Uint8Array values are supported",
  );
}
