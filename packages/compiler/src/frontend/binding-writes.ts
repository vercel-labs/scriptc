/* The binding-write scan the specifier bounder (specifier-bounds.ts) and the
 * lowering share. It reads only the AST and a symbol resolver, and imports
 * nothing from the lowering: program.ts loads it at run time (the bounder
 * runs in the program's graph walks), and a module of the lowering here would
 * bring the whole lowering into every program that loads program.ts. */

import * as ts from "./ts7/adapter.js";

/** The part of a lowering context this analysis reads: the shared
 * reassignment cache and value-symbol resolution. Callers pass
 * `lowerer.bindingScope()`, a record, and never the Lowerer itself: the
 * compiler lowers its own source, and a Lowerer handed over where this
 * interface is declared becomes a dynamic value, which puts the Lowerer and
 * every class its fields reach in the dynamic tier of the compiler's own
 * build (see Lowerer.isStdlibFile). */
export interface BindingScope {
  readonly neverReassignedCache: Map<ts.Symbol, boolean>;
  resolveValueSymbol(ident: ts.Identifier): ts.Symbol | null | undefined;
}

/** True when nothing in `sym`'s DECLARING FILE ever writes it after the
 * initializer: assignments (plain and compound, destructuring targets
 * included), ++/--, for-of/for-in expression targets, a `var` in a
 * for-of/for-in head, and redeclarations that initialize all count.
 * Sound file-locally for module-scope bindings because ESM import
 * bindings are read-only — no other file can write one. Cached per
 * symbol (the scan walks the whole file once). */
export function bindingNeverReassigned(
  scope: BindingScope,
  sym: ts.Symbol,
  decl: ts.Node,
  resolve: (ident: ts.Identifier) => ts.Symbol | null | undefined = (ident) =>
    scope.resolveValueSymbol(ident),
): boolean {
  const cached = scope.neverReassignedCache.get(sym);
  if (cached !== undefined) return cached;
  const written = fileWritesBinding(sym, ts.getSourceFileOfNode(decl), resolve);
  scope.neverReassignedCache.set(sym, !written);
  return !written;
}

/** True when something in `file` writes `sym` (the writes
 * bindingNeverReassigned counts), resolving identifiers with `resolve`. */
export function fileWritesBinding(
  sym: ts.Symbol,
  file: ts.SourceFile,
  resolve: (ident: ts.Identifier) => ts.Symbol | null | undefined,
  afterPos?: number,
): boolean {
  if (declarationsWriteBinding(sym)) return true;
  let written = false;
  /** Whether a write at `n` can execute after `afterPos`. */
  const lateEnough = (n: ts.Node): boolean => {
    if (afterPos === undefined || n.getStart(file) > afterPos) return true;
    for (let p = n.parent; p !== undefined && p !== file; p = p.parent) {
      if (
        ts.isFunctionLike(p) ||
        ts.isClassDeclaration(p) ||
        ts.isClassExpression(p) ||
        ts.isClassStaticBlockDeclaration(p)
      )
        return true;
    }
    return false;
  };
  // Text pre-check keeps the file walk cheap: only same-named
  // identifiers pay a symbol resolution.
  const symText = ts.symbolName(sym);
  const namesSym = (e: ts.Node): boolean =>
    ts.isIdentifier(e) && e.text === symText && resolve(e) === sym;
  const scanTarget = (t: ts.Expression): void => {
    let e: ts.Expression = t;
    while (ts.isParenthesizedExpression(e)) e = e.expression;
    if (namesSym(e)) {
      written = true;
      return;
    }
    // Destructuring assignment targets: any identifier inside the LHS
    // pattern could be the binding — over-approximate by scanning.
    if (ts.isArrayLiteralExpression(e) || ts.isObjectLiteralExpression(e)) {
      const walk = (n: ts.Node): void => {
        if (namesSym(n)) written = true;
        else ts.forEachChild(n, walk);
      };
      walk(e);
    }
  };
  const visit = (n: ts.Node): void => {
    if (written) return;
    if (ts.isBinaryExpression(n)) {
      const k = n.operatorToken.kind;
      if (
        k >= ts.SyntaxKind.FirstAssignment &&
        k <= ts.SyntaxKind.LastAssignment &&
        lateEnough(n)
      ) {
        scanTarget(n.left);
      }
    } else if (
      (ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) &&
      (n.operator === ts.SyntaxKind.PlusPlusToken ||
        n.operator === ts.SyntaxKind.MinusMinusToken) &&
      lateEnough(n)
    ) {
      scanTarget(n.operand as ts.Expression);
    } else if (
      (ts.isForOfStatement(n) || ts.isForInStatement(n)) &&
      !ts.isVariableDeclarationList(n.initializer) &&
      lateEnough(n)
    ) {
      scanTarget(n.initializer as ts.Expression);
    }
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(file, visit);
  return written;
}
/** True when `sym`'s own declarations write it after it holds a value:
 * a `var` in a for-in or for-of head is written on every iteration, a
 * `var` with an initializer inside a loop body is written each time the
 * body runs, and a binding declared more than once (`var x = 1; ... var x
 * = 2;`, a parameter or function declaration that a `var` redeclares) is
 * written by each initializing declaration that runs. Only value
 * declarations count, and of functions only implementations: overload
 * signatures have no body. A redeclaration without an initializer is
 * counted too, which only over-approximates. */
function declarationsWriteBinding(sym: ts.Symbol): boolean {
  let values = 0;
  let initializing = 0;
  for (const d of sym.declarations) {
    let root: ts.Node = d;
    while (
      root.parent !== undefined &&
      (ts.isBindingElement(root) ||
        ts.isObjectBindingPattern(root) ||
        ts.isArrayBindingPattern(root))
    )
      root = root.parent;
    if (ts.isVariableDeclaration(root)) {
      const list = root.parent;
      if (
        ts.isVariableDeclarationList(list) &&
        (list.flags & ts.NodeFlags.BlockScoped) === 0 &&
        (ts.isForInStatement(list.parent) || ts.isForOfStatement(list.parent))
      )
        return true;
      values++;
      if (root.initializer !== undefined) {
        if (insideLoopBody(root)) return true;
        initializing++;
      }
    } else if (
      ts.isParameter(root) ||
      (ts.isFunctionDeclaration(d) && d.body !== undefined) ||
      ts.isClassDeclaration(d)
    ) {
      values++;
      initializing++;
    }
  }
  return values > 1 && initializing > 0;
}

/** Whether a declaration sits in the body of a loop of its own function,
 * where it runs once per iteration. */
function insideLoopBody(node: ts.Node): boolean {
  let child = node;
  for (let parent = node.parent; parent !== undefined; parent = parent.parent) {
    if (
      ts.isFunctionLike(parent) ||
      ts.isClassStaticBlockDeclaration(parent) ||
      ts.isSourceFile(parent)
    )
      return false;
    if (
      (ts.isForStatement(parent) ||
        ts.isForInStatement(parent) ||
        ts.isForOfStatement(parent) ||
        ts.isWhileStatement(parent) ||
        ts.isDoStatement(parent)) &&
      parent.statement === child
    )
      return true;
    child = parent;
  }
  return false;
}
