import * as ts from "../ts7/adapter.js";
import type { IrExpr } from "../../ir/ir.js";
import type { Lowerer } from "./lowerer.js";
import { stripValueWrappers } from "./binding-analysis.js";
import { identifiersNamed } from "./identifier-uses.js";

/** A fresh split array is dense. A stored result has the same guarantee
 * only when this loop is its sole observation: even a const array can be
 * mutated through an alias. Keep the ordinary array protocol otherwise. */
export function isPrivateSplitConsumer(
  lowerer: Lowerer,
  source: ts.Expression,
  iterable: IrExpr,
): boolean {
  if (iterable.type.kind !== "array" || iterable.type.elem.kind !== "string") return false;
  if (iterable.kind === "strIntrinsic" && iterable.method === "split") return true;
  const name = stripValueWrappers(source);
  if (!ts.isIdentifier(name) || iterable.kind !== "varRef") return false;
  const symbol = lowerer.resolveValueSymbol(name);
  if (!symbol) return false;
  const local = lowerer.bindingIn(lowerer.ctx, symbol);
  if (!local || local.boxed || local.tdz || local.mutable || local.id !== iterable.localId)
    return false;
  const decl = symbol.valueDeclaration;
  if (
    !decl ||
    !ts.isVariableDeclaration(decl) ||
    !ts.isIdentifier(decl.name) ||
    !decl.initializer ||
    !ts.isVariableDeclarationList(decl.parent) ||
    (decl.parent.flags & ts.NodeFlags.Const) === 0
  )
    return false;
  const init = stripValueWrappers(decl.initializer);
  if (
    !ts.isCallExpression(init) ||
    init.questionDotToken ||
    !ts.isPropertyAccessExpression(init.expression) ||
    init.expression.questionDotToken ||
    init.expression.name.text !== "split" ||
    !lowerer.isStdlibMember(init.expression) ||
    lowerer.mapTypeOf(lowerer.typeOf(init.expression.expression))?.kind !== "string" ||
    init.arguments.nodes.length === 0 ||
    lowerer.mapTypeOf(lowerer.typeOf(init.arguments.nodes[0]!))?.kind !== "string"
  )
    return false;

  for (const use of identifiersNamed(lowerer, ts.getSourceFileOfNode(decl), name.text)) {
    if (use === decl.name || use === name) continue;
    if (lowerer.resolveValueSymbol(use) === symbol) return false;
  }
  return true;
}
