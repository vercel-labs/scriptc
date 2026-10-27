import { nodeThrowExpr, strLit, varRef } from "../../ir/build.js";
import * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js";
import {
  BOOL,
  DYN,
  STRING,
  UNDEFINED_T,
  URL_T,
  isUnitType,
  type IrExpr,
  type IrLibFn,
  type IrStmt,
} from "../../ir/ir.js";
import { locOf } from "../program.js";
import { staticForkString } from "../fork-target.js";
import { lowerStaticallyUndefinedArgument } from "./optional-arguments.js";

/** Both argument expressions run before the constructor converts input,
 * then base. Keep that ordering even when a conversion invokes user code. */
export function lowerUrlNew(lowerer: Lowerer, expr: ts.NewExpression): IrExpr {
  return lowerUrlOperation(lowerer, expr, "new");
}

export function lowerUrlFactory(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  operation: "canParse" | "parse",
): IrExpr {
  return lowerUrlOperation(lowerer, expr, operation);
}

function lowerUrlOperation(
  lowerer: Lowerer,
  expr: ts.NewExpression | ts.CallExpression,
  operation: "new" | "canParse" | "parse",
): IrExpr {
  const args = expr.arguments?.nodes ?? [];
  const loc = locOf(expr);
  const resultType = operation === "new" ? URL_T : operation === "canParse" ? BOOL : DYN;
  const checkedResult = (value: IrExpr): IrExpr => {
    if (operation !== "parse") return value;
    const type = lowerer.mapTypeOf(lowerer.typeOf(expr));
    if (!type) lowerer.noLowering("URL.parse result type", expr);
    return { kind: "dynCheck", value, type, loc };
  };
  if (args.length === 0 && operation !== "new") {
    return checkedResult(
      nodeThrowExpr(1, "ERR_MISSING_ARGS", 'The "url" argument must be specified', resultType, loc),
    );
  }
  if (args.length < 1 || args.length > 2 || args.some(ts.isSpreadElement)) {
    lowerer.noLowering(`URL.${operation} with spread, missing, or extra arguments`, expr);
  }
  if (operation === "new" && args.length === 2 && ts.isNewExpression(expr)) {
    const folded = staticForkString(lowerer.program, expr);
    if (folded !== null)
      return { kind: "libCall", fn: "url.new", args: [strLit(folded, loc)], type: URL_T, loc };
  }
  const stmts: IrStmt[] = [];
  const values = args.map((node): IrExpr => {
    const absent = lowerStaticallyUndefinedArgument(lowerer, node);
    if (absent !== null) {
      stmts.push({ kind: "exprStmt", expr: absent, loc: locOf(node) });
      return { kind: "unitLit", unit: "undefined", type: UNDEFINED_T, loc: locOf(node) };
    }
    const value = lowerer.lowerExpr(node);
    if (isUnitType(value.type)) {
      if (value.kind !== "unitLit") stmts.push({ kind: "exprStmt", expr: value, loc: value.loc });
      return {
        kind: "unitLit",
        unit: value.type.kind === "nullT" ? "null" : "undefined",
        type: value.type,
        loc: value.loc,
      };
    }
    const local = lowerer.declareHiddenLocal("%urlArgument", value.type);
    stmts.push({ kind: "varDecl", localId: local.id, init: value, loc: value.loc });
    return varRef(local.id, value.type, value.loc);
  });
  const stringify = (value: IrExpr, node: ts.Expression): IrExpr => {
    if (value.type.kind === "url")
      return { kind: "libCall", fn: "url.href", args: [value], type: STRING, loc };
    if (isUnitType(value.type))
      return strLit(value.type.kind === "nullT" ? "null" : "undefined", loc);
    if (value.type.kind === "union") {
      const unionId = value.type.unionId;
      const arms = lowerer.unions.get(unionId)!.arms;
      let result: IrExpr = strLit("", loc);
      for (let tag = arms.length - 1; tag >= 0; tag--) {
        const arm: IrExpr = { kind: "unionNarrow", unionId, tag, value, type: arms[tag]!, loc };
        const text = stringify(arm, node);
        result =
          tag === arms.length - 1
            ? text
            : {
                kind: "ternary",
                cond: { kind: "unionIsTag", unionId, tag, value, negated: false, type: BOOL, loc },
                then: text,
                else_: result,
                type: STRING,
                loc,
              };
      }
      return result;
    }
    if (value.type.kind === "dyn" || value.type.kind === "record" || value.type.kind === "symbol") {
      const boxed = lowerer.coerceInto(node, value, { kind: "dyn" });
      return { kind: "libCall", fn: "dyn.toStringCoerce", args: [boxed], type: STRING, loc };
    }
    return lowerer.ensureString(value, node);
  };
  const input = lowerer.declareHiddenLocal("%urlInput", STRING);
  stmts.push({ kind: "varDecl", localId: input.id, init: stringify(values[0]!, args[0]!), loc });
  const inputRef = varRef(input.id, STRING, loc);
  const fn: IrLibFn =
    operation === "new" ? "url.new" : operation === "canParse" ? "url.canParse" : "url.parse";
  const baseFn: IrLibFn =
    operation === "new"
      ? "url.newBase"
      : operation === "canParse"
        ? "url.canParseBase"
        : "url.parseBase";
  const absolute: IrExpr = { kind: "libCall", fn, args: [inputRef], type: resultType, loc };
  const base = values[1];
  let result: IrExpr = absolute;
  if (base && base.type.kind !== "undefinedT") {
    const resolved: IrExpr = {
      kind: "libCall",
      fn: baseFn,
      args: [inputRef, stringify(base, args[1]!)],
      type: resultType,
      loc,
    };
    const tag = base.type.kind === "union" ? lowerer.armTag(base.type.unionId, UNDEFINED_T) : -1;
    const absent: IrExpr | null =
      tag >= 0 && base.type.kind === "union"
        ? {
            kind: "unionIsTag",
            unionId: base.type.unionId,
            tag,
            value: base,
            negated: false,
            type: BOOL,
            loc,
          }
        : base.type.kind === "dyn"
          ? { kind: "dynTest", test: "undefined", value: base, type: BOOL, loc }
          : null;
    result = absent
      ? { kind: "ternary", cond: absent, then: absolute, else_: resolved, type: resultType, loc }
      : resolved;
  }
  result = checkedResult(result);
  return { kind: "seqExpr", stmts, result, type: result.type, loc };
}
