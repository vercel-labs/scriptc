/* `var` bindings that code can read before their first store. JS gives such
 * a read `undefined`; a binding whose static type cannot hold it is
 * promoted to the type with an undefined arm (the runtime-optional
 * storage), so the read sees `undefined` and every use behaves as in
 * Node. Bindings proven stored before every read keep their storage.
 *
 * A binding settles at the first statement of its hoisting scope (the
 * function body or the source file) that stores it unconditionally: a
 * direct `var x = e`, `x = e;`, or a `for` loop declaring it (`for (var
 * i = 0; ...)`), whose own condition, update and body run after the store.
 * A `for (var k in o)` or `for (var v of xs)` loop stores the binding only
 * when it iterates, so it settles the reads in its body and no others. A
 * read settles when it runs after the settling statement:
 * - a read in the scope's own code, in a TypeScript file: tsc's
 *   definite-assignment analysis rejects any earlier one;
 * - a read in the scope's own code, in a JavaScript file: its statement
 *   comes after the settling one;
 * - a read inside a function, class or object method: the outermost
 *   such construct is evaluated by a statement after the settling one,
 *   or it is a (hoisted) function declaration whose own references all
 *   settle. References from other modules settle: an importer's code
 *   runs after this module's body, and import cycles that read a `var`
 *   early are refused by the cycle analysis. */
import * as ts from "../ts7/adapter.js";
import { isJsSourceFile } from "../program.js";
import type { Lowerer } from "./lowerer.js";
import { boundIdentifiersOf } from "./lowerer.js";

type Scope = ts.SourceFile | ts.FunctionLikeDeclaration;

interface Binding {
  scope: Scope;
  names: ts.Identifier[];
}

export function earlyReadVarSymbols(
  lowerer: Lowerer,
  sourceFiles: readonly ts.SourceFile[],
): Set<ts.Symbol> {
  const checker = lowerer.checker;
  const out = new Set<ts.Symbol>();
  for (const sf of sourceFiles) {
    if (sf.isDeclarationFile) continue;
    const bindings = new Map<ts.Symbol, Binding>();
    const names = new Set<string>();
    const functionNames = new Set<string>();
    ts.walkPreorder(sf, (node) => {
      if (ts.isFunctionDeclaration(node) && node.name !== undefined)
        functionNames.add(node.name.text);
      if (!ts.isVariableDeclarationList(node)) return undefined;
      if ((node.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const | ts.NodeFlags.Using)) !== 0)
        return undefined;
      const statement = node.parent;
      if (
        statement !== undefined &&
        ts.isVariableStatement(statement) &&
        ts.getModifiers(statement)?.some((m) => m.kind === ts.SyntaxKind.DeclareKeyword)
      )
        return undefined;
      for (const declaration of node.declarations.nodes) {
        for (const name of boundIdentifiersOf(declaration.name)) {
          const symbol = checker.getSymbolAtLocation(name);
          if (symbol === undefined || !excludesUndefined(lowerer, name)) continue;
          const binding = bindings.get(symbol);
          if (binding) binding.names.push(name);
          else bindings.set(symbol, { scope: hoistingScopeOf(node), names: [name] });
          names.add(name.text);
        }
      }
      return undefined;
    });
    if (bindings.size === 0) continue;
    const refs = referencesByName(lowerer, sf, names);
    const analysis = new ScopeAnalysis(lowerer, sf, functionNames);
    for (const [symbol, binding] of bindings) {
      const settle = analysis.settleIndex(binding.scope, symbol);
      const early = (refs.get(symbol) ?? []).some(
        (ref) =>
          !binding.names.includes(ref) &&
          !isPlainWriteTarget(ref) &&
          !analysis.settles(binding.scope, settle, ref),
      );
      if (early) out.add(symbol);
    }
  }
  return out;
}

/** The function body or source file a `var` hoists to. */
function hoistingScopeOf(node: ts.Node): Scope {
  for (let p = node.parent; p !== undefined; p = p.parent) {
    if (ts.isSourceFile(p)) return p;
    if (
      (ts.isFunctionDeclaration(p) ||
        ts.isFunctionExpression(p) ||
        ts.isArrowFunction(p) ||
        ts.isMethodDeclaration(p) ||
        ts.isConstructorDeclaration(p) ||
        ts.isGetAccessorDeclaration(p) ||
        ts.isSetAccessorDeclaration(p)) &&
      p.body !== undefined
    )
      return p;
  }
  return ts.getSourceFileOfNode(node);
}

function statementsOf(scope: Scope): readonly ts.Statement[] {
  if (ts.isSourceFile(scope)) return scope.statements.nodes;
  const body = scope.body;
  return body !== undefined && ts.isBlock(body) ? body.statements.nodes : [];
}

/** Whether the binding's declared type has no undefined value. */
function excludesUndefined(lowerer: Lowerer, name: ts.Identifier): boolean {
  let type: ts.Type;
  try {
    type = lowerer.typeOf(name);
  } catch {
    return false;
  }
  const loose =
    ts.TypeFlags.Any |
    ts.TypeFlags.Unknown |
    ts.TypeFlags.Undefined |
    ts.TypeFlags.Void |
    ts.TypeFlags.Never;
  if ((type.flags & loose) !== 0) return false;
  if (type.isUnionType() && ts.constituentTypes(type).some((t) => (t.flags & loose) !== 0))
    return false;
  return true;
}

function isPlainWriteTarget(ref: ts.Identifier): boolean {
  let target: ts.Node = ref;
  while (ts.isParenthesizedExpression(target.parent) && target.parent.expression === target)
    target = target.parent;
  const parent = target.parent;
  return (
    parent !== undefined &&
    ts.isBinaryExpression(parent) &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    parent.left === target
  );
}

/** Identifier references in `sf` named in `names`, by resolved symbol.
 * Declaration names and type positions resolve too; callers filter. */
function referencesByName(
  lowerer: Lowerer,
  sf: ts.SourceFile,
  names: ReadonlySet<string>,
): Map<ts.Symbol, ts.Identifier[]> {
  const idents: ts.Identifier[] = [];
  ts.walkPreorder(sf, (node) => {
    if (ts.isIdentifier(node) && names.has(node.text)) idents.push(node);
    return undefined;
  });
  return referencesBySymbol(lowerer, idents);
}

/** The identifiers of `sf` named in `names`, by name, each list in source
 * order. */
function identifiersByName(
  sf: ts.SourceFile,
  names: ReadonlySet<string>,
): Map<string, ts.Identifier[]> {
  const out = new Map<string, ts.Identifier[]>();
  ts.walkPreorder(sf, (node) => {
    if (!ts.isIdentifier(node) || !names.has(node.text)) return undefined;
    const list = out.get(node.text);
    if (list) list.push(node);
    else out.set(node.text, [node]);
    return undefined;
  });
  return out;
}

/** `idents` by resolved symbol, each list in the order of `idents`. */
function referencesBySymbol(
  lowerer: Lowerer,
  idents: readonly ts.Identifier[],
): Map<ts.Symbol, ts.Identifier[]> {
  lowerer.checker.prefetchSymbolNodesExact(idents);
  const out = new Map<ts.Symbol, ts.Identifier[]>();
  for (const id of idents) {
    let symbol = lowerer.checker.getSymbolAtLocation(id);
    const parent = id.parent;
    if (parent !== undefined && ts.isShorthandPropertyAssignment(parent) && parent.name === id)
      symbol = lowerer.checker.getShorthandAssignmentValueSymbol(parent) ?? symbol;
    if (symbol === undefined) continue;
    const list = out.get(symbol) ?? [];
    list.push(id);
    out.set(symbol, list);
  }
  return out;
}

/** Where a binding is first stored unconditionally: the scope statement's
 * index, and for a declarator of a `var` statement or a `for` initializer,
 * the list and the declarator's end. */
interface Settle {
  index: number;
  list: ts.VariableDeclarationList | null;
  end: number;
  /** The first for-in/of loop declaring the binding before `index`, whose
   * body runs after its store, or -1. */
  loop: number;
}

class ScopeAnalysis {
  private readonly js: boolean;
  /** Whether a function declaration's references all settle, by scope
   * and settling index (in progress counts as settled: a function only
   * its own body names is never called through that name). */
  private readonly functionMemo = new Map<string, boolean>();
  private readonly functionRefs = new Map<ts.Node, ts.Identifier[]>();
  /** The file's identifiers named like one of its function declarations,
   * by name, collected in one walk on first use. */
  private functionNameIdents: Map<string, ts.Identifier[]> | null = null;

  constructor(
    private readonly lowerer: Lowerer,
    private readonly sf: ts.SourceFile,
    private readonly functionNames: ReadonlySet<string>,
  ) {
    this.js = isJsSourceFile(sf);
  }

  /** The index of the scope statement that first stores `symbol`
   * unconditionally (Infinity when none does), and, when that statement
   * declares it in a `var` statement or a `for` initializer, the end of the
   * storing declarator: later declarators of the list run after it. */
  settleIndex(scope: Scope, symbol: ts.Symbol): Settle {
    const statements = statementsOf(scope);
    const checker = this.lowerer.checker;
    let loopIndex = -1;
    for (let i = 0; i < statements.length; i++) {
      const s = statements[i]!;
      const list = ts.isVariableStatement(s)
        ? s.declarationList
        : (ts.isForStatement(s) || ts.isForInStatement(s) || ts.isForOfStatement(s)) &&
            s.initializer !== undefined &&
            ts.isVariableDeclarationList(s.initializer)
          ? s.initializer
          : null;
      if (list !== null) {
        const loop = !ts.isVariableStatement(s) && !ts.isForStatement(s);
        for (const d of list.declarations.nodes) {
          if (
            (d.initializer !== undefined || loop) &&
            boundIdentifiersOf(d.name).some((n) => checker.getSymbolAtLocation(n) === symbol)
          ) {
            if (!loop) return { index: i, list, end: d.end, loop: loopIndex };
            if (loopIndex < 0) loopIndex = i;
          }
        }
      } else if (
        ts.isExpressionStatement(s) &&
        ts.isBinaryExpression(s.expression) &&
        s.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(s.expression.left) &&
        checker.getSymbolAtLocation(s.expression.left) === symbol
      ) {
        return { index: i, list: null, end: -1, loop: loopIndex };
      }
    }
    return { index: Infinity, list: null, end: -1, loop: loopIndex };
  }

  /** Whether `ref` (inside `scope`, or in another module) runs only after
   * the store `settle` describes. `read`: `ref` reads the binding itself,
   * so tsc vouches for one in the scope's own code. */
  settles(scope: Scope, settle: Settle, ref: ts.Identifier, read = true): boolean {
    if (ts.getSourceFileOfNode(ref) !== this.sf) return true;
    const statements = statementsOf(scope);
    let deferred: ts.Node | null = null;
    let top: ts.Node | null = null;
    const container: ts.Node | undefined = ts.isSourceFile(scope) ? scope : scope.body;
    for (let n: ts.Node = ref; n.parent !== undefined && n !== scope; n = n.parent) {
      if (
        ts.isFunctionLike(n) ||
        ts.isClassDeclaration(n) ||
        ts.isClassExpression(n) ||
        ts.isClassStaticBlockDeclaration(n)
      )
        deferred = n;
      // The scope's own statement, not the function body that holds it.
      if (n.parent === container) top = n;
    }
    if (top === null) return false;
    if (deferred === null && read && !this.js) return true;
    if (deferred !== null && ts.isFunctionDeclaration(deferred) && deferred.name !== undefined)
      return this.functionSettles(scope, settle, deferred);
    const index = statements.indexOf(top as ts.Statement);
    return (
      index > settle.index ||
      (index === settle.index &&
        (settlesWithin(top, ref) ||
          // A later declarator of the storing list (`var a = {}, b = { ...a }`).
          (settle.list !== null && isInside(ref, settle.list) && ref.pos >= settle.end))) ||
      (index === settle.loop && settlesWithin(top, ref))
    );
  }

  private functionSettles(scope: Scope, settle: Settle, fn: ts.FunctionDeclaration): boolean {
    const key = `${fn.pos}:${settle.index}:${settle.end}:${settle.loop}`;
    const known = this.functionMemo.get(key);
    if (known !== undefined) return known;
    this.functionMemo.set(key, true);
    const result = this.referencesOf(fn).every(
      (ref) => isInside(ref, fn) || this.settles(scope, settle, ref, false),
    );
    this.functionMemo.set(key, result);
    return result;
  }

  private referencesOf(fn: ts.FunctionDeclaration): ts.Identifier[] {
    const cached = this.functionRefs.get(fn);
    if (cached) return cached;
    const name = fn.name!;
    const symbol = this.lowerer.checker.getSymbolAtLocation(name);
    const refs =
      symbol === undefined
        ? []
        : (
            referencesBySymbol(this.lowerer, this.identifiersNamed(name.text)).get(symbol) ?? []
          ).filter((ref) => ref !== name);
    this.functionRefs.set(fn, refs);
    return refs;
  }

  /** The identifiers named `text`, the name of a function declaration of
   * the file. */
  private identifiersNamed(text: string): readonly ts.Identifier[] {
    this.functionNameIdents ??= identifiersByName(this.sf, this.functionNames);
    return this.functionNameIdents.get(text) ?? [];
  }
}

/** A loop statement that settles the binding settles the references in
 * its condition, update and body: its declarations run first. */
function settlesWithin(statement: ts.Node, ref: ts.Node): boolean {
  if (ts.isForStatement(statement))
    return statement.initializer === undefined || !isInside(ref, statement.initializer);
  if (ts.isForInStatement(statement) || ts.isForOfStatement(statement))
    return isInside(ref, statement.statement);
  return false;
}

function isInside(node: ts.Node, container: ts.Node): boolean {
  for (let n: ts.Node | undefined = node; n !== undefined; n = n.parent)
    if (n === container) return true;
  return false;
}
