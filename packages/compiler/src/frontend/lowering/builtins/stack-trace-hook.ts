/* Error.prepareStackTrace — V8's hook that formats an error's stack from
 * structured frames (CallSite objects), which programs also use to read
 * frames directly: the file that called a function, a deprecation site.
 *
 * A compiled program has no structured frames to hand a formatter. It keeps
 * a frame only for a function that can raise an error, none for a module's
 * top-level code in a release build, and async frames end at their function,
 * so "frame 2" would name a different function than under Node, and a
 * different one in a `dev` build than in a release build. An error's stack
 * is its text, and nothing calls the hook.
 *
 * So the hook holds `undefined`:
 *   - a read answers undefined (the builtin statics path, unchanged here).
 *     Node 24 answers its default formatter until a program assigns the
 *     hook, so `typeof Error.prepareStackTrace` differs there; the
 *     limitations page says so;
 *   - a write of `undefined` is nothing. That covers the save-and-restore
 *     pair around code that never installs a formatter (the saved value is
 *     the undefined a read answered), and the restore of a pair whose
 *     installing statement was never reached;
 *   - a write of anything else is refused by name: installing a formatter
 *     would change nothing here, and the program that installs one reads
 *     frames next. Where the written expression is a function the refusal
 *     is static (a build error in TypeScript, the statement's deferred
 *     refusal in JavaScript); where its value is only known when it runs
 *     (`Error.prepareStackTrace = previous`), the statement checks it then.
 */
import { varRef } from "../../../ir/build.js";
import { stackTraceHookDiag } from "../../../diagnostics/diagnostic.js";
import * as ts from "../../ts7/adapter.js";
import { withoutParenthesesTypeWrappers } from "../../outer-expressions.js";
import { locOf } from "../../program.js";
import { type Lowerer, PoisonError } from "../lowerer.js";
import { BOOL, DYN, type IrStmt } from "../../../ir/ir.js";

/** `Error.prepareStackTrace = value` as a statement, or null when `expr` is
 * anything else. */
export function lowerStackTraceHookWrite(lowerer: Lowerer, expr: ts.Expression): IrStmt | null {
  if (!ts.isBinaryExpression(expr) || expr.operatorToken.kind !== ts.SyntaxKind.EqualsToken)
    return null;
  const target = withoutParenthesesTypeWrappers(expr.left);
  if (
    !ts.isPropertyAccessExpression(target) ||
    target.questionDotToken !== undefined ||
    target.name.text !== "prepareStackTrace" ||
    !lowerer.isStdlibGlobal(target.expression, "Error")
  )
    return null;
  const loc = locOf(expr);
  const value = withoutParenthesesTypeWrappers(expr.right);
  if (isUndefinedValue(lowerer, value)) return { kind: "block", body: [], loc };
  const diag = stackTraceHookDiag(locOf(target));
  if (isFunctionValue(lowerer, value)) {
    lowerer.pushDiag(diag);
    throw new PoisonError();
  }
  // The value is known when the statement runs: undefined restores the
  // hook's own state, anything else is the refusal, thrown there.
  const slot = lowerer.declareHiddenLocal("%stackTraceHook", DYN);
  const source = ts.getSourceFileOfNode(expr);
  const line = ts.getLineAndCharacterOfPosition(source, loc.start).line + 1;
  return {
    kind: "block",
    body: [
      { kind: "varDecl", localId: slot.id, init: lowerer.lowerExprExpecting(expr.right, DYN), loc },
      {
        kind: "if",
        cond: {
          kind: "dynTest",
          test: "undefined",
          value: varRef(slot.id, DYN, loc),
          type: BOOL,
          loc,
        },
        then: [],
        else_: [
          {
            kind: "runtimeFence",
            code: diag.code,
            message: `${diag.message} [${diag.code} at ${loc.file}:${line}]`,
            loc,
          },
        ],
        loc,
      },
    ],
    loc,
  };
}

/** `undefined` itself or `void <literal>`. */
function isUndefinedValue(lowerer: Lowerer, node: ts.Expression): boolean {
  if (ts.isIdentifier(node)) {
    return node.text === "undefined" && lowerer.isStdlibGlobal(node, "undefined");
  }
  return ts.isVoidExpression(node) && ts.isLiteralExpression(node.expression);
}

/** A function or class written here, or a name declared as one. */
function isFunctionValue(lowerer: Lowerer, node: ts.Expression): boolean {
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isClassExpression(node))
    return true;
  if (!ts.isIdentifier(node)) return false;
  const symbol = lowerer.resolveValueSymbol(node);
  return (
    symbol !== null &&
    symbol.declarations.length > 0 &&
    symbol.declarations.every(
      (declaration) => ts.isFunctionDeclaration(declaration) || ts.isClassDeclaration(declaration),
    )
  );
}
