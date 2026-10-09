import * as ts from "../ts7/adapter.js";
import { isJsSourceFile } from "../program.js";

/* Proves that a string element read `text[i]` names an existing UTF-16 code
 * unit, so the read always yields a one-character string and never
 * undefined. Strings are immutable and have no holes: the read is present
 * exactly when `i` is an integer with `0 <= i < text.length`.
 *
 * The proof is syntactic and local. Both operands must be plain bindings.
 * The index binding is a block-scoped local whose every write keeps it an
 * integer (literals, `x.length`, constant steps). Bounds come from the
 * binding's own writes (a counter that only grows from a non-negative
 * literal, or one that only shrinks from `text.length - k`) or from a guard
 * that dominates the read: a loop or `if` condition, the left side of `&&`
 * or `||`, a conditional, or an earlier `if (...) <exit>` statement.
 *
 * A guard holds at the read only when neither binding can change between
 * them. Every write of either binding must be in the function that declares
 * it, so calls cannot reach one; no write may sit between the guard and the
 * read in source order; and no loop between them may write either binding,
 * since a later iteration would observe it. Reads in a nested function only
 * use guards inside that function. */

type Bound = "upper" | "lower";

interface Write {
  /** Start of the written identifier (or declaration name). */
  at: number;
  /** A constant integer step (`i++`, `i -= 2`), an assigned value, or an
   * untracked write such as destructuring. */
  step: number | null;
  value: ts.Expression | null;
}

interface Binding {
  container: ts.Node;
  declaration: ts.Node;
  writes: Write[];
  /** Some write sits in a function other than the declaring one. */
  escapes: boolean;
  /** No write beyond the declaration's own initializer. */
  constant: boolean;
}

interface IndexFacts {
  integer: boolean;
  nonNegative: boolean;
  /** Always below this string binding's length. */
  belowLengthOf: ts.Symbol | null;
}

const NO_FACTS: IndexFacts = {
  integer: false,
  nonNegative: false,
  belowLengthOf: null,
};

function peel(node: ts.Expression): ts.Expression {
  let e = node;
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  return e;
}

function isBoundary(node: ts.Node): boolean {
  return (
    ts.isSourceFile(node) ||
    ts.isFunctionLike(node) ||
    ts.isClassStaticBlockDeclaration(node) ||
    ts.isPropertyDeclaration(node)
  );
}

function containerOf(node: ts.Node): ts.Node {
  let n = node.parent;
  while (n && !isBoundary(n)) n = n.parent;
  return n ?? node.getSourceFile();
}

function isLoop(node: ts.Node): boolean {
  return (
    ts.isForStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isWhileStatement(node) ||
    ts.isDoStatement(node)
  );
}

function integerLiteral(node: ts.Expression): number | null {
  const e = peel(node);
  if (ts.isNumericLiteral(e)) {
    const value = Number(e.text);
    return Number.isSafeInteger(value) ? value : null;
  }
  if (
    ts.isPrefixUnaryExpression(e) &&
    e.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(e.operand)
  ) {
    const value = Number(e.operand.text);
    return Number.isSafeInteger(value) && value !== 0 ? -value : null;
  }
  return null;
}

/** An always-exiting statement: control never reaches the next sibling. */
function exits(node: ts.Statement): boolean {
  if (
    ts.isReturnStatement(node) ||
    ts.isThrowStatement(node) ||
    ts.isBreakStatement(node) ||
    ts.isContinueStatement(node)
  )
    return true;
  if (ts.isBlock(node)) {
    const last = node.statements[node.statements.length - 1];
    return last !== undefined && exits(last);
  }
  return false;
}

/** The identifier's role when it is written, or null for a read. */
function writeOf(id: ts.Identifier): Write | null {
  let n: ts.Node = id;
  let destructured = false;
  for (;;) {
    const p: ts.Node | undefined = n.parent;
    if (!p) return null;
    if (ts.isBinaryExpression(p)) {
      const k = p.operatorToken.kind;
      if (p.left !== n || k < ts.SyntaxKind.FirstAssignment || k > ts.SyntaxKind.LastAssignment)
        return null;
      const at = id.getStart();
      if (destructured) return { at, step: null, value: null };
      if (k === ts.SyntaxKind.EqualsToken) return { at, step: null, value: p.right };
      const amount = integerLiteral(p.right);
      if (amount !== null && k === ts.SyntaxKind.PlusEqualsToken)
        return { at, step: amount, value: null };
      if (amount !== null && k === ts.SyntaxKind.MinusEqualsToken)
        return { at, step: -amount, value: null };
      return { at, step: null, value: null };
    }
    if (ts.isPostfixUnaryExpression(p) || ts.isPrefixUnaryExpression(p)) {
      if (
        p.operand !== n ||
        (p.operator !== ts.SyntaxKind.PlusPlusToken && p.operator !== ts.SyntaxKind.MinusMinusToken)
      )
        return null;
      if (destructured) return { at: id.getStart(), step: null, value: null };
      return {
        at: id.getStart(),
        step: p.operator === ts.SyntaxKind.PlusPlusToken ? 1 : -1,
        value: null,
      };
    }
    if (ts.isForOfStatement(p) || ts.isForInStatement(p))
      return p.initializer === n ? { at: id.getStart(), step: null, value: null } : null;
    if (ts.isParenthesizedExpression(p)) {
      n = p;
      continue;
    }
    if (
      ts.isArrayLiteralExpression(p) ||
      ts.isSpreadElement(p) ||
      ts.isSpreadAssignment(p) ||
      ts.isShorthandPropertyAssignment(p) ||
      ts.isObjectLiteralExpression(p) ||
      (ts.isPropertyAssignment(p) && p.initializer === n)
    ) {
      destructured = true;
      n = p;
      continue;
    }
    return null;
  }
}

export class StringIndexBounds {
  private readonly proofs = new Map<ts.Node, boolean>();
  private readonly bindings = new Map<ts.Symbol, Binding | null>();
  private readonly indexFacts = new Map<ts.Symbol, IndexFacts>();
  private readonly identifiers = new Map<ts.Node, Map<string, ts.Identifier[]>>();

  constructor(
    private readonly symbolAt: (node: ts.Node) => ts.Symbol | null,
    private readonly declarationOf: (symbol: ts.Symbol) => ts.Node | undefined,
    private readonly isString: (node: ts.Expression) => boolean,
  ) {}

  /** True when `read` (an element access on a string receiver) is proven
   * to name an existing code unit. */
  inBounds(read: ts.ElementAccessExpression): boolean {
    const cached = this.proofs.get(read);
    if (cached !== undefined) return cached;
    const proven = this.prove(read);
    this.proofs.set(read, proven);
    return proven;
  }

  private prove(read: ts.ElementAccessExpression): boolean {
    // JavaScript declarations are not checked against callers.
    if (read.questionDotToken || isJsSourceFile(read.getSourceFile())) return false;
    const textNode = read.expression;
    const indexNode = read.argumentExpression;
    if (!ts.isIdentifier(textNode) || !ts.isIdentifier(indexNode)) return false;
    if (writeOfElement(read)) return false;
    const textSymbol = this.symbolAt(textNode);
    const indexSymbol = this.symbolAt(indexNode);
    if (!textSymbol || !indexSymbol || textSymbol === indexSymbol) return false;
    const container = containerOf(read);
    const text = this.binding(textSymbol);
    if (!text || text.escapes || (!text.constant && text.container !== container)) return false;
    // Sloppy-mode `arguments` aliases parameters.
    if (ts.isParameter(text.declaration) && this.namesIn(text.container).has("arguments"))
      return false;
    const index = this.binding(indexSymbol);
    if (!index || index.escapes || index.container !== container) return false;
    const facts = this.indexFactsOf(indexSymbol, index);
    if (!facts.integer) return false;
    const symbols = [textSymbol, indexSymbol];
    const upper =
      (facts.belowLengthOf === textSymbol && text.constant) ||
      this.guarded(read, "upper", indexSymbol, textSymbol, symbols);
    if (!upper) return false;
    return facts.nonNegative || this.guarded(read, "lower", indexSymbol, textSymbol, symbols);
  }

  private namesIn(container: ts.Node): Map<string, ts.Identifier[]> {
    let names = this.identifiers.get(container);
    if (names) return names;
    names = new Map();
    const found = names;
    ts.walkPreorder(container, (node) => {
      if (!ts.isIdentifier(node)) return;
      const list = found.get(node.text);
      if (list) list.push(node);
      else found.set(node.text, [node]);
    });
    this.identifiers.set(container, names);
    return names;
  }

  /** Every write of a block-scoped local or parameter, or null for any
   * other binding (module imports, var, class members, ...). */
  private binding(symbol: ts.Symbol): Binding | null {
    if (this.bindings.has(symbol)) return this.bindings.get(symbol)!;
    const result = this.scanBinding(symbol);
    this.bindings.set(symbol, result);
    return result;
  }

  private scanBinding(symbol: ts.Symbol): Binding | null {
    const declaration = this.declarationOf(symbol);
    if (!declaration) return null;
    let nameNode: ts.Node;
    const writes: Write[] = [];
    if (ts.isVariableDeclaration(declaration)) {
      const list = declaration.parent;
      if (
        !ts.isIdentifier(declaration.name) ||
        !ts.isVariableDeclarationList(list) ||
        !(list.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const))
      )
        return null;
      nameNode = declaration.name;
      if (ts.isForOfStatement(list.parent) || ts.isForInStatement(list.parent)) {
        // Each iteration binds a fresh constant; a `let` element may change.
        if (!(list.flags & ts.NodeFlags.Const)) return null;
      } else if (declaration.initializer) {
        writes.push({
          at: declaration.name.getStart(),
          step: null,
          value: declaration.initializer,
        });
      } else return null;
    } else if (ts.isParameter(declaration)) {
      if (!ts.isIdentifier(declaration.name) || declaration.dotDotDotToken) return null;
      nameNode = declaration.name;
    } else return null;
    const container = containerOf(declaration);
    let escapes = false;
    let assigned = 0;
    for (const id of this.namesIn(container).get(symbol.name) ?? []) {
      if (id === nameNode) continue;
      const write = writeOf(id);
      if (!write) continue;
      // A destructuring or loop target may name the binding through a
      // shorthand property; count any same-named target conservatively.
      if (write.step === null && write.value === null) {
        writes.push(write);
        assigned++;
        if (containerOf(id) !== container) escapes = true;
        continue;
      }
      if (this.symbolAt(id) !== symbol) continue;
      writes.push(write);
      assigned++;
      if (containerOf(id) !== container) escapes = true;
    }
    return {
      container,
      declaration,
      writes,
      escapes,
      constant: assigned === 0,
    };
  }

  private valueFacts(value: ts.Expression): IndexFacts {
    const literal = integerLiteral(value);
    if (literal !== null) return { integer: true, nonNegative: literal >= 0, belowLengthOf: null };
    const e = peel(value);
    if (this.lengthOf(e)) return { integer: true, nonNegative: true, belowLengthOf: null };
    if (
      ts.isBinaryExpression(e) &&
      (e.operatorToken.kind === ts.SyntaxKind.MinusToken ||
        e.operatorToken.kind === ts.SyntaxKind.PlusToken)
    ) {
      const of = this.lengthOf(peel(e.left));
      const amount = integerLiteral(e.right);
      if (of && amount !== null) {
        const delta = e.operatorToken.kind === ts.SyntaxKind.PlusToken ? amount : -amount;
        return {
          integer: true,
          nonNegative: delta >= 0,
          belowLengthOf: delta <= -1 ? of : null,
        };
      }
    }
    return NO_FACTS;
  }

  /** `text.length` on a string binding: its symbol, else null. */
  private lengthOf(e: ts.Expression): ts.Symbol | null {
    if (
      !ts.isPropertyAccessExpression(e) ||
      e.questionDotToken ||
      e.name.text !== "length" ||
      !ts.isIdentifier(e.expression) ||
      !this.isString(e.expression)
    )
      return null;
    return this.symbolAt(e.expression);
  }

  private indexFactsOf(symbol: ts.Symbol, binding: Binding): IndexFacts {
    const cached = this.indexFacts.get(symbol);
    if (cached) return cached;
    let facts: IndexFacts = NO_FACTS;
    if (ts.isVariableDeclaration(binding.declaration)) {
      const [initial, ...rest] = binding.writes;
      facts = initial?.value ? this.valueFacts(initial.value) : NO_FACTS;
      for (const write of rest) {
        if (!facts.integer) break;
        if (write.step !== null) {
          facts = {
            integer: true,
            nonNegative: facts.nonNegative && write.step > 0,
            belowLengthOf: write.step < 0 ? facts.belowLengthOf : null,
          };
        } else if (write.value) {
          const value = this.valueFacts(write.value);
          facts = {
            integer: value.integer,
            nonNegative: facts.nonNegative && value.nonNegative,
            belowLengthOf: value.belowLengthOf === facts.belowLengthOf ? facts.belowLengthOf : null,
          };
        } else facts = NO_FACTS;
      }
    }
    this.indexFacts.set(symbol, facts);
    return facts;
  }

  /** `text.length`, or a const binding initialized from it while `text`
   * itself is never reassigned. */
  private isLength(node: ts.Expression, text: ts.Symbol): boolean {
    const e = peel(node);
    if (ts.isPropertyAccessExpression(e)) return this.lengthOf(e) === text;
    if (!ts.isIdentifier(e)) return false;
    const alias = this.symbolAt(e);
    const declaration = alias ? this.declarationOf(alias) : undefined;
    if (
      !declaration ||
      !ts.isVariableDeclaration(declaration) ||
      !declaration.initializer ||
      !ts.isVariableDeclarationList(declaration.parent) ||
      !(declaration.parent.flags & ts.NodeFlags.Const)
    )
      return false;
    if (this.lengthOf(peel(declaration.initializer)) !== text) return false;
    return this.binding(text)?.constant === true;
  }

  /** `text.length - k` for an integer k >= 1. */
  private isLengthMinusOne(node: ts.Expression, text: ts.Symbol): boolean {
    const e = peel(node);
    if (!ts.isBinaryExpression(e) || e.operatorToken.kind !== ts.SyntaxKind.MinusToken)
      return false;
    const amount = integerLiteral(e.right);
    return amount !== null && amount >= 1 && this.isLength(e.left, text);
  }

  private isIndex(node: ts.Expression, index: ts.Symbol): boolean {
    const e = peel(node);
    return ts.isIdentifier(e) && this.symbolAt(e) === index;
  }

  /** Does `cond` evaluating to `truthy` establish the bound? The index is
   * an integer and lengths are numbers, so a false comparison is its
   * negation. */
  private holds(
    node: ts.Expression,
    truthy: boolean,
    bound: Bound,
    index: ts.Symbol,
    text: ts.Symbol,
  ): boolean {
    const e = peel(node);
    if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.ExclamationToken)
      return this.holds(e.operand, !truthy, bound, index, text);
    if (!ts.isBinaryExpression(e)) return false;
    let op: ts.SyntaxKind = e.operatorToken.kind;
    if (op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.BarBarToken) {
      const conjunction = op === ts.SyntaxKind.AmpersandAmpersandToken;
      if (conjunction !== truthy) return false;
      return (
        this.holds(e.left, truthy, bound, index, text) ||
        this.holds(e.right, truthy, bound, index, text)
      );
    }
    let left = e.left,
      right = e.right;
    // Normalize to `index OP other`.
    if (!this.isIndex(left, index)) {
      if (!this.isIndex(right, index)) return false;
      [left, right] = [right, left];
      op =
        op === ts.SyntaxKind.LessThanToken
          ? ts.SyntaxKind.GreaterThanToken
          : op === ts.SyntaxKind.GreaterThanToken
            ? ts.SyntaxKind.LessThanToken
            : op === ts.SyntaxKind.LessThanEqualsToken
              ? ts.SyntaxKind.GreaterThanEqualsToken
              : op === ts.SyntaxKind.GreaterThanEqualsToken
                ? ts.SyntaxKind.LessThanEqualsToken
                : op;
    }
    if (!truthy) {
      op =
        op === ts.SyntaxKind.LessThanToken
          ? ts.SyntaxKind.GreaterThanEqualsToken
          : op === ts.SyntaxKind.GreaterThanEqualsToken
            ? ts.SyntaxKind.LessThanToken
            : op === ts.SyntaxKind.GreaterThanToken
              ? ts.SyntaxKind.LessThanEqualsToken
              : op === ts.SyntaxKind.LessThanEqualsToken
                ? ts.SyntaxKind.GreaterThanToken
                : ts.SyntaxKind.Unknown;
    }
    if (bound === "upper")
      return (
        (op === ts.SyntaxKind.LessThanToken && this.isLength(right, text)) ||
        (op === ts.SyntaxKind.LessThanEqualsToken && this.isLengthMinusOne(right, text))
      );
    const limit = integerLiteral(right);
    if (limit === null) return false;
    return (
      (op === ts.SyntaxKind.GreaterThanEqualsToken && limit >= 0) ||
      (op === ts.SyntaxKind.GreaterThanToken && limit >= -1)
    );
  }

  /** Find a guard establishing `bound` that still holds at `read`. */
  private guarded(
    read: ts.Node,
    bound: Bound,
    index: ts.Symbol,
    text: ts.Symbol,
    symbols: readonly ts.Symbol[],
  ): boolean {
    const loops: ts.Node[] = [];
    const end = read.pos;
    const valid = (ranges: readonly (readonly [number, number])[]): boolean => {
      for (const symbol of symbols) {
        for (const write of this.binding(symbol)!.writes) {
          if (ranges.some(([from, to]) => write.at >= from && write.at < to)) return false;
          if (loops.some((loop) => write.at >= loop.pos && write.at < loop.end)) return false;
        }
      }
      return true;
    };
    const holds = (cond: ts.Expression, truthy: boolean): boolean =>
      this.holds(cond, truthy, bound, index, text);
    let child: ts.Node = read;
    for (let node = read.parent; node && !isBoundary(node); child = node, node = node.parent) {
      if (ts.isBinaryExpression(node) && node.right === child) {
        const op = node.operatorToken.kind;
        if (
          (op === ts.SyntaxKind.AmpersandAmpersandToken && holds(node.left, true)) ||
          (op === ts.SyntaxKind.BarBarToken && holds(node.left, false))
        ) {
          if (valid([[node.left.pos, end]])) return true;
        }
      } else if (ts.isConditionalExpression(node)) {
        if (node.whenTrue === child && holds(node.condition, true)) {
          if (valid([[node.condition.pos, end]])) return true;
        } else if (node.whenFalse === child && holds(node.condition, false)) {
          if (
            valid([
              [node.condition.pos, node.condition.end],
              [node.whenFalse.pos, end],
            ])
          )
            return true;
        }
      } else if (ts.isIfStatement(node)) {
        if (node.thenStatement === child && holds(node.expression, true)) {
          if (valid([[node.expression.pos, end]])) return true;
        } else if (node.elseStatement === child && holds(node.expression, false)) {
          if (
            valid([
              [node.expression.pos, node.expression.end],
              [node.elseStatement.pos, end],
            ])
          )
            return true;
        }
      } else if (ts.isWhileStatement(node)) {
        if (node.statement === child && holds(node.expression, true)) {
          if (valid([[node.expression.pos, end]])) return true;
        }
      } else if (ts.isForStatement(node)) {
        // The update runs before the condition is tested again.
        if (node.statement === child && node.condition && holds(node.condition, true)) {
          if (
            valid([
              [node.condition.pos, node.condition.end],
              [node.statement.pos, end],
            ])
          )
            return true;
        }
      } else if (ts.isBlock(node) || ts.isCaseClause(node) || ts.isDefaultClause(node)) {
        const statements = node.statements;
        for (let i = statements.indexOf(child as ts.Statement) - 1; i >= 0; i--) {
          const statement = statements[i]!;
          if (
            ts.isIfStatement(statement) &&
            !statement.elseStatement &&
            exits(statement.thenStatement) &&
            holds(statement.expression, false) &&
            valid([
              [statement.expression.pos, statement.expression.end],
              [statement.end, end],
            ])
          )
            return true;
        }
      }
      if (isLoop(node)) loops.push(node);
    }
    return false;
  }
}

/** A string element in a write position (assignment, update, or a
 * destructuring/loop target), never a plain read. */
function writeOfElement(read: ts.ElementAccessExpression): boolean {
  let n: ts.Node = read;
  for (;;) {
    const p: ts.Node | undefined = n.parent;
    if (!p) return false;
    if (ts.isBinaryExpression(p))
      return (
        p.left === n &&
        p.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        p.operatorToken.kind <= ts.SyntaxKind.LastAssignment
      );
    if (ts.isPostfixUnaryExpression(p) || ts.isPrefixUnaryExpression(p))
      return (
        p.operator === ts.SyntaxKind.PlusPlusToken || p.operator === ts.SyntaxKind.MinusMinusToken
      );
    if (ts.isForOfStatement(p) || ts.isForInStatement(p)) return p.initializer === n;
    if (
      ts.isParenthesizedExpression(p) ||
      ts.isArrayLiteralExpression(p) ||
      ts.isSpreadElement(p) ||
      ts.isSpreadAssignment(p) ||
      ts.isObjectLiteralExpression(p) ||
      (ts.isPropertyAssignment(p) && p.initializer === n)
    ) {
      n = p;
      continue;
    }
    return false;
  }
}
