/** A builtin module function used as a JavaScript value when it has no
 * value adapter (lowerNativeCallableValue). Node hands the program a real
 * function; the compiled value is one function per builtin that throws the
 * named fence when called. Identity flows (`fn === fs.readFileSync`, Set
 * membership) still hold, `typeof` answers "function" and inspection
 * prints `[Function: name]`, where a string token would answer "string"
 * and turn a call into an ordinary "is not a function" TypeError. */
import * as ts from "../ts7/adapter.js";
import { DYN, type IrExpr, type SrcLoc, funcOf } from "../../ir/ir.js";
import { unsupportedDiag } from "../../diagnostics/diagnostic.js";
import type { Lowerer } from "./lowerer.js";

export function builtinFunctionFenceValue(
  lowerer: Lowerer,
  bi: { module: string; member: string },
  node: ts.Identifier,
  loc: SrcLoc,
): IrExpr {
  const display = `${bi.module}.${bi.member}`;
  const name = `%builtin.fence.${display}`;
  if (!lowerer.liftedFns.some((fn) => fn.name === name)) {
    const diag = unsupportedDiag(
      "SC1090",
      loc,
      `library functions as values ('${display}' has no function-value lowering; call it directly)`,
    );
    lowerer.runtimeFences.push(diag);
    const line = ts.getLineAndCharacterOfPosition(ts.getSourceFileOfNode(node), loc.start).line + 1;
    lowerer.liftedFns.push({
      name,
      params: [],
      locals: [],
      returnType: DYN,
      body: [
        {
          kind: "runtimeFence",
          code: diag.code,
          message: `${diag.message} [${diag.code} at ${loc.file}:${line}]`,
          loc,
        },
      ],
      loc,
    });
  }
  return {
    kind: "dynFrom",
    value: { kind: "closure", fnName: name, captures: [], type: funcOf([], DYN), loc },
    fnName: bi.member,
    type: DYN,
    loc,
  };
}
