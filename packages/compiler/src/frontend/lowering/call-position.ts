import * as ts from "../ts7/adapter.js";

/** Calls whose result is ignored: ordinary expression statements and
 * concise arrow bodies (whose contextual void result is discarded). */
export function resultIsDiscarded(call: ts.CallExpression): boolean {
  return ts.isExpressionStatement(call.parent) || ts.isArrowFunction(call.parent);
}
