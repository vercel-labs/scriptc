/* Code generation from strings: `eval(...)`, `new Function(...)` and
 * `Function(...)`. A compiled binary embeds no JavaScript engine, so scriptc
 * answers exactly as `node --disallow-code-generation-from-strings` does:
 * every call throws the catchable EvalError "Code generation from strings
 * disallowed for this context". Packages that probe for code generation
 * (zod 4's `allowsEval`, template engines, CSP-aware JITs) then take their
 * interpreted paths. The arguments still evaluate first, in order, and the
 * Function constructor converts each to a string before it refuses, as
 * V8's CreateDynamicFunction does; eval refuses without converting. */
import * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js";
import { isJsSourceFile, locOf } from "../program.js";
import { DYN, F64, type IrExpr, type IrStmt, type IrType, STRING } from "../../ir/ir.js";
import { nodeThrowExpr } from "../../ir/build.js";
import { ambientUndefReadType, contextualUndefReadType } from "./lower-namespaces.js";
import { stdlibGlobalNameOf } from "./surfaces.js";

export const CODE_GENERATION_DISALLOWED =
  "Code generation from strings disallowed for this context";

/** The code-generation entry point a callee names: the stdlib `eval` or
 * `Function` global (directly, through `globalThis.`, or through a stable
 * alias), or the indirect-eval spelling `(0, eval)`. Null otherwise. */
export function codeGenerationCalleeOf(
  lowerer: Lowerer,
  callee: ts.Expression,
): "eval" | "Function" | null {
  let e = callee;
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.CommaToken) {
    return codeGenerationCalleeOf(lowerer, e.right) === "eval" ? "eval" : null;
  }
  // Syntactic pre-check first: every call and construction asks, and only
  // these spellings can name the globals (aliases are stdlib-resolved
  // symbols, checked below only when the spelling could match).
  const text = ts.isIdentifier(e) ? e.text : ts.isPropertyAccessExpression(e) ? e.name.text : null;
  if (text === null) return null;
  if (text !== "eval" && text !== "Function" && !hasCodeGenerationAlias(lowerer)) return null;
  const name = stdlibGlobalNameOf(lowerer, e);
  return name === "eval" || name === "Function" ? name : null;
}

/** Some stable binding aliases `eval` or `Function` (`const F = Function`,
 * zod 4's spelling). */
function hasCodeGenerationAlias(lowerer: Lowerer): boolean {
  for (const name of lowerer.stdlibGlobalAliases.values()) {
    if (name === "eval" || name === "Function") return true;
  }
  return false;
}

/** The comma operands an indirect eval evaluates before the call: `a` in
 * `(a, eval)(...)`, outermost first. */
function indirectEvalPrefix(callee: ts.Expression): ts.Expression[] {
  let e = callee;
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  if (!ts.isBinaryExpression(e) || e.operatorToken.kind !== ts.SyntaxKind.CommaToken) return [];
  return [...indirectEvalPrefix(e.left), e.left, ...indirectEvalPrefix(e.right)].filter(
    (operand) => {
      let o = operand;
      while (ts.isParenthesizedExpression(o)) o = o.expression;
      return !(ts.isBinaryExpression(o) && o.operatorToken.kind === ts.SyntaxKind.CommaToken);
    },
  );
}

/** Lowers a code-generation call or construction to Node's refusal under
 * --disallow-code-generation-from-strings: the callee's own operands, then
 * the arguments in order (converted to strings for the Function
 * constructor), then the EvalError. The result carries the use site's type
 * (the throw always fires, so the value is never observed). */
export function lowerCodeGenerationCall(
  lowerer: Lowerer,
  expr: ts.CallExpression | ts.NewExpression,
  kind: "eval" | "Function",
): IrExpr {
  const loc = locOf(expr);
  const stmts: IrStmt[] = [];
  for (const operand of indirectEvalPrefix(expr.expression)) {
    stmts.push({ kind: "exprStmt", expr: lowerer.lowerExpr(operand), loc: locOf(operand) });
  }
  for (const arg of expr.arguments?.nodes ?? []) {
    if (ts.isSpreadElement(arg)) {
      lowerer.noLowering(
        `${kind === "eval" ? "eval" : "the Function constructor"} with spread arguments`,
        arg,
        "code generation from strings throws EvalError in compiled programs, as under node --disallow-code-generation-from-strings; pass the arguments directly",
      );
    }
    const value = lowerer.lowerExpr(arg);
    const argLoc = locOf(arg);
    if (kind === "Function" && !isPrimitiveIrType(value.type)) {
      stmts.push({
        kind: "exprStmt",
        expr: {
          kind: "libCall",
          fn: "dyn.toStringCoerce",
          args: [lowerer.coerceToExpected(value, DYN)],
          type: STRING,
          loc: argLoc,
        },
        loc: argLoc,
      });
    } else {
      stmts.push({ kind: "exprStmt", expr: value, loc: argLoc });
    }
  }
  const type = useSiteType(lowerer, expr);
  const refusal = nodeThrowExpr(6, "", CODE_GENERATION_DISALLOWED, type, loc);
  return stmts.length === 0 ? refusal : { kind: "seqExpr", stmts, result: refusal, type, loc };
}

function isPrimitiveIrType(t: IrType): boolean {
  return (
    t.kind === "string" ||
    t.kind === "f64" ||
    t.kind === "bool" ||
    t.kind === "void" ||
    t.kind === "bigint"
  );
}

function useSiteType(lowerer: Lowerer, expr: ts.Expression): IrType {
  // The Function interface has no mapping (mapping it would fence): the
  // constructed value is checked-dynamic in JavaScript, and a typed dummy
  // elsewhere — the throw always fires first.
  const type = lowerer.typeOf(expr);
  const symbol = type.getSymbol();
  if (
    symbol !== undefined &&
    ts.symbolName(symbol) === "Function" &&
    lowerer.isStdlibSymbol(symbol)
  ) {
    return isJsSourceFile(ts.getSourceFileOfNode(expr)) ? DYN : F64;
  }
  const mapped = lowerer.mapTypeOf(type);
  if (
    mapped &&
    mapped.kind !== "void" &&
    mapped.kind !== "func" &&
    !lowerer.typeNamesUnregisteredClass(mapped)
  ) {
    return mapped;
  }
  return ambientUndefReadType(lowerer, expr) ?? contextualUndefReadType(lowerer, expr) ?? F64;
}
