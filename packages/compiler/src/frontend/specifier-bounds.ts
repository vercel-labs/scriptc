/* Bounding the specifier of a computed module load.
 *
 * The module graph is a build-time artifact, so `import(e)` and friends can
 * only lower when the compiler can name every value `e` may take. This
 * analysis answers that question as a small abstract domain:
 *
 *   - a FINITE SET of strings (the load becomes one literal edge per value),
 *   - TOP, with the first source that cannot be bounded and why.
 *
 * The domain is §3.2 of results/designs/island-dynamic-subgraphs/SPEC.md.
 * Slice B1 implements the string-literal forms, `const`/never-reassigned
 * bindings, `+` and template-span cartesian products (capped), the
 * conditional/`??`/`||` union, and parameters of module-local functions that
 * never escape. Every other form is Top — including the String-method and
 * `path.join` folding and glob expansion, which the sites B1 clears do not
 * need. A bound is an OVER-approximation: a superset is sound (the selector's
 * final arm is a thrown ERR_MODULE_NOT_FOUND), a set that misses a runtime
 * value is not.
 *
 * The analysis runs only on NON-literal load sites (pitfall P4): a literal
 * specifier keeps its exact existing lowering, unfiltered. */

import * as ts from "./ts7/adapter.js";
import type { Lowerer } from "./lowering/lowerer.js";
import { bindingNeverReassigned, stripValueWrappers } from "./lowering/binding-analysis.js";

/** At most this many values: beyond it the cartesian products are no longer
 * a catalogue a selector should spell out. */
const MAX_VALUES = 256;

export type SpecifierBound =
  | { kind: "set"; values: string[] }
  | { kind: "top"; at: ts.Node; why: string };

/** The values `expr` may evaluate to, or the first source that prevents
 * bounding it. */
export function boundSpecifier(lowerer: Lowerer, expr: ts.Expression): SpecifierBound {
  return bound(lowerer, expr, new Set<ts.Symbol>());
}

function top(at: ts.Node, why: string): SpecifierBound {
  return { kind: "top", at, why };
}

/** Deduplicated, sorted values; over the cap is Top at `at`. */
function finite(values: readonly string[], at: ts.Node): SpecifierBound {
  const unique = [...new Set(values)].sort();
  if (unique.length > MAX_VALUES) return top(at, `more than ${MAX_VALUES} possible values`);
  return { kind: "set", values: unique };
}

function union(bounds: readonly SpecifierBound[], at: ts.Node): SpecifierBound {
  const values: string[] = [];
  for (const b of bounds) {
    if (b.kind === "top") return b;
    values.push(...b.values);
  }
  return finite(values, at);
}

/** The cartesian concatenation of two bounds, or the operand that is Top. */
function concat(left: SpecifierBound, right: SpecifierBound, at: ts.Node): SpecifierBound {
  if (left.kind === "top") return left;
  if (right.kind === "top") return right;
  const values: string[] = [];
  for (const l of left.values) {
    for (const r of right.values) {
      if (values.length > MAX_VALUES) break;
      values.push(l + r);
    }
  }
  return finite(values, at);
}

function bound(
  lowerer: Lowerer,
  expression: ts.Expression,
  inProgress: Set<ts.Symbol>,
): SpecifierBound {
  const expr = stripValueWrappers(expression);
  if (ts.isStringLiteralLike(expr)) return { kind: "set", values: [expr.text] };
  if (ts.isTemplateExpression(expr)) {
    // The head, then one cartesian step per span (its expression) with the
    // literal that follows it appended to every value.
    let values: SpecifierBound = { kind: "set", values: [expr.head.text] };
    for (const span of expr.templateSpans.nodes) {
      const part = bound(lowerer, span.expression, inProgress);
      values = concat(values, part, expr);
      const tail: SpecifierBound = { kind: "set", values: [span.literal.text] };
      values = concat(values, tail, expr);
      if (values.kind === "top") return values;
    }
    return values;
  }
  if (ts.isConditionalExpression(expr)) {
    // The condition is not evaluated: the bound covers both branches.
    return union(
      [bound(lowerer, expr.whenTrue, inProgress), bound(lowerer, expr.whenFalse, inProgress)],
      expr,
    );
  }
  if (ts.isBinaryExpression(expr)) {
    const op = expr.operatorToken.kind;
    if (op === ts.SyntaxKind.PlusToken)
      return concat(
        bound(lowerer, expr.left, inProgress),
        bound(lowerer, expr.right, inProgress),
        expr,
      );
    if (op === ts.SyntaxKind.QuestionQuestionToken || op === ts.SyntaxKind.BarBarToken)
      return union(
        [bound(lowerer, expr.left, inProgress), bound(lowerer, expr.right, inProgress)],
        expr,
      );
    return top(expr, `the result of the '${ts.getTextOfNode(expr.operatorToken)}' operator`);
  }
  if (ts.isIdentifier(expr)) return boundIdentifier(lowerer, expr, inProgress);
  return top(expr, describeUnbounded(expr));
}

/** Why a construct has no build-time value, in the reader's terms. */
function describeUnbounded(expr: ts.Expression): string {
  if (ts.isCallExpression(expr)) {
    const callee = ts.isIdentifier(expr.expression)
      ? expr.expression.text
      : ts.isPropertyAccessExpression(expr.expression)
        ? expr.expression.name.text
        : "a function";
    return `the result of \`${callee}(...)\``;
  }
  if (ts.isElementAccessExpression(expr) || ts.isPropertyAccessExpression(expr)) {
    const text = ts.getTextOfNode(expr);
    if (text.startsWith("process.env")) return "a value read from `process.env`";
    if (text.startsWith("process.argv")) return "a value read from `process.argv`";
    return `a value read from \`${text}\``;
  }
  if (ts.isNewExpression(expr)) return "the result of a `new` expression";
  if (ts.isAwaitExpression(expr)) return "an awaited runtime value";
  if (ts.isTemplateExpression(expr)) return "a template with an unbounded span";
  return "an expression with no build-time value";
}

function boundIdentifier(
  lowerer: Lowerer,
  expr: ts.Identifier,
  inProgress: Set<ts.Symbol>,
): SpecifierBound {
  const sym = lowerer.resolveValueSymbol(expr) ?? lowerer.checker.getSymbolAtLocation(expr);
  if (sym === undefined) return top(expr, `'${expr.text}', which has no declaration`);
  const decl = sym.valueDeclaration ?? sym.declarations?.[0];
  if (decl === undefined) return top(expr, `'${expr.text}', which has no declaration`);
  if (inProgress.has(sym)) return top(expr, `'${expr.text}', which refers to itself`);
  if (ts.isVariableDeclaration(decl)) return boundVariable(lowerer, expr, sym, decl, inProgress);
  if (ts.isParameterDeclaration(decl)) return boundParameter(lowerer, expr, sym, decl, inProgress);
  return top(expr, `'${expr.text}', which is not a string literal or a const binding`);
}

function boundVariable(
  lowerer: Lowerer,
  expr: ts.Identifier,
  sym: ts.Symbol,
  decl: ts.VariableDeclaration,
  inProgress: Set<ts.Symbol>,
): SpecifierBound {
  const isConst = (ts.getCombinedNodeFlags(decl) & ts.NodeFlags.Const) !== 0;
  if (!isConst && !bindingNeverReassigned(lowerer, sym, decl))
    return top(expr, `'${expr.text}', which is written after its declaration`);
  const init = decl.initializer;
  if (init === undefined) return top(expr, `'${expr.text}', which has no initializer`);
  inProgress.add(sym);
  try {
    return bound(lowerer, init, inProgress);
  } finally {
    inProgress.delete(sym);
  }
}

/** A parameter of a module-local function: bounded when the function never
 * escapes as a value — every reference in its own file is a direct call, and
 * the module does not export it (another module's callers are outside the
 * scan) — and the union of the call arguments is finite. */
function boundParameter(
  lowerer: Lowerer,
  expr: ts.Identifier,
  sym: ts.Symbol,
  decl: ts.ParameterDeclaration,
  inProgress: Set<ts.Symbol>,
): SpecifierBound {
  const fn = decl.parent;
  if (fn === undefined || !ts.isFunctionLike(fn))
    return top(expr, `'${expr.text}', a parameter of a non-function scope`);
  if (decl.dotDotDotToken !== undefined) return top(expr, `'${expr.text}', a rest parameter`);
  // A parameter the function assigns takes values the call arguments do not
  // show.
  if (!bindingNeverReassigned(lowerer, sym, decl))
    return top(expr, `'${expr.text}', a parameter written in its function`);
  const binding = functionBindingName(fn);
  if (binding === null)
    return top(expr, `'${expr.text}', a parameter of a function with no local name`);
  if (isExported(lowerer, binding))
    return top(binding, `a parameter of the exported function '${binding.text}'`);
  const fnSym = lowerer.checker.getSymbolAtLocation(binding);
  if (fnSym === undefined)
    return top(binding, `a parameter of the function '${binding.text}', which has no symbol`);
  if (inProgress.has(fnSym))
    return top(binding, `a parameter of the recursive function '${binding.text}'`);
  const sf = ts.getSourceFileOfNode(fn);
  // A named function expression is also called through its own name, inside
  // its body.
  const ownName = ts.isFunctionExpression(fn) && fn.name !== undefined ? fn.name : null;
  const ownSym = ownName === null ? undefined : lowerer.checker.getSymbolAtLocation(ownName);
  if (ownName !== null && ownSym === undefined)
    return top(ownName, `a parameter of the function '${ownName.text}', which has no symbol`);
  const calls: ts.CallExpression[] = [];
  let escaped: ts.Node | null = null;
  ts.walkPreorder(sf, (node) => {
    if (escaped !== null) return "stop";
    if (!ts.isIdentifier(node) || node === binding || node === ownName) return;
    if (ts.isTypeNode(node)) return;
    // resolveValueSymbol reads a shorthand property (`{ load }`) as the
    // binding it stores, which escapes like any other value use.
    const target = lowerer.resolveValueSymbol(node) ?? lowerer.checker.getSymbolAtLocation(node);
    if (target !== fnSym && (ownSym === undefined || target !== ownSym)) return;
    const call = directCallee(node);
    if (call === null) escaped = node;
    else calls.push(call);
    return;
  });
  if (escaped !== null)
    return top(
      escaped,
      `the function value '${binding.text}', which is used other than as a direct call`,
    );
  const index = fn.parameters.nodes.indexOf(decl);
  if (index < 0) return top(expr, `'${expr.text}', whose position the compiler cannot resolve`);
  const bounds: SpecifierBound[] = [];
  inProgress.add(fnSym);
  try {
    for (const call of calls) {
      const arg = call.arguments.nodes[index];
      if (arg !== undefined) {
        bounds.push(bound(lowerer, arg, inProgress));
      } else if (decl.initializer !== undefined) {
        bounds.push(bound(lowerer, decl.initializer, inProgress));
      } else {
        bounds.push(top(call, `a call of '${binding.text}' that omits '${expr.text}'`));
      }
    }
  } finally {
    inProgress.delete(fnSym);
  }
  if (bounds.length === 0) return top(expr, `'${expr.text}', whose function is never called`);
  return union(bounds, expr);
}

/** The identifier a function's own binding is read through, or null for a
 * function with no module-local name (a method, an inline callback). */
function functionBindingName(fn: ts.SignatureDeclaration): ts.Identifier | null {
  if (ts.isFunctionDeclaration(fn)) return fn.name ?? null;
  if (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn)) return null;
  const decl = fn.parent;
  if (decl === undefined || !ts.isVariableDeclaration(decl)) return null;
  return ts.isIdentifier(decl.name) ? decl.name : null;
}

/** True when `name`'s declaration is exported from its module — a modifier,
 * or an export clause naming it (`export { f }`, `export default f`). The
 * call-site scan reads one file, so an exported function's callers elsewhere
 * would be invisible. */
function isExported(lowerer: Lowerer, name: ts.Identifier): boolean {
  for (let p: ts.Node | undefined = name; p !== undefined; p = p.parent) {
    if (ts.isSourceFile(p)) return exportedByClause(lowerer, p, name);
    if (ts.isExportAssignment(p) || ts.isExportDeclaration(p) || ts.isExportSpecifier(p))
      return true;
    if (
      (ts.getCombinedModifierFlags(p) & ts.ModifierFlags.Export) !== 0 &&
      (ts.isVariableDeclaration(p) ||
        ts.isVariableDeclarationList(p) ||
        ts.isFunctionDeclaration(p) ||
        ts.isClassDeclaration(p))
    )
      return true;
    // A module-level declaration can still be exported by a clause.
    if (ts.isStatement(p))
      return p.parent !== undefined && ts.isSourceFile(p.parent)
        ? exportedByClause(lowerer, p.parent, name)
        : false;
  }
  return false;
}

/** Whether the module's export clauses name the local `name`. */
function exportedByClause(lowerer: Lowerer, sf: ts.SourceFile, name: ts.Identifier): boolean {
  const sym = lowerer.checker.getSymbolAtLocation(name);
  // No symbol means no proof the export clauses miss it: refuse.
  if (sym === undefined) return true;
  for (const stmt of sf.statements.nodes) {
    if (ts.isExportDeclaration(stmt) && stmt.exportClause !== undefined) {
      if (!ts.isNamedExports(stmt.exportClause)) continue;
      // A re-export from another module names no local binding.
      if (stmt.moduleSpecifier !== undefined) continue;
      for (const element of stmt.exportClause.elements.nodes) {
        const local = element.propertyName ?? element.name;
        // The specifier's name resolves to the export's alias symbol, which
        // aliases the local binding.
        let target = lowerer.checker.getSymbolAtLocation(local);
        if (target !== undefined && target.flags & ts.SymbolFlags.Alias)
          target = lowerer.checker.getAliasedSymbol(target);
        if (target === sym) return true;
      }
    } else if (ts.isExportAssignment(stmt) && !stmt.isExportEquals) {
      if (lowerer.checker.getSymbolAtLocation(stmt.expression) === sym) return true;
    }
  }
  return false;
}

/** The call `node` is the callee of (parentheses and optional-call chains
 * included), or null when it is used as a value. */
function directCallee(node: ts.Identifier): ts.CallExpression | null {
  let callee: ts.Node = node;
  let parent = callee.parent;
  while (parent !== undefined && ts.isParenthesizedExpression(parent)) {
    callee = parent;
    parent = callee.parent;
  }
  if (parent === undefined || !ts.isCallExpression(parent)) return null;
  return parent.expression === callee ? parent : null;
}
