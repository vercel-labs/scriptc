/* Which checked conversions check an inferred fact: those whose target type
 * is an overlay annotation's (a parameter, return, binding or field the
 * overlay typed, or a receiver cast). Only those report a failure as a
 * shape analysis bug; every other check (a type the package's JSDoc or a
 * declaration file declares, or the checker infers) keeps the default
 * build's TypeError. */
import * as ts from "../ts7/adapter.js";
import { innermostNodeAt } from "./fallback.js";
import { OVERLAY_MARK } from "./overlay.js";

/** Whether the overlay annotated a declaration (or the statement holding
 * it). */
function annotated(node: ts.Node | undefined): boolean {
  for (let n = node, i = 0; n !== undefined && i < 4; n = n.parent, i++) {
    const sf = n.getSourceFile();
    if (sf.text.slice(n.pos, ts.tokenStartOfNode(n)).includes(OVERLAY_MARK)) return true;
    if (
      ts.isStatement(n) ||
      ts.isSourceFile(n) ||
      (n.parent !== undefined && ts.isClassLikeDeclaration(n.parent))
    )
      break;
  }
  return false;
}

export function checksInferredFact(
  program: ts.Program,
  file: string,
  start: number,
  end: number,
): boolean {
  const sf = program.getSourceFile(file);
  if (sf === undefined) return false;
  let e: ts.Node = innermostNodeAt(sf, start, Math.max(start, end));
  // A receiver cast: `/** @type {…} @scriptcShape */ (this)`.
  for (let n: ts.Node | undefined = e; n !== undefined; n = n.parent) {
    if (!ts.isParenthesizedExpression(n)) {
      if (n !== e) break;
      continue;
    }
    if (sf.text.slice(n.pos, ts.tokenStartOfNode(n)).includes(OVERLAY_MARK)) return true;
  }
  while (e.parent !== undefined && ts.isParenthesizedExpression(e.parent)) e = e.parent;
  const p = e.parent;
  if (p === undefined) return false;
  if (ts.isReturnStatement(p)) {
    let fn: ts.Node | undefined = p.parent;
    while (fn !== undefined && !ts.isFunctionLike(fn)) fn = fn.parent;
    return annotated(fn);
  }
  if (ts.isArrowFunction(p) && p.body === e) return annotated(p);
  if (ts.isVariableDeclaration(p) && p.initializer === e) return annotated(p);
  const checker = program.getTypeChecker();
  const declsOf = (n: ts.Node): readonly ts.Node[] => {
    try {
      return checker.getSymbolAtLocation(n)?.declarations ?? [];
    } catch {
      return [];
    }
  };
  if ((ts.isCallExpression(p) || ts.isNewExpression(p)) && p.expression !== e) {
    let decl: ts.Node | undefined;
    try {
      decl = checker.getResolvedSignature(p)?.declaration ?? undefined;
    } catch {
      decl = undefined;
    }
    if (decl !== undefined && annotated(decl)) return true;
    const callee = ts.isPropertyAccessExpression(p.expression) ? p.expression.name : p.expression;
    return declsOf(callee).some((d) => annotated(d) || annotated(constructorOf(d)));
  }
  if (
    ts.isBinaryExpression(p) &&
    p.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    p.right === e
  ) {
    const target = ts.isPropertyAccessExpression(p.left) ? p.left.name : p.left;
    return declsOf(target).some((d) => annotated(d));
  }
  return false;
}

/** A class declaration's constructor (`new C(…)` resolves to the class). */
function constructorOf(decl: ts.Node): ts.Node | undefined {
  if (!ts.isClassDeclaration(decl) && !ts.isClassExpression(decl)) return undefined;
  return decl.members.nodes.find((m) => ts.isConstructorDeclaration(m));
}
