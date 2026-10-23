import * as ts from "../ts7/adapter.js";

/** Proves that an indexed store `xs[i] = v` writes inside the array, so it
 * cannot leave holes before index `i`. A store at an index below the
 * length overwrites an existing slot.
 *
 * The proof is syntactic: a guard that dominates the store shows `i` is
 * below `xs.length`, either a condition `i < xs.length` (`xs.length > i`)
 * of an enclosing `if` or loop, or, where asserted reads throw for a
 * missing index (BoundsFacts.assertedReadsThrow), an earlier asserted read
 * `xs[i]!`. Between the guard and the store nothing may
 * change the length or either operand: no call, construction, `await`,
 * `yield` or `delete`, and no write of `xs`, `i` or `xs.length`. A loop
 * crossed on the way repeats its whole body between the two. */
export function indexStoreInBounds(store: ts.BinaryExpression, facts: BoundsFacts = {}): boolean {
  if (store.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return false;
  const target = peel(store.left);
  if (!ts.isElementAccessExpression(target)) return false;
  const array = peel(target.expression);
  const index = peel(target.argumentExpression);
  if (!isSimpleReference(array) || !(isSimpleReference(index) || ts.isNumericLiteral(index)))
    return false;
  const parent = store.parent;
  if (!parent || !ts.isExpressionStatement(parent)) return false;
  return boundedBefore(parent, { array, index, facts }, [store.right]);
}

/** Facts about the program that a purely syntactic guard cannot see. */
export interface BoundsFacts {
  /** `other` always has the same length as `array` (for example, two
   * fixed-length typed arrays allocated with the same length), so a guard
   * `i < other.length` bounds `array[i]` as well. */
  sameLength?(array: ts.Expression, other: ts.Expression): boolean;
  /** `bound` always holds `array.length` (for example, a `const` copy of
   * the length of a typed array whose binding is never reassigned), so a
   * guard `i < bound` bounds `array[i]`. */
  lengthAlias?(bound: ts.Expression, array: ts.Expression): boolean;
  /** An asserted read `xs[i]!` throws for a missing index (an ordinary
   * array's bounds trap in a library build), so it bounds later accesses
   * of `xs[i]`. Elsewhere `xs[i]!` reads like `xs[i]`. */
  assertedReadsThrow?: boolean;
  /** `callee` names the standard `Object.hasOwn`. */
  isHasOwn?(callee: ts.Expression): boolean;
  /** A read inside an `if` condition is bounded like one in a statement.
   * Opt-in: a caller that does not also prove the index a non-negative
   * integer keeps its established decision for such reads. */
  conditions?: boolean;
}

/** Proves that an element read `xs[i]` (typically `xs[i]!` forwarded to a
 * call) names an index below the length, by the same dominating guards as
 * indexStoreInBounds. Everything the enclosing statement evaluates before
 * the read (a callee, earlier arguments, a left operand) joins the code
 * that must leave the operands unchanged. The proof says nothing about the
 * sign or integrality of the index. */
export function indexReadInBounds(
  read: ts.ElementAccessExpression,
  facts: BoundsFacts = {},
): boolean {
  return readGuarded(read, facts, "length");
}

/** Proves that an element read `xs[i]` names an own element of the array:
 * a dominating `Object.hasOwn(xs, i)` (BoundsFacts.isHasOwn) holds, so the
 * index is below the length and its slot is no hole. Nothing between the
 * guard and the read may change the operands, as for indexReadInBounds. */
export function indexReadOwned(read: ts.ElementAccessExpression, facts: BoundsFacts): boolean {
  return facts.isHasOwn !== undefined && readGuarded(read, facts, "own");
}

function readGuarded(
  read: ts.ElementAccessExpression,
  facts: BoundsFacts,
  guard: "length" | "own",
): boolean {
  if (read.questionDotToken) return false;
  const array = peel(read.expression);
  const index = peel(read.argumentExpression);
  if (!isSimpleReference(array) || !(isSimpleReference(index) || ts.isNumericLiteral(index)))
    return false;
  const before: ts.Node[] = [];
  let child: ts.Node = read;
  let parent: ts.Node | undefined = read.parent;
  while (parent) {
    if (
      ts.isParenthesizedExpression(parent) ||
      ts.isNonNullExpression(parent) ||
      ts.isAsExpression(parent) ||
      ts.isSatisfiesExpression(parent)
    ) {
      // A value-preserving wrapper.
    } else if (ts.isCallExpression(parent) || ts.isNewExpression(parent)) {
      const args = parent.arguments?.nodes ?? [];
      const at = args.indexOf(child as ts.Expression);
      if (at < 0 || (ts.isCallExpression(parent) && parent.questionDotToken)) return false;
      before.push(parent.expression, ...args.slice(0, at));
    } else if (ts.isBinaryExpression(parent)) {
      const op = parent.operatorToken.kind;
      if (op >= ts.SyntaxKind.FirstAssignment && op <= ts.SyntaxKind.LastAssignment) {
        if (parent.right !== child || !ts.isIdentifier(parent.left)) return false;
      } else if (parent.right === child) before.push(parent.left);
    } else if (ts.isConditionalExpression(parent)) {
      // `cond ? xs[i] : other`: the true branch runs right after a
      // condition that holds.
      if (parent.condition !== child) {
        if (
          parent.whenTrue === child &&
          boundedBy(parent.condition, { array, index, facts, guard }) &&
          unchanged([parent.condition, ...before], { array, index, facts, guard })
        )
          return true;
        before.push(parent.condition);
      }
    } else if (
      ts.isVariableDeclaration(parent) &&
      parent.initializer === child &&
      ts.isVariableDeclarationList(parent.parent) &&
      parent.parent.declarations.nodes[0] === parent &&
      ts.isVariableStatement(parent.parent.parent)
    ) {
      return boundedBefore(parent.parent.parent, { array, index, facts, guard }, before);
    } else if (
      (ts.isExpressionStatement(parent) ||
        ts.isReturnStatement(parent) ||
        (facts.conditions === true && ts.isIfStatement(parent))) &&
      parent.expression === child
    ) {
      // An `if` condition runs before its branches, like a statement.
      return boundedBefore(parent, { array, index, facts, guard }, before);
    } else return false;
    child = parent;
    parent = parent.parent;
  }
  return false;
}

/** A guard dominating `statement` bounds the index, and nothing between the
 * guard and the access (`between`, plus the statements and conditions
 * crossed) can change the operands. */
function boundedBefore(statement: ts.Statement, operands: Operands, start: ts.Node[]): boolean {
  const between = [...start];
  let child: ts.Node = statement;
  let parent: ts.Node | undefined = statement.parent;
  while (parent && !isFunctionBoundary(parent)) {
    if (isStatementList(parent)) {
      const statements = (parent as { statements: ts.NodeArray<ts.Statement> }).statements.nodes;
      const at = statements.indexOf(child as ts.Statement);
      for (let i = at - 1; i >= 0; i--) {
        const statement = statements[i]!;
        if (assertsSlot(statement, operands) && unchanged([statement, ...between], operands))
          return true;
        between.push(statement);
      }
    } else if (ts.isIfStatement(parent)) {
      if (
        child === parent.thenStatement &&
        (assertsSlot(parent.expression, operands) || boundedBy(parent.expression, operands)) &&
        unchanged([parent.expression, ...between], operands)
      )
        return true;
      between.push(parent.expression);
    } else if (
      ts.isWhileStatement(parent) ||
      ts.isForStatement(parent) ||
      ts.isDoStatement(parent) ||
      ts.isForOfStatement(parent) ||
      ts.isForInStatement(parent)
    ) {
      const condition =
        ts.isWhileStatement(parent) || ts.isDoStatement(parent)
          ? parent.expression
          : ts.isForStatement(parent)
            ? parent.condition
            : undefined;
      // The condition runs right before each pass over the body.
      if (
        !ts.isDoStatement(parent) &&
        child === parent.statement &&
        condition !== undefined &&
        boundedBy(condition, operands) &&
        unchanged([condition, ...between], operands)
      )
        return true;
      between.push(parent);
    } else if (ts.isSwitchStatement(parent)) {
      between.push(parent.expression);
    } else if (!ts.isBlock(parent) && !ts.isLabeledStatement(parent) && !ts.isCaseBlock(parent)) {
      return false;
    }
    child = parent;
    parent = parent.parent;
  }
  return false;
}

interface Operands {
  array: ts.Expression;
  index: ts.Expression;
  facts?: BoundsFacts;
  /** The guards that count: length comparisons (and asserted reads, where
   * they throw), or `Object.hasOwn(array, index)` alone. */
  guard?: "length" | "own";
}

function isFunctionBoundary(node: ts.Node): boolean {
  return (
    ts.isFunctionLike(node) ||
    ts.isSourceFile(node) ||
    ts.isClassStaticBlockDeclaration(node) ||
    ts.isTryStatement(node) ||
    ts.isCatchClause(node)
  );
}

function isStatementList(node: ts.Node): boolean {
  return ts.isBlock(node) || ts.isCaseClause(node) || ts.isDefaultClause(node);
}

function peel(node: ts.Expression): ts.Expression {
  let e = node;
  while (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e)) e = e.expression;
  return e;
}

/** An identifier, `this`, or a property chain over one. */
function isSimpleReference(node: ts.Expression): boolean {
  const e = peel(node);
  if (ts.isIdentifier(e) || e.kind === ts.SyntaxKind.ThisKeyword) return true;
  return ts.isPropertyAccessExpression(e) && !e.questionDotToken && isSimpleReference(e.expression);
}

function sameReference(a: ts.Expression, b: ts.Expression): boolean {
  const left = peel(a);
  const right = peel(b);
  if (ts.isIdentifier(left) && ts.isIdentifier(right)) return left.text === right.text;
  if (ts.isNumericLiteral(left) && ts.isNumericLiteral(right))
    return Number(left.text) === Number(right.text);
  if (left.kind === ts.SyntaxKind.ThisKeyword && right.kind === ts.SyntaxKind.ThisKeyword)
    return true;
  if (ts.isPropertyAccessExpression(left) && ts.isPropertyAccessExpression(right))
    return left.name.text === right.name.text && sameReference(left.expression, right.expression);
  return false;
}

function isLengthOf(node: ts.Expression, array: ts.Expression, facts?: BoundsFacts): boolean {
  const e = peel(node);
  if (ts.isIdentifier(e)) return facts?.lengthAlias?.(e, array) === true;
  return (
    ts.isPropertyAccessExpression(e) &&
    !e.questionDotToken &&
    e.name.text === "length" &&
    (sameReference(e.expression, array) || facts?.sameLength?.(array, e.expression) === true)
  );
}

/** `condition` holding proves `index < array.length`, or with the "own"
 * guard, that `index` names an own element of `array`. */
function boundedBy(condition: ts.Expression, operands: Operands): boolean {
  const { array, index, facts } = operands;
  const e = peel(condition);
  if (operands.guard === "own") {
    if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken)
      return boundedBy(e.left, operands) || boundedBy(e.right, operands);
    return isOwnCheck(e, operands);
  }
  if (!ts.isBinaryExpression(e)) return false;
  const op = e.operatorToken.kind;
  if (op === ts.SyntaxKind.AmpersandAmpersandToken)
    return boundedBy(e.left, operands) || boundedBy(e.right, operands);
  if (op === ts.SyntaxKind.LessThanToken)
    return sameReference(e.left, index) && isLengthOf(e.right, array, facts);
  if (op === ts.SyntaxKind.GreaterThanToken)
    return isLengthOf(e.left, array, facts) && sameReference(e.right, index);
  return false;
}

/** Evaluating `node` reads `array[index]!` on every path that completes,
 * where asserted reads throw for a missing index. */
function assertsSlot(node: ts.Node, operands: Operands): boolean {
  if (operands.guard === "own" || operands.facts?.assertedReadsThrow !== true) return false;
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (
      ts.isNonNullExpression(n) &&
      ts.isElementAccessExpression(peel(n.expression)) &&
      !(peel(n.expression) as ts.ElementAccessExpression).questionDotToken
    ) {
      const read = peel(n.expression) as ts.ElementAccessExpression;
      if (
        sameReference(read.expression, operands.array) &&
        sameReference(read.argumentExpression, operands.index)
      ) {
        found = true;
        return;
      }
    }
    // Skip operands that do not run on every completing path.
    if (ts.isBinaryExpression(n)) {
      const op = n.operatorToken.kind;
      visit(n.left);
      if (
        op !== ts.SyntaxKind.AmpersandAmpersandToken &&
        op !== ts.SyntaxKind.BarBarToken &&
        op !== ts.SyntaxKind.QuestionQuestionToken &&
        op !== ts.SyntaxKind.AmpersandAmpersandEqualsToken &&
        op !== ts.SyntaxKind.BarBarEqualsToken &&
        op !== ts.SyntaxKind.QuestionQuestionEqualsToken
      )
        visit(n.right);
      return;
    }
    if (ts.isConditionalExpression(n)) {
      visit(n.condition);
      return;
    }
    if (
      ts.isFunctionLike(n) ||
      ts.isClassDeclaration(n) ||
      ts.isClassExpression(n) ||
      ts.isIfStatement(n) ||
      ts.isWhileStatement(n) ||
      ts.isDoStatement(n) ||
      ts.isForStatement(n) ||
      ts.isForOfStatement(n) ||
      ts.isForInStatement(n) ||
      ts.isSwitchStatement(n) ||
      ts.isTryStatement(n) ||
      ts.isLabeledStatement(n) ||
      ts.isBlock(n)
    ) {
      if (ts.isIfStatement(n)) visit(n.expression);
      return;
    }
    if ((n.flags & ts.NodeFlags.OptionalChain) !== 0) return;
    ts.forEachChild(n, visit);
  };
  if (ts.isVariableStatement(node)) {
    for (const declaration of node.declarationList.declarations.nodes)
      if (declaration.initializer) visit(declaration.initializer);
  } else if (ts.isExpressionStatement(node)) visit(node.expression);
  else if (!ts.isStatement(node)) visit(node);
  return found;
}

/** `node` is `Object.hasOwn(array, index)`. */
function isOwnCheck(node: ts.Node, { array, index, facts }: Operands): boolean {
  if (
    !ts.isCallExpression(node) ||
    node.questionDotToken ||
    facts?.isHasOwn?.(node.expression) !== true
  )
    return false;
  const args = node.arguments.nodes;
  return args.length === 2 && sameReference(args[0]!, array) && sameReference(args[1]!, index);
}

/** Running `nodes` cannot change the array's length or either operand. */
function unchanged(nodes: readonly ts.Node[], operands: Operands): boolean {
  const { array, index } = operands;
  const roots: string[] = [];
  for (const operand of [array, index]) {
    const root = rootName(operand);
    if (root !== null) roots.push(root);
  }
  // Another reference can alias a property chain, so any property write
  // named `length` or like a link of either chain may change an operand.
  const links = new Set(["length", ...linkNames(array), ...linkNames(index)]);
  let ok = true;
  const writes = (target: ts.Expression): boolean => {
    const e = peel(target);
    if (ts.isIdentifier(e)) return roots.includes(e.text);
    if (ts.isPropertyAccessExpression(e)) return links.has(e.name.text);
    if (ts.isElementAccessExpression(e)) {
      // A computed key could name `length` or a chain link.
      const key = peel(e.argumentExpression);
      return !ts.isNumericLiteral(key) && !isSimpleReference(key)
        ? true
        : ts.isStringLiteral(key) && links.has(key.text);
    }
    if (ts.isArrayLiteralExpression(e) || ts.isObjectLiteralExpression(e)) {
      let hit = false;
      const walk = (n: ts.Node): void => {
        if (ts.isIdentifier(n) && roots.includes(n.text)) hit = true;
        ts.forEachChild(n, walk);
      };
      walk(e);
      return hit;
    }
    return false;
  };
  const visit = (n: ts.Node): void => {
    if (!ok) return;
    if (ts.isFunctionLike(n) || ts.isClassDeclaration(n) || ts.isClassExpression(n)) return;
    // The own-element check only reads its operands.
    if (isOwnCheck(n, operands)) return;
    if (
      ts.isCallExpression(n) ||
      ts.isNewExpression(n) ||
      ts.isTaggedTemplateExpression(n) ||
      ts.isAwaitExpression(n) ||
      ts.isYieldExpression(n) ||
      ts.isDeleteExpression(n)
    ) {
      ok = false;
      return;
    }
    if (ts.isBinaryExpression(n)) {
      const op = n.operatorToken.kind;
      if (
        op >= ts.SyntaxKind.FirstAssignment &&
        op <= ts.SyntaxKind.LastAssignment &&
        writes(n.left)
      ) {
        ok = false;
        return;
      }
    }
    if (
      (ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) &&
      (n.operator === ts.SyntaxKind.PlusPlusToken ||
        n.operator === ts.SyntaxKind.MinusMinusToken) &&
      writes(n.operand as ts.Expression)
    ) {
      ok = false;
      return;
    }
    if (
      (ts.isForOfStatement(n) || ts.isForInStatement(n)) &&
      !ts.isVariableDeclarationList(n.initializer) &&
      writes(n.initializer as ts.Expression)
    ) {
      ok = false;
      return;
    }
    ts.forEachChild(n, visit);
  };
  for (const node of nodes) visit(node);
  return ok;
}

function linkNames(node: ts.Expression): string[] {
  const names: string[] = [];
  let e = peel(node);
  while (ts.isPropertyAccessExpression(e)) {
    names.push(e.name.text);
    e = peel(e.expression);
  }
  return names;
}

function rootName(node: ts.Expression): string | null {
  let e = peel(node);
  while (ts.isPropertyAccessExpression(e)) e = peel(e.expression);
  return ts.isIdentifier(e) ? e.text : null;
}
