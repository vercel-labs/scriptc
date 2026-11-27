/** The binding-aware form of isRequireCallee for lowering: a call is the
 * CommonJS loader's when the callee is the `require` identifier or
 * `module.require` on the module OBJECT's own binding. A parameter or local
 * named `module` keeps ordinary method dispatch — its own `require` is
 * called and its result is used. */
import * as ts from "../ts7/adapter.js";
import { isRequireCallee } from "../require-callee.js";
import { isCjsModuleGlobal, isCjsRequireGlobal, writesModuleRequire } from "./lower-node-module.js";
import type { Lowerer } from "./lowerer.js";

export function isCjsRequireCallee(lowerer: Lowerer, callee: ts.Expression): boolean {
  if (ts.isIdentifier(callee))
    return callee.text === "require" && isCjsRequireGlobal(lowerer, callee);
  return (
    isRequireCallee(callee) &&
    ts.isPropertyAccessExpression(callee) &&
    isCjsModuleGlobal(lowerer, callee.expression) &&
    // A file that writes module.require calls its replacement, as Node does.
    !writesModuleRequire(lowerer, callee)
  );
}
