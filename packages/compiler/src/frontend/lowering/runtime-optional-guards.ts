import * as ts from "../ts7/adapter.js";

/** Every binding written after its declaration: plain, compound and
 * destructuring assignments, `++`/`--`, for-in/for-of targets, a redeclared
 * `var` with a second initializer, and, in sloppy-mode JavaScript, the
 * parameters of a function that reads `arguments`, which aliases them. */
export function reassignedBindings(
  files: readonly ts.SourceFile[],
  symbolOf: (node: ts.Node) => ts.Symbol | null,
  isJavaScript: (file: ts.SourceFile) => boolean,
): Set<ts.Symbol> {
  const reassigned = new Set<ts.Symbol>();
  const initialized = new Set<ts.Symbol>();
  const mark = (node: ts.Node): void => {
    const symbol = symbolOf(node);
    if (symbol) reassigned.add(symbol);
  };
  const markTarget = (target: ts.Expression): void => {
    const e = peel(target);
    if (ts.isIdentifier(e)) mark(e);
    else if (ts.isArrayLiteralExpression(e) || ts.isObjectLiteralExpression(e)) {
      const walk = (n: ts.Node): void => {
        if (ts.isIdentifier(n)) mark(n);
        else n.forEachChild(walk);
      };
      walk(e);
    }
  };
  for (const file of files) {
    const js = isJavaScript(file);
    ts.walkPreorder(file, (node) => {
      if (ts.isBinaryExpression(node)) {
        const op = node.operatorToken.kind;
        if (op >= ts.SyntaxKind.FirstAssignment && op <= ts.SyntaxKind.LastAssignment)
          markTarget(node.left);
      } else if (
        (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
        (node.operator === ts.SyntaxKind.PlusPlusToken ||
          node.operator === ts.SyntaxKind.MinusMinusToken)
      ) {
        markTarget(node.operand as ts.Expression);
      } else if (
        (ts.isForOfStatement(node) || ts.isForInStatement(node)) &&
        !ts.isVariableDeclarationList(node.initializer)
      ) {
        markTarget(node.initializer as ts.Expression);
      } else if (ts.isVariableDeclaration(node) && node.initializer) {
        for (const bound of boundNames(node.name)) {
          const symbol = symbolOf(bound);
          if (!symbol) continue;
          if (initialized.has(symbol)) reassigned.add(symbol);
          initialized.add(symbol);
        }
      } else if (js && ts.isIdentifier(node) && node.text === "arguments") {
        for (let owner = node.parent; owner; owner = owner.parent) {
          if (!ts.isFunctionLike(owner) || ts.isArrowFunction(owner)) continue;
          for (const parameter of owner.parameters)
            for (const bound of boundNames(parameter.name)) mark(bound);
          break;
        }
      }
      return undefined;
    });
  }
  return reassigned;
}

function boundNames(name: ts.BindingName): ts.Identifier[] {
  if (ts.isIdentifier(name)) return [name];
  const names: ts.Identifier[] = [];
  for (const element of name.elements)
    if (!ts.isOmittedExpression(element) && element.name) names.push(...boundNames(element.name));
  return names;
}

/** Resolves the identifiers a presence proof compares against. */
export interface PresenceBindings {
  /** The identifier names the binding whose use is being proven. */
  sameBinding(node: ts.Identifier): boolean;
  /** The identifier is the global `undefined` value. */
  isUndefined(node: ts.Identifier): boolean;
}

/** Proves that a read of a never-reassigned binding cannot observe
 * `undefined` because JavaScript control flow already rejected that value
 * before the read runs: an enclosing branch or short-circuit operand tested
 * the binding (`x !== undefined`, `x != null`, truthiness, `typeof`,
 * `instanceof`, a comparison with a literal), an earlier statement in an
 * enclosing statement list leaves only when the binding is absent
 * (`if (x === undefined) return;`), or an earlier unconditional member
 * access on the binding would already have thrown.
 *
 * The caller guarantees the binding has a single assignment (its
 * declaration or parameter binding), so a proof made anywhere on the path
 * from the binding's scope to the read stays valid inside nested closures
 * created after it. A hoisted function declaration may run before earlier
 * statements of its block, so statement-order proofs never cross one. */
export function presentAtUse(use: ts.Identifier, bindings: PresenceBindings): boolean {
  let child: ts.Node = use;
  let parent: ts.Node | undefined = use.parent;
  while (parent) {
    if (ts.isIfStatement(parent)) {
      if (child === parent.thenStatement && implies(parent.expression, true, bindings)) return true;
      if (child === parent.elseStatement && implies(parent.expression, false, bindings))
        return true;
    } else if (ts.isConditionalExpression(parent)) {
      if (child === parent.whenTrue && implies(parent.condition, true, bindings)) return true;
      if (child === parent.whenFalse && implies(parent.condition, false, bindings)) return true;
    } else if (ts.isBinaryExpression(parent) && child === parent.right) {
      const op = parent.operatorToken.kind;
      if (
        (op === ts.SyntaxKind.AmpersandAmpersandToken ||
          op === ts.SyntaxKind.AmpersandAmpersandEqualsToken) &&
        implies(parent.left, true, bindings)
      )
        return true;
      if (
        (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.BarBarEqualsToken) &&
        implies(parent.left, false, bindings)
      )
        return true;
      // Other non-assignment operators evaluate their left operand first
      // and unconditionally: a member access there already threw for
      // absence. An assignment target's member write happens only after
      // its right operand ran, so it proves nothing for that operand.
      if (
        op !== ts.SyntaxKind.QuestionQuestionToken &&
        (op < ts.SyntaxKind.FirstAssignment || op > ts.SyntaxKind.LastAssignment) &&
        dereferences(parent.left, bindings)
      )
        return true;
    } else if (
      (ts.isWhileStatement(parent) || ts.isForStatement(parent)) &&
      child === parent.statement
    ) {
      const condition = ts.isWhileStatement(parent) ? parent.expression : parent.condition;
      if (condition && implies(condition, true, bindings)) return true;
    } else if (ts.isCallExpression(parent) || ts.isNewExpression(parent)) {
      // Arguments evaluate after the callee and earlier arguments.
      const args = parent.arguments ?? [];
      const index = args.indexOf(child as ts.Expression);
      if (index >= 0 && !isOptionalChainMember(parent)) {
        if (dereferences(parent.expression, bindings)) return true;
        for (let i = 0; i < index; i++) if (dereferences(args[i]!, bindings)) return true;
      }
    }
    if (isStatementList(parent) && !ts.isFunctionDeclaration(child)) {
      const statements = (parent as { statements: ts.NodeArray<ts.Statement> }).statements;
      const index = statements.indexOf(child as ts.Statement);
      for (let i = index - 1; i >= 0; i--) {
        if (statementProvesPresence(statements[i]!, bindings)) return true;
      }
    }
    child = parent;
    parent = parent.parent;
  }
  return false;
}

function isStatementList(node: ts.Node): boolean {
  return (
    ts.isBlock(node) ||
    ts.isSourceFile(node) ||
    ts.isModuleBlock(node) ||
    ts.isCaseClause(node) ||
    ts.isDefaultClause(node)
  );
}

function peel(node: ts.Expression): ts.Expression {
  let e = node;
  while (
    ts.isParenthesizedExpression(e) ||
    ts.isAsExpression(e) ||
    ts.isTypeAssertion(e) ||
    ts.isSatisfiesExpression(e) ||
    ts.isNonNullExpression(e)
  )
    e = e.expression;
  return e;
}

function isBinding(node: ts.Expression, bindings: PresenceBindings): boolean {
  const e = peel(node);
  return ts.isIdentifier(e) && bindings.sameBinding(e);
}

function isAbsentValue(
  node: ts.Expression,
  bindings: PresenceBindings,
): "undefined" | "null" | null {
  const e = peel(node);
  if (ts.isIdentifier(e) && bindings.isUndefined(e)) return "undefined";
  if (ts.isVoidExpression(e)) return "undefined";
  if (e.kind === ts.SyntaxKind.NullKeyword) return "null";
  return null;
}

/** A literal that is never `undefined` and never loosely equal to it. */
function isPresentLiteral(node: ts.Expression): boolean {
  const e = peel(node);
  return (
    ts.isStringLiteral(e) ||
    ts.isNumericLiteral(e) ||
    ts.isBigIntLiteral(e) ||
    ts.isNoSubstitutionTemplateLiteral(e) ||
    e.kind === ts.SyntaxKind.TrueKeyword ||
    e.kind === ts.SyntaxKind.FalseKeyword ||
    (ts.isPrefixUnaryExpression(e) &&
      e.operator === ts.SyntaxKind.MinusToken &&
      ts.isNumericLiteral(e.operand))
  );
}

/** `condition` evaluating to `outcome` proves the binding present. */
export function implies(
  condition: ts.Expression,
  outcome: boolean,
  bindings: PresenceBindings,
): boolean {
  const e = peel(condition);
  if (dereferences(e, bindings)) return true;
  if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.ExclamationToken)
    return implies(e.operand, !outcome, bindings);
  if (ts.isIdentifier(e)) return outcome && bindings.sameBinding(e);
  if (!ts.isBinaryExpression(e)) return false;
  const op = e.operatorToken.kind;
  if (op === ts.SyntaxKind.AmpersandAmpersandToken) {
    return outcome
      ? implies(e.left, true, bindings) || implies(e.right, true, bindings)
      : implies(e.left, false, bindings) && implies(e.right, false, bindings);
  }
  if (op === ts.SyntaxKind.BarBarToken) {
    return outcome
      ? implies(e.left, true, bindings) && implies(e.right, true, bindings)
      : implies(e.left, false, bindings) || implies(e.right, false, bindings);
  }
  if (op === ts.SyntaxKind.InstanceOfKeyword) return outcome && isBinding(e.left, bindings);
  const strictEq = op === ts.SyntaxKind.EqualsEqualsEqualsToken;
  const strictNe = op === ts.SyntaxKind.ExclamationEqualsEqualsToken;
  const looseEq = op === ts.SyntaxKind.EqualsEqualsToken;
  const looseNe = op === ts.SyntaxKind.ExclamationEqualsToken;
  if (!strictEq && !strictNe && !looseEq && !looseNe) return false;
  // `equal` is the outcome under which both operands compare equal.
  const equal = strictEq || looseEq ? outcome : !outcome;
  for (const [side, other] of [
    [e.left, e.right],
    [e.right, e.left],
  ] as const) {
    const typeofOperand = peel(side);
    if (
      ts.isTypeOfExpression(typeofOperand) &&
      isBinding(typeofOperand.expression, bindings) &&
      ts.isStringLiteral(peel(other))
    ) {
      const tag = (peel(other) as ts.StringLiteral).text;
      return equal ? tag !== "undefined" : tag === "undefined";
    }
    if (!isBinding(side, bindings)) continue;
    const absent = isAbsentValue(other, bindings);
    if (absent === "undefined") return !equal;
    // Only loose equality treats null and undefined alike.
    if (absent === "null") return !equal && (looseEq || looseNe);
    if (isPresentLiteral(other)) return equal;
  }
  return false;
}

/** After `statement` completes normally, the binding is present. */
function statementProvesPresence(statement: ts.Statement, bindings: PresenceBindings): boolean {
  if (ts.isIfStatement(statement)) {
    if (dereferences(statement.expression, bindings)) return true;
    const thenExits = exitsAbruptly(statement.thenStatement);
    const elseExits = statement.elseStatement ? exitsAbruptly(statement.elseStatement) : false;
    if (thenExits && !elseExits) return implies(statement.expression, false, bindings);
    if (elseExits && !thenExits) return implies(statement.expression, true, bindings);
    return false;
  }
  if (ts.isExpressionStatement(statement)) return dereferences(statement.expression, bindings);
  if (ts.isVariableStatement(statement)) {
    for (const declaration of statement.declarationList.declarations) {
      if (declaration.initializer && dereferences(declaration.initializer, bindings)) return true;
    }
    return false;
  }
  if (ts.isSwitchStatement(statement)) return dereferences(statement.expression, bindings);
  return false;
}

/** The statement never completes normally: its last reachable statement
 * returns, throws, breaks, or continues. */
function exitsAbruptly(statement: ts.Statement): boolean {
  if (
    ts.isReturnStatement(statement) ||
    ts.isThrowStatement(statement) ||
    ts.isBreakStatement(statement) ||
    ts.isContinueStatement(statement)
  )
    return true;
  if (ts.isBlock(statement)) {
    // A labeled statement inside could be the target of an inner break,
    // which resumes after it; only plain trailing exits count.
    const last = statement.statements[statement.statements.length - 1];
    return last !== undefined && exitsAbruptly(last);
  }
  if (ts.isIfStatement(statement))
    return (
      !!statement.elseStatement &&
      exitsAbruptly(statement.thenStatement) &&
      exitsAbruptly(statement.elseStatement)
    );
  return false;
}

function isOptionalChainMember(node: ts.Node): boolean {
  if ((node.flags & ts.NodeFlags.OptionalChain) !== 0) return true;
  return (
    (ts.isPropertyAccessExpression(node) ||
      ts.isElementAccessExpression(node) ||
      ts.isCallExpression(node)) &&
    node.questionDotToken !== undefined
  );
}

/** Evaluating `expression` to completion performs a member access, call or
 * `in` test on the binding itself, which throws for `undefined`. Only
 * operands every evaluation reaches count: short-circuit right operands,
 * conditional branches, optional-chain continuations, and function bodies
 * do not. */
export function dereferences(expression: ts.Expression, bindings: PresenceBindings): boolean {
  const e = ts.isParenthesizedExpression(expression) ? peel(expression) : expression;
  if (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) {
    if (!e.questionDotToken && isBinding(e.expression, bindings)) return true;
    if (dereferences(e.expression, bindings)) return true;
    return (
      ts.isElementAccessExpression(e) &&
      !isOptionalChainMember(e) &&
      dereferences(e.argumentExpression, bindings)
    );
  }
  if (ts.isCallExpression(e)) {
    if (!e.questionDotToken && isBinding(e.expression, bindings)) return true;
    if (dereferences(e.expression, bindings)) return true;
    if (isOptionalChainMember(e)) return false;
    return e.arguments.some((arg) => !ts.isSpreadElement(arg) && dereferences(arg, bindings));
  }
  if (ts.isNewExpression(e)) {
    if (dereferences(e.expression, bindings)) return true;
    return (e.arguments ?? []).some(
      (arg) => !ts.isSpreadElement(arg) && dereferences(arg, bindings),
    );
  }
  if (
    ts.isAsExpression(e) ||
    ts.isTypeAssertion(e) ||
    ts.isSatisfiesExpression(e) ||
    ts.isNonNullExpression(e)
  )
    return dereferences(e.expression, bindings);
  if (ts.isPrefixUnaryExpression(e)) {
    if (e.operator === ts.SyntaxKind.PlusPlusToken || e.operator === ts.SyntaxKind.MinusMinusToken)
      return false;
    return dereferences(e.operand, bindings);
  }
  if (ts.isTypeOfExpression(e) || ts.isVoidExpression(e))
    return dereferences(e.expression, bindings);
  if (ts.isBinaryExpression(e)) {
    const op = e.operatorToken.kind;
    if (op === ts.SyntaxKind.InKeyword && isBinding(e.right, bindings)) return true;
    if (dereferences(e.left, bindings)) return true;
    if (
      op === ts.SyntaxKind.AmpersandAmpersandToken ||
      op === ts.SyntaxKind.BarBarToken ||
      op === ts.SyntaxKind.QuestionQuestionToken ||
      op === ts.SyntaxKind.AmpersandAmpersandEqualsToken ||
      op === ts.SyntaxKind.BarBarEqualsToken ||
      op === ts.SyntaxKind.QuestionQuestionEqualsToken
    )
      return false;
    return dereferences(e.right, bindings);
  }
  if (ts.isConditionalExpression(e)) return dereferences(e.condition, bindings);
  if (ts.isTemplateExpression(e))
    return e.templateSpans.some((span) => dereferences(span.expression, bindings));
  return false;
}
