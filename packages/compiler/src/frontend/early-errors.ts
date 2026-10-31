/* ECMAScript early errors the TypeScript checker does not model.
 *
 * Static semantics reject a program before it runs, and until this pass
 * existed scriptc borrowed that rejection from whatever tsc happened to
 * report (`Let x` declarations at an odd position, a redeclared block name
 * TypeScript refuses). Test262's negative-parse suites show where the
 * borrowing stops: 1,198 programs the spec makes SyntaxErrors compile — the
 * constructs below are the ones the corpus covers, in descending variant
 * count (plan §7.7 D-4 option (c)).
 *
 * One code per construct, so C1's checker relaxation stays safe: relaxing a
 * tsc code that doubles as an early error removes the ONLY rejection some
 * parse-negative test had, which is why these codes live beside
 * JS_RELAXED_TSC_CODES in tsc-codes.ts and never depend on it.
 *
 * Scope: JavaScript sources only. A TypeScript source is type-checked, and
 * its checker diagnostics (TS2451 and friends) are the gate; re-reporting
 * the same collision under a second code would only duplicate them.
 *
 * The pass runs at preflight, before any lowering, and reports through
 * SC0xxx — the preflight band — so a rejected program fails the same way a
 * tsc error does. */

import * as ts from "./ts7/adapter.js";
import type { ScrDiagnostic } from "../diagnostics/diagnostic.js";
import type { SrcLoc } from "../ir/ir.js";
import { isJsSourceFileName } from "./tsc-codes.js";

/** The early-error codes. SC0005 and SC0006 are the Block/CaseBlock static
 * semantics (a statement list may not declare one lexical name twice, and a
 * lexical name may not be `var`-declared in the same list); SC0007 is a
 * declaration where the grammar admits only a Statement; SC0008 is
 * ContainsArguments over a class field initializer or a static block. */
export const EARLY_ERROR_CODES = ["SC0005", "SC0006", "SC0007", "SC0008"] as const;

const NO_DUPLICATE_LEXICAL = "SC0005";
const LEXICAL_VAR_COLLISION = "SC0006";
const NOT_A_STATEMENT = "SC0007";
const CONTAINS_ARGUMENTS = "SC0008";

/** Whether the code around a node is strict — the one input this pass needs
 * from outside: Node's own module classification (program.ts's
 * isNodeEsmFile7: fixed extensions, package type, then syntax markers). The
 * checker's external-module bit cannot answer it, because
 * moduleDetection=force gives every file module scope, CommonJS included. */
export type IsStrictCode = (sf: ts.SourceFile, node: ts.Node) => boolean;

export function earlyErrorDiagnostics7(
  files: readonly ts.SourceFile[],
  isModuleCode: (sf: ts.SourceFile) => boolean,
): ScrDiagnostic[] {
  const diags: ScrDiagnostic[] = [];
  const isStrict: IsStrictCode = (sf, node) => isStrictCode(sf, node, isModuleCode);
  for (const sf of files) {
    if (!isJsSourceFileName(sf.fileName)) continue;
    // Iterative walk: a deeply nested program must not overflow the stack
    // before the lowering's own nesting fence runs.
    const stack: ts.Node[] = [sf];
    while (stack.length > 0) {
      const node = stack.pop()!;
      checkStatementListScope(sf, node, diags, isStrict);
      checkStatementSlot(node, diags, isStrict);
      checkContainsArguments(node, diags);
      ts.forEachChild(node, (child) => {
        stack.push(child);
        return undefined;
      });
    }
  }
  return diags;
}

function locOf(node: ts.Node): SrcLoc {
  const sf = ts.getSourceFileOfNode(node);
  return { file: sf.fileName, start: node.getStart(sf), end: node.end };
}

function report(diags: ScrDiagnostic[], code: EarlyErrorCode, node: ts.Node, message: string) {
  diags.push({ code, message, loc: locOf(node) });
}

type EarlyErrorCode = (typeof EARLY_ERROR_CODES)[number];

/* ── SC0005 / SC0006: Block and CaseBlock static semantics ───────────────
 *
 *   Block : { StatementList }
 *   CaseBlock : { CaseClauses_opt DefaultClause CaseClauses_opt }
 *
 *   * It is a Syntax Error if the LexicallyDeclaredNames of StatementList
 *     contains any duplicate entries.
 *   * It is a Syntax Error if any element of the LexicallyDeclaredNames of
 *     StatementList also occurs in the VarDeclaredNames of StatementList.
 *
 * A case block is ONE lexical scope across its clauses, and VarDeclaredNames
 * reach into nested blocks (a `var` anywhere below the block belongs to it)
 * but never into a function or class body. The duplicate rule's one carve-out
 * is Annex B's B.3.3.1: two plain function declarations of the same name in
 * the same block are legal in non-strict code.
 *
 * A function body and a class static block have the same two rules over
 * their top-level declarations (FunctionStatementList and
 * ClassStaticBlockStatementList), but there a function declaration is
 * var-scoped: it is one of the VarDeclaredNames, so two of them are legal in
 * strict code too, while `let f; function f() {}` still collides. */

function checkStatementListScope(
  sf: ts.SourceFile,
  node: ts.Node,
  diags: ScrDiagnostic[],
  isStrict: IsStrictCode,
): void {
  let statements: readonly ts.Statement[] | null = null;
  if (ts.isBlock(node)) statements = node.statements.nodes;
  else if (ts.isCaseBlock(node)) {
    statements = node.clauses.nodes.flatMap((clause) => clause.statements.nodes);
  }
  if (statements === null) return;
  if (statements.length < 2) return;
  const functionBody = isFunctionBody(node);

  const lexical = new Map<string, ts.Node[]>();
  for (const stmt of statements) {
    for (const [name, decl] of lexicalDeclarationsOf(stmt, functionBody)) {
      const list = lexical.get(name);
      if (list === undefined) lexical.set(name, [decl]);
      else list.push(decl);
    }
  }
  if (lexical.size === 0) return;

  const varNames = new Set<string>();
  for (const stmt of statements) {
    collectVarDeclaredNames(stmt, varNames);
    if (functionBody && ts.isFunctionDeclaration(stmt) && stmt.name !== undefined)
      varNames.add(stmt.name.text);
  }

  for (const [name, decls] of lexical) {
    if (varNames.has(name)) {
      report(
        diags,
        LEXICAL_VAR_COLLISION,
        decls[0]!,
        functionBody
          ? `the lexical declaration '${name}' collides with a 'var' or function declaration of the same name in this function body`
          : `the lexical declaration '${name}' collides with a 'var' declaration of the same name in this block`,
      );
      continue;
    }
    if (decls.length < 2) continue;
    // Annex B B.3.3.1: duplicate plain function declarations are the web's
    // legacy, and only non-strict code keeps them.
    if (decls.every((d) => ts.isFunctionDeclaration(d) && !isEnhancedFunction(d))) {
      if (!isStrict(sf, decls[0]!)) continue;
    }
    report(
      diags,
      NO_DUPLICATE_LEXICAL,
      decls[1]!,
      `the declaration '${name}' is already declared in this block's statement list`,
    );
  }
}

/** Whether a block is the body of a function or a class static block, whose
 * top-level function declarations are var-scoped. */
function isFunctionBody(node: ts.Node): boolean {
  const parent = node.parent;
  if (parent === undefined || !ts.isBlock(node)) return false;
  if (ts.isClassStaticBlockDeclaration(parent)) return true;
  return ts.isFunctionLike(parent) && (parent as { body?: ts.Node }).body === node;
}

/** The names a DIRECT statement of a statement list declares lexically
 * (let/const/using, class, and every function declaration form outside a
 * function body), paired with the node to point the diagnostic at. */
function lexicalDeclarationsOf(
  stmt: ts.Statement,
  functionBody: boolean,
): Array<[string, ts.Node]> {
  const names: Array<[string, ts.Node]> = [];
  if (ts.isVariableStatement(stmt)) {
    if ((stmt.declarationList.flags & ts.NodeFlags.BlockScoped) === 0) return names;
    for (const decl of stmt.declarationList.declarations.nodes)
      collectBindingNames(decl.name, names);
    return names;
  }
  if (ts.isClassDeclaration(stmt) || (ts.isFunctionDeclaration(stmt) && !functionBody)) {
    const name = stmt.name;
    if (name !== undefined && ts.isIdentifier(name)) names.push([name.text, stmt]);
  }
  return names;
}

function collectBindingNames(name: ts.BindingName, into: Array<[string, ts.Node]>): void {
  if (ts.isIdentifier(name)) {
    into.push([name.text, name]);
    return;
  }
  for (const element of name.elements.nodes) {
    if (ts.isOmittedExpression(element)) continue;
    if (ts.isBindingElement(element) && element.name !== undefined)
      collectBindingNames(element.name, into);
  }
}

/** VarDeclaredNames of a statement: every `var`-declared name below it,
 * stopping at function and class boundaries (their declarations are not
 * var-scoped here). */
function collectVarDeclaredNames(root: ts.Node, into: Set<string>): void {
  const stack: ts.Node[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (ts.isFunctionLike(node) || ts.isClassDeclaration(node) || ts.isClassExpression(node))
      continue;
    if (ts.isVariableDeclarationList(node) && (node.flags & ts.NodeFlags.BlockScoped) === 0) {
      const names: Array<[string, ts.Node]> = [];
      for (const decl of node.declarations.nodes) collectBindingNames(decl.name, names);
      for (const [name] of names) into.add(name);
    }
    ts.forEachChild(node, (child) => {
      stack.push(child);
      return undefined;
    });
  }
}

/** `async function` and `function*` are Annex B's allowance never — only the
 * plain form is. */
function isEnhancedFunction(decl: ts.FunctionDeclaration): boolean {
  if (decl.asteriskToken !== undefined) return true;
  return (ts.getCombinedModifierFlags(decl) & ts.ModifierFlags.Async) !== 0;
}

/* ── SC0007: a declaration where the grammar admits only a Statement ─────
 *
 * Every `Statement` slot below admits Statement productions only, and only
 * Annex B widens three of them to a plain FunctionDeclaration in non-strict
 * code: the body of an `if`/`else` and a labelled statement. Async functions,
 * generators, classes and lexical declarations are never admitted, and a
 * LABELLED function is never admitted as an if/else body (`IsLabelledFunction`
 * is an explicit early error there, so `if (x) l: function f(){}` fails even
 * in sloppy code). */
type StatementSlot = "if" | "loop" | "with" | "label";

function checkStatementSlot(node: ts.Node, diags: ScrDiagnostic[], isStrict: IsStrictCode): void {
  if (ts.isIfStatement(node)) {
    checkStatementPosition(node.thenStatement, "if", diags, isStrict);
    if (node.elseStatement !== undefined)
      checkStatementPosition(node.elseStatement, "if", diags, isStrict);
    return;
  }
  if (
    ts.isWhileStatement(node) ||
    ts.isDoStatement(node) ||
    ts.isForStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isForOfStatement(node)
  ) {
    checkStatementPosition(node.statement, "loop", diags, isStrict);
    return;
  }
  if (ts.isWithStatement(node)) {
    checkStatementPosition(node.statement, "with", diags, isStrict);
    return;
  }
  if (ts.isLabeledStatement(node)) checkStatementPosition(node.statement, "label", diags, isStrict);
}

function checkStatementPosition(
  stmt: ts.Statement,
  slot: StatementSlot,
  diags: ScrDiagnostic[],
  isStrict: IsStrictCode,
): void {
  const sf = ts.getSourceFileOfNode(stmt);
  // A labelled function is an early error as an if-clause, loop, or 'with'
  // body in BOTH modes (Node agrees); only a plain labelled STATEMENT is
  // Annex B's, and that is the `slot === "label"` case, whose terminal
  // function the function branches below handle.
  const labelTerminal =
    slot === "label" || !ts.isLabeledStatement(stmt) ? null : labelledFunctionOf(stmt);
  if (labelTerminal !== null) {
    report(
      diags,
      NOT_A_STATEMENT,
      labelTerminal,
      "a labelled function declaration cannot be the body of a loop, a 'with' statement, or an 'if' clause",
    );
    return;
  }
  if (ts.isVariableStatement(stmt)) {
    if ((stmt.declarationList.flags & ts.NodeFlags.BlockScoped) !== 0)
      report(
        diags,
        NOT_A_STATEMENT,
        stmt,
        "a lexical declaration cannot appear in a single-statement position",
      );
    return;
  }
  if (ts.isClassDeclaration(stmt)) {
    report(
      diags,
      NOT_A_STATEMENT,
      stmt,
      "a class declaration cannot appear in a single-statement position",
    );
    return;
  }
  if (!ts.isFunctionDeclaration(stmt)) return;
  if (isEnhancedFunction(stmt)) {
    report(
      diags,
      NOT_A_STATEMENT,
      stmt,
      "an async function or generator declaration can only appear at the top level or inside a block",
    );
    return;
  }
  // A plain function declaration: Annex B admits it as an if/else body and as
  // a labelled statement, in non-strict code only, and never as a loop's or a
  // 'with' statement's body.
  if (slot === "loop" || slot === "with") {
    report(
      diags,
      NOT_A_STATEMENT,
      stmt,
      "a function declaration can only appear at the top level, inside a block, or as the body of an if statement",
    );
    return;
  }
  if (isStrict(sf, stmt))
    report(
      diags,
      NOT_A_STATEMENT,
      stmt,
      "strict mode code may not declare a function in a single-statement position",
    );
}

/** The function declaration at the end of a `label:` chain, when `stmt` is a
 * labelled statement around one. */
function labelledFunctionOf(stmt: ts.Statement): ts.FunctionDeclaration | null {
  let cur: ts.Statement = stmt;
  while (ts.isLabeledStatement(cur)) cur = cur.statement;
  return ts.isFunctionDeclaration(cur) ? cur : null;
}

/* ── strictness of the code around a node ───────────────────────────────
 *
 * A directive prologue's "use strict" applies to the function (or script) it
 * opens, an arrow function's block body included, and every part of a class is strict by
 * construction. Object literal methods and accessors are ordinary functions:
 * strict only by their own prologue or their surroundings. Module sources are
 * strict whether they say so or not, and Node's classification — not the
 * checker's forced external-module scope — decides which sources are modules.
 *
 * The walk starts at the node's parent: a function declaration's own "use
 * strict" makes its body strict, not the code that declares it. */
function isStrictCode(
  sf: ts.SourceFile,
  node: ts.Node,
  isModuleCode: (sf: ts.SourceFile) => boolean,
): boolean {
  if (isModuleCode(sf)) return true;
  for (let n: ts.Node | undefined = node.parent; n !== undefined; n = n.parent) {
    if (ts.isSourceFile(n)) return hasUseStrictPrologue(n.statements.nodes);
    if (ts.isClassDeclaration(n) || ts.isClassExpression(n)) return true;
    if (ts.isFunctionLike(n)) {
      const body = n.body;
      if (body !== undefined && ts.isBlock(body) && hasUseStrictPrologue(body.statements.nodes))
        return true;
    }
  }
  return false;
}

function hasUseStrictPrologue(statements: readonly ts.Statement[]): boolean {
  for (const stmt of statements) {
    if (!ts.isExpressionStatement(stmt)) return false;
    const expr = stmt.expression;
    if (!ts.isStringLiteral(expr)) return false;
    if (expr.text === "use strict") return true;
  }
  return false;
}

/* ── SC0008: ContainsArguments over a class field initializer ────────────
 *
 *   ClassElement : FieldDefinition ;
 *     It is a Syntax Error if ContainsArguments of Initializer is true.
 *   ClassStaticBlockBody : StatementList
 *     It is a Syntax Error if ContainsArguments of StatementList is true.
 *
 * ContainsArguments is a plain reference to `arguments` anywhere in the
 * initializer. An ARROW function has no `arguments` binding of its own, so
 * its body is searched too; every other function form (function expression,
 * method, accessor, constructor) binds its own and ends the search, which is
 * exactly Node's split:
 *
 *   class C { x = () => arguments }              // SyntaxError
 *   class C { x = function () { return arguments } }  // legal
 *
 * A nested class is searched: its own fields and static block carry the same
 * rule, and its methods are function bodies. */
function checkContainsArguments(node: ts.Node, diags: ScrDiagnostic[]): void {
  let root: ts.Node | undefined;
  if (ts.isPropertyDeclaration(node)) root = node.initializer;
  else if (ts.isClassStaticBlockDeclaration(node)) root = node.body;
  if (root === undefined) return;
  const reference = argumentsReferenceIn(root);
  if (reference === null) return;
  report(
    diags,
    CONTAINS_ARGUMENTS,
    reference,
    "'arguments' cannot be referenced from a class field initializer or a static block",
  );
}

/** The first `arguments` identifier reference below `root`, stopping at
 * every non-arrow function boundary (inclusive of a root that is one). */
function argumentsReferenceIn(root: ts.Node): ts.Identifier | null {
  const stack: ts.Node[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (ts.isIdentifier(node) && node.text === "arguments" && isArgumentsReference(node))
      return node;
    if (ts.isFunctionLike(node) && !ts.isArrowFunction(node)) continue;
    ts.forEachChild(node, (child) => {
      stack.push(child);
      return undefined;
    });
  }
  return null;
}

/** Whether an identifier spelled `arguments` reads a binding rather than
 * naming something: property and member names, declarations and labels are
 * not references. */
function isArgumentsReference(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (parent === undefined) return true;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
  if (ts.isPropertyAssignment(parent) && parent.name === node) return false;
  if (ts.isPropertyDeclaration(parent) && parent.name === node) return false;
  if (ts.isMethodDeclaration(parent) && parent.name === node) return false;
  if (ts.isVariableDeclaration(parent) && parent.name === node) return false;
  if (ts.isParameter(parent) && parent.name === node) return false;
  if (ts.isBindingElement(parent) && parent.name === node) return false;
  // `const { arguments: a } = src` NAMES the property `arguments`; it reads
  // no binding, so only a shorthand binding (`const { arguments } = src`)
  // reaches the rule above.
  if (ts.isBindingElement(parent) && parent.propertyName === node) return false;
  // `get arguments() {}` and `set arguments(v) {}` name an accessor.
  if (
    (ts.isGetAccessorDeclaration(parent) || ts.isSetAccessorDeclaration(parent)) &&
    parent.name === node
  )
    return false;
  if (ts.isFunctionDeclaration(parent) && parent.name === node) return false;
  if (ts.isFunctionExpression(parent) && parent.name === node) return false;
  if (ts.isClassDeclaration(parent) && parent.name === node) return false;
  if (ts.isClassExpression(parent) && parent.name === node) return false;
  if (ts.isLabeledStatement(parent) && parent.label === node) return false;
  if (ts.isBreakOrContinueStatement(parent) && parent.label === node) return false;
  return true;
}
