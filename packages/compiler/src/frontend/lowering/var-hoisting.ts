/* Bindings that code can read before their first store: every `var`, and
 * a `let` declared without an initializer. JS gives such a read
 * `undefined`; a binding whose static type cannot hold it is promoted to
 * the type with an undefined arm (the runtime-optional storage), so the
 * read sees `undefined` and every use behaves as in Node. Bindings proven
 * stored before every read keep their storage.
 *
 * A `var` binding settles at the first statement of its hoisting scope (the
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
 *   settle. References from other modules settle when the module's body
 *   stores the binding: an importer's code runs after this module's body,
 *   and import cycles that read a `var` early are refused by the cycle
 *   analysis.
 *
 * A `let x: T;` holds undefined from its declaration to its first store.
 * tsc checks only the reads in the declaring scope's own code, and none at
 * all behind a definite-assignment assertion (`let x!: T`); a read inside a
 * function is never checked (`let cache: Map<K, V>; function get() { if
 * (cache === undefined) cache = new Map(); ... }`). Such a read settles
 * when a statement that stores the binding whenever it completes comes
 * before it in a statement list that holds it (storedBefore): the earlier
 * statement of a list always runs first. A read before the declaration
 * itself runs is the temporal dead zone, which is not this analysis's. */
import * as ts from "../ts7/adapter.js";
import { isJsSourceFile } from "../program.js";
import type { Lowerer } from "./lowerer.js";
import { boundIdentifiersOf } from "./lowerer.js";

type Scope = ts.SourceFile | ts.FunctionLikeDeclaration;

const IDENTIFIERS: ReadonlySet<ts.SyntaxKind> = new Set([ts.SyntaxKind.Identifier]);

interface Binding {
  scope: Scope;
  names: ts.Identifier[];
  /** A `let` declared without an initializer: the statement list (or `for`
   * statement) that scopes it, and whether tsc checked the reads in that
   * scope's own code (no `!` assertion). */
  lexical?: { scope: ts.Node; checked: boolean };
  /** Other modules can read the binding. */
  exported: boolean;
}

/** The bindings code can read before their first store, each with the
 * reference that can run that early (its declared name when the reader is
 * another module). */
export function earlyReadVarSymbols(
  lowerer: Lowerer,
  sourceFiles: readonly ts.SourceFile[],
): Map<ts.Symbol, ts.Identifier> {
  const checker = lowerer.checker;
  const out = new Map<ts.Symbol, ts.Identifier>();
  const neverReturns = (call: ts.CallExpression): boolean => {
    try {
      return (lowerer.typeOf(call).flags & ts.TypeFlags.Never) !== 0;
    } catch {
      return false;
    }
  };
  for (const sf of sourceFiles) {
    if (sf.isDeclarationFile) continue;
    const bindings = new Map<ts.Symbol, Binding>();
    const names = new Set<string>();
    const functionNames = new Set<string>();
    const js = isJsSourceFile(sf);
    ts.walkPreorder(sf, (node) => {
      if (ts.isFunctionDeclaration(node) && node.name !== undefined)
        functionNames.add(node.name.text);
      if (!ts.isVariableDeclarationList(node)) return undefined;
      if ((node.flags & (ts.NodeFlags.Const | ts.NodeFlags.Using)) !== 0) return undefined;
      const lexical = (node.flags & ts.NodeFlags.Let) !== 0;
      const statement = node.parent;
      const declared =
        statement !== undefined && ts.isVariableStatement(statement) ? statement : undefined;
      if (
        declared &&
        ts.getModifiers(declared)?.some((m) => m.kind === ts.SyntaxKind.DeclareKeyword)
      )
        return undefined;
      // A `for (let k in o)` or `for (let v of xs)` head stores its binding
      // on every pass.
      if (lexical && !declared && (statement === undefined || !ts.isForStatement(statement)))
        return undefined;
      // A `var` hoists past a namespace block to the file, whose statements
      // do not show the block's stores: only a file-level `var` is asked
      // whether the module stores it for its importers.
      const exported =
        declared !== undefined &&
        (lexical || declared.parent === sf) &&
        (ts.getModifiers(declared)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false);
      for (const declaration of node.declarations.nodes) {
        if (lexical) {
          // A `let` with an initializer is stored where it is declared.
          if (declaration.initializer !== undefined || !ts.isIdentifier(declaration.name)) continue;
          // tsc has checked every read in the declaring scope's own code:
          // only a name a nested function, a class or an export mentions
          // needs the analysis (and the checker queries) below.
          if (
            !js &&
            !exported &&
            declaration.exclamationToken === undefined &&
            !namedOutsideOwnCode(lexicalScopeOf(declared ?? statement!), declaration.name)
          )
            continue;
        }
        for (const name of boundIdentifiersOf(declaration.name)) {
          const symbol = checker.getSymbolAtLocation(name);
          if (symbol === undefined || !excludesUndefined(lowerer, name)) continue;
          const binding = bindings.get(symbol);
          if (binding) binding.names.push(name);
          else
            bindings.set(symbol, {
              scope: hoistingScopeOf(node),
              names: [name],
              ...(lexical
                ? {
                    lexical: {
                      scope: lexicalScopeOf(declared ?? statement!),
                      checked: declaration.exclamationToken === undefined,
                    },
                  }
                : {}),
              exported,
            });
          names.add(name.text);
        }
      }
      return undefined;
    });
    if (bindings.size === 0) continue;
    const refs = referencesByName(lowerer, sf, names);
    const analysis = new ScopeAnalysis(lowerer, sf, functionNames);
    for (const [symbol, binding] of bindings) {
      const references = refs.get(symbol) ?? [];
      if (binding.lexical) {
        const stores = new StoreAnalysis(new Set(references), neverReturns);
        const { scope, checked } = binding.lexical;
        const early =
          references.find(
            (ref) =>
              !binding.names.includes(ref) &&
              !isPlainWriteTarget(ref) &&
              !isExportedName(ref) &&
              !analysis.lexicalSettles(scope, stores, checked, ref),
          ) ??
          // No statement of the scope stores it, and another module can read it.
          ((binding.exported || references.some(isExportedName)) && !stores.storedIn(scope)
            ? binding.names[0]
            : undefined);
        if (early) out.set(symbol, early);
        continue;
      }
      const settle = analysis.settleIndex(binding.scope, symbol);
      const early =
        references.find(
          (ref) =>
            !binding.names.includes(ref) &&
            !isPlainWriteTarget(ref) &&
            !analysis.settles(binding.scope, settle, ref),
        ) ??
        // No statement of the module stores it, and another module can read it.
        (settle.index === Infinity &&
        ts.isSourceFile(binding.scope) &&
        (binding.exported || references.some(isExportedName))
          ? binding.names[0]
          : undefined);
      if (early) out.set(symbol, early);
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

/** The node whose statements scope a `let` declared by `statement`: the
 * block, source file or namespace body holding it, the whole case block
 * for a clause's (every clause sees the binding), or the `for` statement
 * declaring it in its head. */
function lexicalScopeOf(statement: ts.Node): ts.Node {
  if (ts.isForStatement(statement)) return statement;
  const parent = statement.parent!;
  return ts.isCaseClause(parent) || ts.isDefaultClause(parent) ? parent.parent! : parent;
}

/** Whether an identifier spelled like `name` occurs in `scope` inside a
 * function or class, in an export list or under `!`: the places a `let` of
 * that name can be read from that tsc's definite-assignment analysis does
 * not cover. */
function namedOutsideOwnCode(scope: ts.Node, name: ts.Identifier): boolean {
  let found = false;
  ts.walkPreorder(
    scope,
    (node) => {
      if (!ts.isIdentifier(node)) return undefined;
      if (node.text !== name.text || node === name) return undefined;
      if (isExportedName(node) || isNonNullAsserted(node)) found = true;
      for (let n = node.parent; !found && n !== undefined && n !== scope; n = n.parent)
        if (isDeferredCode(n)) found = true;
      return found ? "stop" : undefined;
    },
    IDENTIFIERS,
  );
  return found;
}

/** The statements `node` holds in order, when it is a statement list. */
function statementListOf(node: ts.Node): readonly ts.Statement[] | null {
  return ts.isBlock(node) ||
    ts.isSourceFile(node) ||
    ts.isModuleBlock(node) ||
    ts.isCaseClause(node) ||
    ts.isDefaultClause(node)
    ? node.statements.nodes
    : null;
}

/** `export { x }` or `export { x as y }` of the file's own binding. */
function isExportedName(ref: ts.Identifier): boolean {
  const parent = ref.parent;
  return (
    parent !== undefined &&
    ts.isExportSpecifier(parent) &&
    (parent.propertyName ?? parent.name) === ref
  );
}

/** `x!`: a read whose definite assignment tsc was told not to check. */
function isNonNullAsserted(ref: ts.Identifier): boolean {
  let node: ts.Node = ref;
  while (node.parent !== undefined && ts.isParenthesizedExpression(node.parent)) node = node.parent;
  return node.parent !== undefined && ts.isNonNullExpression(node.parent);
}

/** The binding a function expression is stored in where it is created
 * (`const f = () => ...`, `f = function () { ... };`), the only name it
 * can be reached through from there on. An assignment used as a value
 * hands the function on, and a class expression runs its static code
 * where it is written: neither has one. */
function holderOf(code: ts.Node): ts.Identifier | null {
  if (!ts.isArrowFunction(code) && !ts.isFunctionExpression(code)) return null;
  let value: ts.Node = code;
  while (value.parent !== undefined && ts.isParenthesizedExpression(value.parent))
    value = value.parent;
  const parent = value.parent;
  if (parent === undefined) return null;
  if (ts.isVariableDeclaration(parent))
    return parent.initializer === value && ts.isIdentifier(parent.name) ? parent.name : null;
  if (
    !ts.isBinaryExpression(parent) ||
    parent.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
    parent.right !== value ||
    parent.parent === undefined ||
    !ts.isExpressionStatement(parent.parent)
  )
    return null;
  let target: ts.Node = parent.left;
  while (ts.isParenthesizedExpression(target)) target = target.expression;
  return ts.isIdentifier(target) ? target : null;
}

/** The name of a variable declaration: not a use of the binding. */
function isDeclaredName(ref: ts.Identifier): boolean {
  const parent = ref.parent;
  return parent !== undefined && ts.isVariableDeclaration(parent) && parent.name === ref;
}

/** Whether `name` is declared by an exported function or variable
 * statement. */
function isExportedDeclaration(name: ts.Identifier): boolean {
  const declaration = name.parent;
  const statement =
    declaration !== undefined && ts.isFunctionDeclaration(declaration)
      ? declaration
      : declaration !== undefined && ts.isVariableDeclaration(declaration)
        ? declaration.parent?.parent
        : undefined;
  return (
    statement !== undefined &&
    (ts.isFunctionDeclaration(statement) || ts.isVariableStatement(statement)) &&
    (ts.getModifiers(statement)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false)
  );
}

/** A function, class or static block: its code runs when it is called or
 * evaluated, not where it is written. */
function isDeferredCode(node: ts.Node): boolean {
  return (
    ts.isFunctionLike(node) ||
    ts.isClassDeclaration(node) ||
    ts.isClassExpression(node) ||
    ts.isClassStaticBlockDeclaration(node)
  );
}

/** Which statements and expressions store one `let` binding whenever they
 * complete. `targets` holds the identifiers that name the binding. */
class StoreAnalysis {
  constructor(
    private readonly targets: ReadonlySet<ts.Node>,
    /** Whether a call never returns (its type is `never`). */
    private readonly neverReturns: (call: ts.CallExpression) => boolean,
  ) {}

  /** Whether `identifier` names the binding. */
  names(identifier: ts.Identifier): boolean {
    return this.targets.has(identifier);
  }

  /** Whether a statement of `scope`'s own list stores the binding. */
  storedIn(scope: ts.Node): boolean {
    return statementListOf(scope)?.some((s) => this.stores(s)) ?? false;
  }

  /** Whether a statement that stores the binding comes before `node` in a
   * statement list between `node` and `scope`: control reaches a statement
   * of a list only through the ones before it. That holds across the
   * functions and classes on the way, which run after the statement that
   * creates them, except a function declaration: it is hoisted, so the
   * statements before it say nothing about when it runs. */
  storedBefore(scope: ts.Node, node: ts.Node): boolean {
    for (let n: ts.Node = node; n.parent !== undefined && n !== scope; n = n.parent) {
      if (ts.isFunctionDeclaration(n)) return false;
      const list = statementListOf(n.parent);
      if (list === null) continue;
      for (const s of list) {
        if (s === n) break;
        if (this.stores(s)) return true;
      }
    }
    return false;
  }

  /** Whether the binding is stored whenever statement `s` completes
   * normally. Loops, switches and labeled statements are not followed: a
   * jump can leave them with the store skipped. */
  private stores(s: ts.Node): boolean {
    if (ts.isExpressionStatement(s)) return this.evaluates(s.expression);
    if (ts.isVariableStatement(s))
      return s.declarationList.declarations.nodes.some(
        (d) => d.initializer !== undefined && this.evaluates(d.initializer),
      );
    if (ts.isBlock(s)) return s.statements.nodes.some((child) => this.stores(child));
    if (ts.isIfStatement(s))
      return (
        this.evaluates(s.expression) ||
        (s.elseStatement !== undefined &&
          this.storesOrLeaves(s.thenStatement) &&
          this.storesOrLeaves(s.elseStatement))
      );
    if (ts.isTryStatement(s))
      return (
        (s.finallyBlock !== undefined && this.stores(s.finallyBlock)) ||
        (this.stores(s.tryBlock) &&
          (s.catchClause === undefined || this.storesOrLeaves(s.catchClause.block)))
      );
    return false;
  }

  private storesOrLeaves(s: ts.Node): boolean {
    return this.stores(s) || this.leaves(s);
  }

  /** Whether statement `s` never completes normally: control leaves the
   * statement list that holds it, by a jump or by a call that never
   * returns (`fail(message)`, `process.exit(1)`). */
  private leaves(s: ts.Node): boolean {
    if (
      ts.isReturnStatement(s) ||
      ts.isThrowStatement(s) ||
      ts.isBreakStatement(s) ||
      ts.isContinueStatement(s)
    )
      return true;
    if (ts.isExpressionStatement(s)) {
      let call: ts.Node = s.expression;
      while (ts.isParenthesizedExpression(call)) call = call.expression;
      return ts.isCallExpression(call) && this.neverReturns(call);
    }
    if (ts.isBlock(s)) return s.statements.nodes.some((child) => this.leaves(child));
    return (
      ts.isIfStatement(s) &&
      s.elseStatement !== undefined &&
      this.leaves(s.thenStatement) &&
      this.leaves(s.elseStatement)
    );
  }

  /** Whether evaluating `e` to completion stores the binding: a plain or
   * destructuring assignment to it outside every operand that may be
   * skipped and every nested function. */
  private evaluates(e: ts.Node): boolean {
    let found = false;
    ts.walkPreorder(e, (node) => {
      if (isDeferredCode(node)) return "skip";
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        this.assigns(node.left) &&
        alwaysEvaluated(node, e)
      ) {
        found = true;
        return "stop";
      }
      return undefined;
    });
    return found;
  }

  /** Whether the assignment target `target` names the binding, directly or
   * inside a destructuring pattern (every element of one is assigned). */
  private assigns(target: ts.Node): boolean {
    if (this.targets.has(target)) return true;
    if (ts.isParenthesizedExpression(target)) return this.assigns(target.expression);
    if (ts.isArrayLiteralExpression(target))
      return target.elements.nodes.some((el) => this.assigns(el));
    if (ts.isObjectLiteralExpression(target))
      return target.properties.nodes.some((p) =>
        ts.isShorthandPropertyAssignment(p)
          ? this.targets.has(p.name)
          : ts.isPropertyAssignment(p)
            ? this.assigns(p.initializer)
            : ts.isSpreadAssignment(p) && this.assigns(p.expression),
      );
    if (ts.isSpreadElement(target)) return this.assigns(target.expression);
    // `[x = fallback] = values` still assigns x.
    return (
      ts.isBinaryExpression(target) &&
      target.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      this.assigns(target.left)
    );
  }
}

/** Whether `node` is evaluated whenever `root`, which contains it, is: no
 * operator between them can skip it (the right side of `&&`, `||` or `??`,
 * a branch of a conditional, a link of an optional chain). */
function alwaysEvaluated(node: ts.Node, root: ts.Node): boolean {
  for (let child = node; child !== root; child = child.parent!) {
    const parent = child.parent!;
    if (ts.isBinaryExpression(parent) && parent.right === child) {
      const operator = parent.operatorToken.kind;
      if (
        operator === ts.SyntaxKind.AmpersandAmpersandToken ||
        operator === ts.SyntaxKind.BarBarToken ||
        operator === ts.SyntaxKind.QuestionQuestionToken ||
        operator === ts.SyntaxKind.AmpersandAmpersandEqualsToken ||
        operator === ts.SyntaxKind.BarBarEqualsToken ||
        operator === ts.SyntaxKind.QuestionQuestionEqualsToken
      )
        return false;
    }
    if (ts.isConditionalExpression(parent) && parent.condition !== child) return false;
    if (
      (parent.flags & ts.NodeFlags.OptionalChain) !== 0 &&
      (parent as ts.Node & { expression?: ts.Node }).expression !== child
    )
      return false;
  }
  return true;
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
  /** The same answers for one `let` binding's stores. */
  private readonly lexicalFunctionMemo = new Map<StoreAnalysis, Map<ts.Node, boolean>>();
  /** The file's identifiers named like one of its function declarations,
   * by name, collected in one walk on first use. */
  private functionNameIdents: Map<string, ts.Identifier[]> | null = null;
  private readonly otherNameIdents = new Map<string, ts.Identifier[]>();

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

  /** Whether `ref` (inside `scope`, the scope of a `let` declared without an
   * initializer) runs only after a store to that binding. `read`: `ref`
   * reads the binding itself, so tsc vouches for one in the scope's own
   * code when the declaration is `checked`. */
  lexicalSettles(
    scope: ts.Node,
    stores: StoreAnalysis,
    checked: boolean,
    ref: ts.Identifier,
    read = true,
  ): boolean {
    // The outermost function or class between the scope and the reference:
    // the reference cannot run before that construct is evaluated.
    let deferred: ts.Node | null = null;
    let n: ts.Node = ref;
    for (; n.parent !== undefined && n !== scope; n = n.parent) if (isDeferredCode(n)) deferred = n;
    if (n !== scope) return false;
    // A store earlier in a statement list around the reference: in the
    // function that holds it, or in code that creates that function.
    if (stores.storedBefore(scope, ref)) return true;
    // `x!` waives tsc's check of that read, as `let x!: T` does of all.
    if (deferred === null) return read && checked && !this.js && !isNonNullAsserted(ref);
    // A function declaration is hoisted: where it is written says nothing.
    if (ts.isFunctionDeclaration(deferred) && deferred.name !== undefined)
      return this.lexicalNamedSettles(scope, stores, checked, deferred, deferred.name);
    const holder = holderOf(deferred);
    if (holder === null) return false;
    // `x = () => x`: the function exists only once this store has run.
    return (
      stores.names(holder) || this.lexicalNamedSettles(scope, stores, checked, deferred, holder)
    );
  }

  /** `code` runs wherever `name` is used: a function declaration, which is
   * hoisted, or a function expression stored in the binding `name` where
   * it is created. Every use must settle, and a use outside this file (an
   * exported name) runs after the module's body, which must store the
   * binding. */
  private lexicalNamedSettles(
    scope: ts.Node,
    stores: StoreAnalysis,
    checked: boolean,
    code: ts.Node,
    name: ts.Identifier,
  ): boolean {
    const known = this.lexicalFunctionMemo.get(stores)?.get(code);
    if (known !== undefined) return known;
    const memo = this.lexicalFunctionMemo.get(stores) ?? new Map<ts.Node, boolean>();
    this.lexicalFunctionMemo.set(stores, memo);
    memo.set(code, true);
    const references = this.referencesOf(name);
    const exported = isExportedDeclaration(name) || references.some(isExportedName);
    const result =
      (!exported || stores.storedIn(scope)) &&
      references.every(
        (ref) =>
          isInside(ref, code) ||
          isExportedName(ref) ||
          // Declaring the name or storing another value in it runs nothing.
          isDeclaredName(ref) ||
          isPlainWriteTarget(ref) ||
          this.lexicalSettles(scope, stores, checked, ref, false),
      );
    memo.set(code, result);
    return result;
  }

  private functionSettles(scope: Scope, settle: Settle, fn: ts.FunctionDeclaration): boolean {
    const key = `${fn.pos}:${settle.index}:${settle.end}:${settle.loop}`;
    const known = this.functionMemo.get(key);
    if (known !== undefined) return known;
    this.functionMemo.set(key, true);
    const references = this.referencesOf(fn.name!);
    // An exported function runs after the module's body, which stores the
    // binding only when one of its statements does.
    const exported =
      (ts.getModifiers(fn)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false) ||
      references.some(isExportedName);
    const result =
      !(exported && settle.index === Infinity) &&
      references.every(
        (ref) =>
          isInside(ref, fn) || isExportedName(ref) || this.settles(scope, settle, ref, false),
      );
    this.functionMemo.set(key, result);
    return result;
  }

  /** The other identifiers that name the binding `name` declares or
   * stores. */
  private referencesOf(name: ts.Identifier): ts.Identifier[] {
    const cached = this.functionRefs.get(name);
    if (cached) return cached;
    const symbol = this.lowerer.checker.getSymbolAtLocation(name);
    const refs =
      symbol === undefined
        ? []
        : (
            referencesBySymbol(this.lowerer, this.identifiersNamed(name.text)).get(symbol) ?? []
          ).filter((ref) => ref !== name);
    this.functionRefs.set(name, refs);
    return refs;
  }

  /** The file's identifiers named `text`: the function declarations' names
   * come from one walk, any other name from a walk of its own. */
  private identifiersNamed(text: string): readonly ts.Identifier[] {
    if (this.functionNames.has(text)) {
      this.functionNameIdents ??= identifiersByName(this.sf, this.functionNames);
      return this.functionNameIdents.get(text) ?? [];
    }
    let idents = this.otherNameIdents.get(text);
    if (idents === undefined) {
      idents = identifiersByName(this.sf, new Set([text])).get(text) ?? [];
      this.otherNameIdents.set(text, idents);
    }
    return idents;
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
