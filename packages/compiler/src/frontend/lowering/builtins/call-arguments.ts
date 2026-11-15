import * as ts from "../../ts7/adapter.js";
import { type IrExpr, type IrStmt } from "../../../ir/ir.js";
import { varRef } from "../../../ir/build.js";
import { type Lowerer } from "../lowerer.js";

/** Node's builtin functions ignore arguments past the ones they read, but
 * JavaScript still evaluates every argument left to right before the call,
 * and a JS caller (or an untyped one) can pass extras: `process.cwd(1, fn())`
 * runs fn and answers the cwd. The used arguments are staged in source
 * order, the ignored tail is evaluated after them, and `build` runs the
 * call over the staged values. */
export function withIgnoredArguments(
  lowerer: Lowerer,
  used: readonly IrExpr[],
  surplus: readonly ts.Expression[],
  build: (args: IrExpr[]) => IrExpr,
): IrExpr {
  if (surplus.length === 0) return build([...used]);
  const stmts: IrStmt[] = [];
  const staged = used.map((value, i) => {
    const local = lowerer.declareHiddenLocal(`%arg${i}`, value.type);
    stmts.push({ kind: "varDecl", localId: local.id, init: value, loc: value.loc });
    return varRef(local.id, value.type, value.loc);
  });
  for (const extra of surplus) {
    if (ts.isSpreadElement(extra)) {
      lowerer.noLowering(
        "a spread argument past the ones the call uses",
        extra,
        "write the ignored arguments out positionally",
      );
    }
    const expr = lowerer.lowerExpr(extra);
    // `null` and `undefined` lower to a bare unitLit: there is no effect to
    // keep, and a bare unitLit is not a valid IR expression statement
    // (SC9001). Every other surplus value still evaluates here.
    if (expr.kind === "unitLit") continue;
    stmts.push({ kind: "exprStmt", expr, loc: expr.loc });
  }
  const result = build(staged);
  return { kind: "seqExpr", stmts, result, type: result.type, loc: result.loc };
}
