/* Which typed member calls supply their receiver.
 *
 * JavaScript calls `holder.f()` with `holder` as `this`. A function that
 * reads the receiver of its call (a function with its own `this`: a
 * declaration, a function expression or an object-literal method; an arrow
 * has none, and a class method checks the receiver it is given) takes it
 * from the receiver the call supplied. A member call on a record, a tuple or
 * an array passes the holder only where such a function can be the member's
 * value: the fact here is, per member name, whether the program stores one
 * into a member of that name. A program with no function that reads its
 * receiver has no such member, and its calls are untouched.
 *
 * A store is an object-literal property, shorthand or method, an assignment
 * to a property (dotted, or keyed by a string literal) and a class field's
 * initializer. Its value is classified from its syntax and symbols:
 *
 *  - free: an arrow function, a function that never mentions its own `this`
 *    and declares no `this` parameter, a class, a class method, a `bind`
 *    result, a value that is not a function, or a `const` initialized with
 *    one of these;
 *  - carrying: a function that reads its own `this`;
 *  - a read of another member (`options.onDone`): as that member's name;
 *  - opaque: a parameter, a call result, a reassigned binding.
 *
 * An opaque store can hold a receiver-reading function only if one of the
 * program's reaches a place this census does not follow. Each such function
 * is followed from where it is written: a store names its member; a direct
 * call, `call`, `apply`, `bind`, a test, an operator and an argument to a
 * standard library function end the trail; a binding, `||`, `??`, `?:` and
 * an argument to a function of the program (as its parameter) continue it;
 * a computed key or an array element marks keyed and element calls; and
 * anything else (a return value, a spread) leaves it untracked. Only then
 * do members with an opaque store carry too. */
import * as ts from "../ts7/adapter.js";
import { DYN, type IrExpr } from "../../ir/ir.js";
import { varRef } from "../../ir/build.js";
import { isJsSourceFile, locOf } from "../program.js";
import type { Lowerer } from "./lowerer.js";
import { bindingNeverReassigned } from "./binding-analysis.js";

/** What a stored value is: `member` names the member a "member" verdict
 * reads. */
interface Verdict {
  readonly kind: "free" | "carry" | "opaque" | "member";
  readonly member: string;
}
const FREE: Verdict = { kind: "free", member: "" };
const CARRY: Verdict = { kind: "carry", member: "" };
const OPAQUE: Verdict = { kind: "opaque", member: "" };

export interface MemberCallReceivers {
  /** Whether a call of member `name` on a record passes the record. */
  carries(name: string): boolean;
  /** Whether a call of a member read by a computed key or an index does:
   * some member carries, or a receiver-reading function went where the
   * census does not follow it (an array element, an argument). */
  keyed(): boolean;
  /** Whether any member does (false for a program with no function that
   * reads the receiver of its call). */
  readonly any: boolean;
}

const NONE: MemberCallReceivers = { carries: () => false, keyed: () => false, any: false };

const ASSIGNMENTS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
]);

function unwrap(node: ts.Expression): ts.Expression {
  while (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isTypeAssertion(node)
  )
    node = node.expression;
  return node;
}

/** The expression `node` is the whole value of, through parentheses and
 * type-only syntax. */
function valueRoot(node: ts.Node): ts.Node {
  let current = node;
  for (;;) {
    const parent = current.parent;
    if (
      parent !== undefined &&
      (ts.isParenthesizedExpression(parent) ||
        ts.isAsExpression(parent) ||
        ts.isNonNullExpression(parent) ||
        ts.isSatisfiesExpression(parent) ||
        ts.isTypeAssertion(parent)) &&
      parent.expression === current
    ) {
      current = parent;
      continue;
    }
    return current;
  }
}

/** Whether a function reads the receiver of its own call: a `this` in its
 * parameters or body outside nested functions and classes, which bind
 * their own, or a declared `this` parameter. */
function readsOwnReceiver(fn: ts.FunctionLikeDeclaration): boolean {
  if (
    fn.parameters.nodes.some(
      (parameter) => ts.isIdentifier(parameter.name) && parameter.name.text === "this",
    )
  )
    return true;
  const reads = (node: ts.Node): boolean => {
    if (node.kind === ts.SyntaxKind.ThisKeyword) return true;
    if (
      (ts.isFunctionLike(node) && !ts.isArrowFunction(node)) ||
      ts.isClassDeclaration(node) ||
      ts.isClassExpression(node)
    )
      return false;
    return ts.forEachChild(node, (child) => (reads(child) ? true : undefined)) === true;
  };
  return ts.forEachChild(fn, (child) => (reads(child) ? true : undefined)) === true;
}

function memberName(name: ts.PropertyName | undefined): string | null {
  if (name === undefined) return null;
  return ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)
    ? name.text
    : null;
}

/** The census of one program. It walks every compiled source once to find
 * the functions that read their receiver; a program with none ends there,
 * and its member calls are the calls they are without this fact. */
export function memberCallReceivers(lowerer: Lowerer): MemberCallReceivers {
  // One program is lowered more than once (each stream mode is a pass of
  // its own), and the answer is a property of the program: its analysis
  // owns it.
  const analysis = lowerer.program.analysis;
  const facts = (analysis.memberCallReceivers ??= takeCensus(lowerer));
  if (!facts.any) return NONE;
  return { carries: (name) => facts.names.has(name), keyed: () => facts.keyed, any: true };
}

interface CensusFacts {
  any: boolean;
  names: Set<string>;
  keyed: boolean;
}
const NO_READERS: CensusFacts = { any: false, names: new Set(), keyed: false };

function takeCensus(lowerer: Lowerer): CensusFacts {
  const start = process.env["SCRIPTC_TIMING"] === "1" ? Date.now() : 0;
  const sources = lowerer.program.getSourceFiles().filter((sf) => !sf.isDeclarationFile);
  /** Functions with their own `this` that read it, outside classes. */
  const readers = new Set<ts.Node>();
  for (const sf of sources)
    ts.walkPreorder(sf, (node) => {
      if (
        (ts.isFunctionDeclaration(node) ||
          ts.isFunctionExpression(node) ||
          (ts.isMethodDeclaration(node) && ts.isObjectLiteralExpression(node.parent))) &&
        node.body !== undefined &&
        readsOwnReceiver(node)
      )
        readers.add(node);
    });
  if (readers.size === 0) return NO_READERS;

  /** The names the trail of a reader may continue under: its own name, and
   * the `const` bindings it is copied into. */
  const stores = new Map<string, ts.Expression[]>();
  /** Members a getter, a spread or a reader method defines. */
  const carrying = new Set<string>();
  const opaqueDefinitions = new Set<string>();
  const identifiers = new Map<string, ts.Identifier[]>();
  const memberReads = new Map<string, ts.PropertyAccessExpression[]>();
  const readerMethods = new Set<string>();
  for (const reader of readers) {
    if (!ts.isMethodDeclaration(reader)) continue;
    const name = memberName(reader.name);
    if (name !== null) readerMethods.add(name);
  }
  const store = (name: string | null, value: ts.Expression): void => {
    if (name === null) return;
    const list = stores.get(name);
    if (list) list.push(value);
    else stores.set(name, [value]);
  };
  for (const sf of sources)
    ts.walkPreorder(sf, (node) => {
      if (ts.isPropertyAssignment(node) && ts.isObjectLiteralExpression(node.parent))
        store(memberName(node.name), node.initializer);
      else if (ts.isShorthandPropertyAssignment(node) && ts.isIdentifier(node.name))
        store(node.name.text ?? null, node.name);
      else if (ts.isPropertyDeclaration(node) && node.initializer !== undefined)
        store(memberName(node.name), node.initializer);
      else if (ts.isMethodDeclaration(node) && ts.isObjectLiteralExpression(node.parent)) {
        const name = memberName(node.name);
        if (name !== null && readers.has(node)) carrying.add(name);
      } else if (ts.isGetAccessorDeclaration(node)) {
        const name = memberName(node.name);
        if (name !== null) opaqueDefinitions.add(name);
      } else if (ts.isBinaryExpression(node) && ASSIGNMENTS.has(node.operatorToken.kind)) {
        const target = unwrap(node.left);
        if (ts.isPropertyAccessExpression(target)) store(target.name.text, node.right);
        else if (
          ts.isElementAccessExpression(target) &&
          ts.isStringLiteralLike(target.argumentExpression)
        )
          store(target.argumentExpression.text ?? null, node.right);
      } else if (ts.isIdentifier(node)) {
        const list = identifiers.get(node.text);
        if (list) list.push(node);
        else identifiers.set(node.text, [node]);
      } else if (ts.isPropertyAccessExpression(node) && readerMethods.has(node.name.text)) {
        const list = memberReads.get(node.name.text);
        if (list) list.push(node);
        else memberReads.set(node.name.text, [node]);
      }
    });

  const checker = lowerer.checker;
  const symbolOf = (node: ts.Node): ts.Symbol | undefined => {
    let symbol = checker.getSymbolAtLocation(node);
    if (symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0)
      symbol = checker.getAliasedSymbol(symbol);
    return symbol;
  };

  // Follow each reader from where it is written.
  let untracked = false;
  /** A reader stored under a computed key or as an array element. */
  let keyedStore = false;
  const followed = new Set<ts.Symbol>();
  const followValue = (value: ts.Node): void => {
    const root = valueRoot(value);
    const parent = root.parent;
    if (parent === undefined) return;
    // A direct call. `call`, `apply` and `bind` name the receiver, and any
    // other member of the function (`f.prototype`, `f.length`) is not the
    // function.
    if ((ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.expression === root)
      return;
    if (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) return;
    if (ts.isExpressionStatement(parent)) return;
    // Tests and operators use the value up: a condition, `!f`, `typeof f`,
    // a comparison, a template.
    if (
      ts.isIfStatement(parent) ||
      ts.isWhileStatement(parent) ||
      ts.isDoStatement(parent) ||
      ts.isForStatement(parent) ||
      ts.isPrefixUnaryExpression(parent) ||
      ts.isTypeOfExpression(parent) ||
      ts.isVoidExpression(parent) ||
      ts.isTemplateSpan(parent)
    )
      return;
    if (ts.isConditionalExpression(parent)) {
      if (parent.condition !== root) followValue(parent);
      return;
    }
    // A store: the member's own classification finds the reader.
    if (
      (ts.isPropertyAssignment(parent) && parent.initializer === root) ||
      ts.isShorthandPropertyAssignment(parent) ||
      (ts.isPropertyDeclaration(parent) && parent.initializer === root)
    )
      return;
    if (ts.isBinaryExpression(parent)) {
      const operator = parent.operatorToken.kind;
      if (ASSIGNMENTS.has(operator) && parent.right === root) {
        const target = unwrap(parent.left);
        if (ts.isPropertyAccessExpression(target)) return;
        if (ts.isElementAccessExpression(target)) {
          if (!ts.isStringLiteralLike(target.argumentExpression)) keyedStore = true;
          return;
        }
        if (ts.isIdentifier(target)) {
          followBinding(target);
          return;
        }
        untracked = true;
        return;
      }
      // `a || f`, `a ?? f`, `a && f` and `a, f` hand the value on; the left
      // side of `&&` and of a comma, and every other operator, do not.
      const forwards =
        operator === ts.SyntaxKind.BarBarToken ||
        operator === ts.SyntaxKind.QuestionQuestionToken ||
        ((operator === ts.SyntaxKind.AmpersandAmpersandToken ||
          operator === ts.SyntaxKind.CommaToken) &&
          parent.right === root);
      if (forwards) followValue(parent);
      return;
    }
    // A binding continues the trail.
    if (
      ts.isVariableDeclaration(parent) &&
      parent.initializer === root &&
      ts.isIdentifier(parent.name)
    ) {
      followBinding(parent.name);
      return;
    }
    if (ts.isArrayLiteralExpression(parent)) {
      keyedStore = true;
      return;
    }
    // The standard library's functions do not store a callback into a
    // record of the program.
    if ((ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.expression !== root) {
      const callee = symbolOf(
        ts.isPropertyAccessExpression(parent.expression)
          ? parent.expression.name
          : parent.expression,
      );
      if (callee !== undefined && lowerer.isStdlibSymbol(callee)) return;
      // An argument to a function of the program continues as its
      // parameter.
      const index = (parent.arguments?.nodes ?? []).indexOf(root as ts.Expression);
      const declarations = callee?.declarations ?? [];
      const parameters: ts.Identifier[] = [];
      for (const declaration of declarations) {
        if (!ts.isFunctionLike(declaration) || declaration.body === undefined) break;
        const parameter = declaration.parameters.nodes[index];
        if (
          parameter === undefined ||
          parameter.dotDotDotToken !== undefined ||
          !ts.isIdentifier(parameter.name)
        )
          break;
        parameters.push(parameter.name);
      }
      if (index >= 0 && declarations.length > 0 && parameters.length === declarations.length) {
        for (const parameter of parameters) followBinding(parameter);
        return;
      }
    }
    untracked = true;
  };
  const followBinding = (name: ts.Identifier): void => {
    const symbol = symbolOf(name);
    if (symbol === undefined) {
      untracked = true;
      return;
    }
    if (followed.has(symbol)) return;
    followed.add(symbol);
    for (const use of identifiers.get(name.text) ?? []) {
      if (use === name || symbolOf(use) !== symbol) continue;
      const parent = use.parent;
      // Declaration names and the name side of a member access are not uses.
      if (parent !== undefined && ts.isPropertyAccessExpression(parent) && parent.name === use)
        continue;
      if (
        parent !== undefined &&
        (ts.isFunctionDeclaration(parent) ||
          ts.isVariableDeclaration(parent) ||
          ts.isParameter(parent)) &&
        parent.name === use
      )
        continue;
      followValue(use);
    }
  };
  for (const reader of readers) {
    if (ts.isFunctionExpression(reader)) followValue(reader);
    else if (ts.isFunctionDeclaration(reader)) {
      if (reader.name !== undefined) followBinding(reader.name);
      else untracked = true;
    }
  }
  // A reader method read off its object as a value: a read that names the
  // method, or one the checker gives no declaration for.
  for (const reads of memberReads.values())
    for (const read of reads) {
      const declarations = symbolOf(read.name)?.declarations ?? [];
      if (declarations.length === 0 || declarations.some((declaration) => readers.has(declaration)))
        followValue(read);
    }

  const classified = new Map<ts.Node, Verdict>();
  const classify = (value: ts.Expression, depth: number): Verdict => {
    const known = classified.get(value);
    if (known !== undefined) return known;
    const verdict = classifyValue(unwrap(value), depth);
    classified.set(value, verdict);
    return verdict;
  };
  const join = (a: Verdict, b: Verdict): Verdict => {
    if (a.kind === "carry" || b.kind === "carry") return CARRY;
    if (a.kind === "opaque" || b.kind === "opaque") return OPAQUE;
    if (a.kind === "free") return b;
    if (b.kind === "free") return a;
    // Two member reads: the same member, or anything.
    return a.member === b.member ? a : OPAQUE;
  };
  const classifyValue = (value: ts.Expression, depth: number): Verdict => {
    if (ts.isArrowFunction(value) || ts.isClassExpression(value)) return FREE;
    if (ts.isFunctionExpression(value)) return readers.has(value) ? CARRY : FREE;
    if (ts.isConditionalExpression(value))
      return join(classify(value.whenTrue, depth), classify(value.whenFalse, depth));
    if (ts.isBinaryExpression(value)) {
      const operator = value.operatorToken.kind;
      if (
        operator === ts.SyntaxKind.BarBarToken ||
        operator === ts.SyntaxKind.QuestionQuestionToken
      )
        return join(classify(value.left, depth), classify(value.right, depth));
      if (
        operator === ts.SyntaxKind.AmpersandAmpersandToken ||
        operator === ts.SyntaxKind.CommaToken
      )
        return classify(value.right, depth);
      // Arithmetic, comparison and assignment results are not function
      // values this census names.
      return ASSIGNMENTS.has(operator) ? classify(value.right, depth) : FREE;
    }
    if (ts.isCallExpression(value)) {
      const callee = unwrap(value.expression);
      return ts.isPropertyAccessExpression(callee) && callee.name.text === "bind" ? FREE : OPAQUE;
    }
    if (ts.isIdentifier(value)) {
      if (value.text === "undefined") return FREE;
      const symbol =
        value.parent !== undefined && ts.isShorthandPropertyAssignment(value.parent)
          ? (checker.getShorthandAssignmentValueSymbol(value.parent) ?? undefined)
          : symbolOf(value);
      const declarations = symbol?.declarations ?? [];
      if (declarations.length === 0) return OPAQUE;
      let verdict: Verdict = FREE;
      for (const declaration of declarations) {
        if (ts.isFunctionDeclaration(declaration))
          verdict = join(verdict, readers.has(declaration) ? CARRY : FREE);
        else if (ts.isClassDeclaration(declaration)) continue;
        else if (
          ts.isVariableDeclaration(declaration) &&
          declaration.initializer !== undefined &&
          ts.isVariableDeclarationList(declaration.parent) &&
          (declaration.parent.flags & ts.NodeFlags.Const) !== 0 &&
          depth < 4
        )
          verdict = join(verdict, classify(declaration.initializer, depth + 1));
        else return OPAQUE;
      }
      return verdict;
    }
    if (ts.isPropertyAccessExpression(value)) {
      const declarations = symbolOf(value.name)?.declarations ?? [];
      if (
        declarations.length > 0 &&
        declarations.every(
          (declaration) =>
            ts.isMethodDeclaration(declaration) &&
            (ts.isClassDeclaration(declaration.parent) || ts.isClassExpression(declaration.parent)),
        )
      )
        return FREE;
      if (
        declarations.length > 0 &&
        declarations.every(
          (declaration) =>
            ts.isMethodDeclaration(declaration) && ts.isObjectLiteralExpression(declaration.parent),
        )
      )
        return declarations.some((declaration) => readers.has(declaration)) ? CARRY : FREE;
      return { kind: "member", member: value.name.text };
    }
    // Values that are not functions.
    if (
      ts.isStringLiteralLike(value) ||
      ts.isNumericLiteral(value) ||
      ts.isBigIntLiteral(value) ||
      ts.isRegularExpressionLiteral(value) ||
      ts.isTemplateExpression(value) ||
      ts.isObjectLiteralExpression(value) ||
      ts.isArrayLiteralExpression(value) ||
      ts.isPrefixUnaryExpression(value) ||
      ts.isPostfixUnaryExpression(value) ||
      ts.isTypeOfExpression(value) ||
      ts.isVoidExpression(value) ||
      ts.isDeleteExpression(value) ||
      value.kind === ts.SyntaxKind.TrueKeyword ||
      value.kind === ts.SyntaxKind.FalseKeyword ||
      value.kind === ts.SyntaxKind.NullKeyword
    )
      return FREE;
    return OPAQUE;
  };

  const answers = new Map<string, boolean>();
  const visiting = new Set<string>();
  const carries = (name: string): boolean => {
    const known = answers.get(name);
    if (known !== undefined) return known;
    // A cycle of member reads adds nothing by itself.
    if (visiting.has(name)) return false;
    visiting.add(name);
    let answer = carrying.has(name) || (untracked && opaqueDefinitions.has(name));
    for (const value of stores.get(name) ?? []) {
      if (answer) break;
      const verdict = classify(value, 0);
      answer =
        verdict.kind === "carry" ||
        (verdict.kind === "opaque" && untracked) ||
        (verdict.kind === "member" && verdict.member !== name && carries(verdict.member));
    }
    visiting.delete(name);
    // A "no" reached while another member was being decided may have cut a
    // cycle through it; only the outermost question's "no" is final.
    if (answer || visiting.size === 0) answers.set(name, answer);
    return answer;
  };
  // The answers are plain data, so the census keeps nothing of the lowerer
  // that took it.
  const names = new Set<string>(carrying);
  if (untracked) for (const name of opaqueDefinitions) names.add(name);
  for (const name of stores.keys()) if (carries(name)) names.add(name);
  const keyed = untracked || keyedStore || names.size > 0;
  if (start !== 0)
    process.stderr.write(
      `scriptc lowering ${JSON.stringify({ phase: "member-call-receivers", phase_ms: Date.now() - start, readers: readers.size, members: stores.size, carrying: names.size, untracked })}\n`,
    );
  return { any: true, names, keyed };
}

/** The holder of a call's member callee (`x` in `x.f(…)`, `x["f"](…)`,
 * `x[i](…)`, `x.f!(…)`, `(x.f)(…)`), when the call passes it as the
 * receiver: `x` is a record, a tuple or an array, and the member can hold a
 * function that reads the receiver of its call. JavaScript sources pass
 * their receivers through the dynamic calls they already lower to. */
export function memberCallHolder(lowerer: Lowerer, call: ts.CallExpression): ts.Expression | null {
  if (isJsSourceFile(ts.getSourceFileOfNode(call))) return null;
  const callee = unwrap(call.expression);
  let name: string | null;
  if (ts.isPropertyAccessExpression(callee)) name = callee.name.text;
  else if (ts.isElementAccessExpression(callee))
    // An index names an element, not a member a store names.
    name =
      (lowerer.typeOf(callee.argumentExpression).flags & ts.TypeFlags.NumberLike) !== 0
        ? null
        : lowerer.foldedStringKeyOf(callee.argumentExpression);
  else return null;
  if (callee.questionDotToken) return null;
  const census = lowerer.memberCallReceiverCensus();
  if (!census.any || !(name === null ? census.keyed() : census.carries(name))) return null;
  const holder = lowerer.mapTypeOf(lowerer.typeOf(callee.expression));
  return holder?.kind === "record" || holder?.kind === "array" ? callee.expression : null;
}

/** Whether `value`, the lowered `node`, reads a binding that holds the same
 * object until the enclosing function returns: an immutable local or module
 * binding, or a parameter or variable nothing assigns after its
 * declaration. */
export function stableBinding(lowerer: Lowerer, value: IrExpr, node: ts.Expression): boolean {
  if (value.kind !== "varRef") return false;
  const local = lowerer.ctx.locals.find((candidate) => candidate.id === value.localId);
  if (local !== undefined && !local.mutable && local.tdz !== true) return true;
  const global = lowerer.globalsList.find((candidate) => candidate.id === value.localId);
  if (global !== undefined && !global.mutable && global.tdz !== true) return true;
  if (local === undefined || local.tdz === true) return false;
  const name = unwrap(node);
  if (!ts.isIdentifier(name)) return false;
  const symbol = lowerer.resolveValueSymbol(name);
  const declaration = symbol?.valueDeclaration;
  return (
    symbol !== null &&
    symbol !== undefined &&
    declaration !== undefined &&
    (ts.isParameter(declaration) || ts.isVariableDeclaration(declaration)) &&
    bindingNeverReassigned(lowerer, symbol, declaration)
  );
}

/** Lowers a call through its callee's value with the holder evaluated once
 * and passed as the call's receiver. `lower` builds the call while reads of
 * the holder answer the saved value, and is handed the receiver to attach
 * (undefined when the holder has no dynamic form). */
export function withMemberCallReceiver(
  lowerer: Lowerer,
  call: ts.CallExpression,
  holderNode: ts.Expression,
  lower: (receiver: IrExpr | undefined) => IrExpr,
): IrExpr {
  const loc = locOf(call);
  const holder = lowerer.lowerExpr(holderNode);
  const boxes = (value: IrExpr): IrExpr | undefined =>
    (value.type.kind === "record" || value.type.kind === "array") &&
    lowerer.dynConvertible(value.type)
      ? lowerer.coerceToExpected(value, DYN)
      : undefined;
  // A binding nothing can reassign is the holder for the whole call.
  if (stableBinding(lowerer, holder, holderNode)) return lower(boxes(holder));
  const local = lowerer.declareHiddenLocal("%callReceiver", holder.type);
  const reference = varRef(local.id, holder.type, loc);
  const receiver = boxes(reference);
  const result = lowerer.withExpressionOverride(holderNode, reference, () => lower(receiver));
  return {
    kind: "seqExpr",
    stmts: [{ kind: "varDecl", localId: local.id, init: holder, loc }],
    result,
    type: result.type,
    loc,
  };
}
