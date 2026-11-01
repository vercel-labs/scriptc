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
 * never escape. Slice B2 adds the whitelisted pure String methods
 * (boundStringCall). Every other form is Top — including `path.join`
 * folding and glob expansion, which the sites B1 and B2 clear do not need.
 * A bound is an OVER-approximation: a superset is sound (the selector's
 * final arm is a thrown ERR_MODULE_NOT_FOUND), a set that misses a runtime
 * value is not.
 *
 * The analysis runs only on NON-literal load sites (pitfall P4): a literal
 * specifier keeps its exact existing lowering, unfiltered. It needs no
 * `Lowerer` — only a checker, a reassignment cache and symbol resolution
 * (SpecifierBoundContext) — so the program's graph walks, which run before
 * lowering, bound a site exactly as its lowering does. */

import * as ts from "./ts7/adapter.js";
import {
  bindingNeverReassigned,
  stripValueWrappers,
  type BindingScope,
} from "./lowering/binding-analysis.js";

/** At most this many values: beyond it the cartesian products are no longer
 * a catalogue a selector should spell out. */
const MAX_VALUES = 256;

export type SpecifierBound =
  | { kind: "set"; values: string[] }
  | { kind: "top"; at: ts.Node; why: string };

/** What the analysis reads of its surroundings. `Lowerer` satisfies it, and
 * so does `specifierBoundContextOf` for the pre-lowering graph walks. */
export interface SpecifierBoundContext extends BindingScope {
  readonly program: ts.Program;
  readonly checker: ts.TypeChecker;
}

/** A bound context over a whole program: the module-order walk and the
 * npm-static closure bound a computed site before any `Lowerer` exists. Its
 * resolver answers the identifiers the bounder asks about the way
 * `Lowerer.resolveValueSymbol` does where the two could differ (a shorthand
 * property's name reads its value binding). */
export function specifierBoundContextOf(program: ts.Program): SpecifierBoundContext {
  const checker = program.getTypeChecker();
  return {
    program,
    checker,
    neverReassignedCache: new Map<ts.Symbol, boolean>(),
    resolveValueSymbol(ident: ts.Identifier): ts.Symbol | null {
      const symbol = checker.getSymbolAtLocation(ident);
      const parent = ident.parent;
      if (parent !== undefined && ts.isShorthandPropertyAssignment(parent) && parent.name === ident)
        return checker.getShorthandAssignmentValueSymbol(parent) ?? symbol ?? null;
      return symbol ?? null;
    },
  };
}

/** The values `expr` may evaluate to, or the first source that prevents
 * bounding it. */
export function boundSpecifier(ctx: SpecifierBoundContext, expr: ts.Expression): SpecifierBound {
  return bound(ctx, expr, new Set<ts.Symbol>());
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
  ctx: SpecifierBoundContext,
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
      const part = bound(ctx, span.expression, inProgress);
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
      [bound(ctx, expr.whenTrue, inProgress), bound(ctx, expr.whenFalse, inProgress)],
      expr,
    );
  }
  if (ts.isBinaryExpression(expr)) {
    const op = expr.operatorToken.kind;
    if (op === ts.SyntaxKind.PlusToken)
      return concat(bound(ctx, expr.left, inProgress), bound(ctx, expr.right, inProgress), expr);
    if (op === ts.SyntaxKind.QuestionQuestionToken || op === ts.SyntaxKind.BarBarToken)
      return union([bound(ctx, expr.left, inProgress), bound(ctx, expr.right, inProgress)], expr);
    return top(expr, `the result of the '${ts.getTextOfNode(expr.operatorToken)}' operator`);
  }
  if (ts.isIdentifier(expr)) return boundIdentifier(ctx, expr, inProgress);
  if (ts.isCallExpression(expr)) {
    const folded = boundStringCall(ctx, expr, inProgress);
    if (folded !== null) return folded;
  }
  return top(expr, describeUnbounded(expr));
}

/** §3.2's whitelisted pure String methods: the receiver and every argument
 * is a finite set here, so the value set is their cartesian product,
 * evaluated by the compiler's own JavaScript — the same engine semantics
 * (and the ones this compiler emits for the expression itself). */
const FOLDED_STRING_METHODS: ReadonlySet<string> = new Set([
  "replace",
  "replaceAll",
  "slice",
  "toLowerCase",
  "toUpperCase",
  "trim",
  "concat",
]);

/** `receiver.method(args)` over finite sets, or null when the call is not a
 * folded String method (the caller then reports it). A throw, a non-string
 * result or more than MAX_VALUES values gives Top: a call the compiler
 * cannot evaluate has no build-time value. */
function boundStringCall(
  ctx: SpecifierBoundContext,
  call: ts.CallExpression,
  inProgress: Set<ts.Symbol>,
): SpecifierBound | null {
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee)) return null;
  const method = callee.name.text;
  if (!FOLDED_STRING_METHODS.has(method)) return null;
  if (callee.questionDotToken !== undefined || call.questionDotToken !== undefined) return null;
  const receiver = bound(ctx, callee.expression, inProgress);
  if (receiver.kind === "top") return receiver;
  const args = call.arguments.nodes;
  // The argument shapes: none for the case methods and trim; number literals
  // for slice; strings (and, for replace, a regex literal) otherwise. Each
  // arm calls the method on the value itself: the fold has to stay
  // expressible in the language this compiler compiles, which lowers a
  // String method call but not `String.prototype` or `Function.prototype.call`.
  if (method === "toLowerCase" || method === "toUpperCase" || method === "trim") {
    if (args.length !== 0) return null;
    return foldValues(receiver.values, (value) => [caseOrTrim(method, value)], call);
  }
  if (method === "slice") {
    const indices: number[] = [];
    for (const arg of args) {
      const index = numericLiteralValue(arg);
      if (index === null) return null;
      indices.push(index);
    }
    if (indices.length > 2) return null;
    return foldValues(
      receiver.values,
      (value) => [
        indices.length === 0
          ? value
          : indices.length === 1
            ? value.slice(indices[0]!)
            : value.slice(indices[0]!, indices[1]!),
      ],
      call,
    );
  }
  if (method === "concat") {
    const parts: string[][] = [];
    for (const arg of args) {
      const part = bound(ctx, arg, inProgress);
      if (part.kind === "top") return part;
      parts.push(part.values);
    }
    return foldValues(
      receiver.values,
      (value) => {
        // Every piece is a string, so `concat` of them is the concatenation.
        let joined = "";
        for (const part of parts) for (const piece of part) joined += piece;
        return [value.concat(joined)];
      },
      call,
    );
  }
  // replace / replaceAll: a regex literal or a bounded string pattern, with
  // a bounded string replacement (a callback has no build-time value).
  if (args.length !== 2) return null;
  const replacement = bound(ctx, args[1]!, inProgress);
  if (replacement.kind === "top") return replacement;
  const regex = regexLiteralOf(args[0]!);
  const patterns = regex === null ? boundPatterns(ctx, args[0]!, inProgress) : null;
  if (regex === null && patterns === null) return null;
  if (patterns !== null && (patterns.length === 0 || replacement.values.length === 0)) return null;
  return foldValues(
    receiver.values,
    (value) => {
      const out: string[] = [];
      if (regex !== null) {
        for (const part of replacement.values) out.push(replaceIn(method, value, regex, part));
      } else if (patterns !== null) {
        for (const pattern of patterns)
          for (const part of replacement.values)
            out.push(replaceText(method, value, pattern, part));
      }
      return out;
    },
    call,
  );
}

/** `toLowerCase`, `toUpperCase` or `trim` of `value`; the caller has matched
 * the name against those three. */
function caseOrTrim(method: string, value: string): string {
  if (method === "toLowerCase") return value.toLowerCase();
  if (method === "toUpperCase") return value.toUpperCase();
  return value.trim();
}

/** `replace`/`replaceAll` of a regex pattern with a string replacement. */
function replaceIn(method: string, value: string, pattern: RegExp, replacement: string): string {
  return method === "replace"
    ? value.replace(pattern, replacement)
    : value.replaceAll(pattern, replacement);
}

/** `replace`/`replaceAll` of a string pattern with a string replacement. */
function replaceText(method: string, value: string, pattern: string, replacement: string): string {
  return method === "replace"
    ? value.replace(pattern, replacement)
    : value.replaceAll(pattern, replacement);
}

/** The values `fold` produces for every receiver value, or Top when the fold
 * throws (Node throws there too: the site never loads) or overflows. */
function foldValues(
  values: readonly string[],
  fold: (value: string) => string[] | null,
  at: ts.Node,
): SpecifierBound {
  const out: string[] = [];
  for (const value of values) {
    let produced: string[] | null;
    try {
      produced = fold(value);
    } catch {
      produced = null;
    }
    if (produced === null) return top(at, "a String method call that throws");
    for (const value of produced) {
      out.push(value);
      if (out.length > MAX_VALUES) return top(at, `more than ${MAX_VALUES} possible values`);
    }
  }
  return finite(out, at);
}

/** The regex literal `node` denotes (its source and flags), or null. */
function regexLiteralOf(node: ts.Expression): RegExp | null {
  const expr = stripValueWrappers(node);
  if (!ts.isRegularExpressionLiteral(expr)) return null;
  const text = expr.text;
  const slash = text.lastIndexOf("/");
  if (slash <= 0) return null;
  try {
    return new RegExp(text.slice(1, slash), text.slice(slash + 1));
  } catch {
    return null;
  }
}

/** A string pattern's finite set, or null when it is not bounded. */
function boundPatterns(
  ctx: SpecifierBoundContext,
  node: ts.Expression,
  inProgress: Set<ts.Symbol>,
): string[] | null {
  const pattern = bound(ctx, node, inProgress);
  return pattern.kind === "top" ? null : pattern.values;
}

/** The number a `slice` argument literal denotes (an optionally negated
 * numeric literal), or null. */
function numericLiteralValue(node: ts.Expression): number | null {
  const expr = stripValueWrappers(node);
  if (ts.isNumericLiteral(expr)) return Number(expr.text);
  if (ts.isPrefixUnaryExpression(expr) && expr.operator === ts.SyntaxKind.MinusToken) {
    const operand = stripValueWrappers(expr.operand);
    if (ts.isNumericLiteral(operand)) return -Number(operand.text);
  }
  return null;
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
  ctx: SpecifierBoundContext,
  expr: ts.Identifier,
  inProgress: Set<ts.Symbol>,
): SpecifierBound {
  const sym = ctx.resolveValueSymbol(expr) ?? ctx.checker.getSymbolAtLocation(expr);
  if (sym === undefined) return top(expr, `'${expr.text}', which has no declaration`);
  const decl = sym.valueDeclaration ?? sym.declarations?.[0];
  if (decl === undefined) return top(expr, `'${expr.text}', which has no declaration`);
  if (inProgress.has(sym)) return top(expr, `'${expr.text}', which refers to itself`);
  if (ts.isVariableDeclaration(decl)) return boundVariable(ctx, expr, sym, decl, inProgress);
  if (ts.isParameterDeclaration(decl)) return boundParameter(ctx, expr, sym, decl, inProgress);
  return top(expr, `'${expr.text}', which is not a string literal or a const binding`);
}

function boundVariable(
  ctx: SpecifierBoundContext,
  expr: ts.Identifier,
  sym: ts.Symbol,
  decl: ts.VariableDeclaration,
  inProgress: Set<ts.Symbol>,
): SpecifierBound {
  const isConst = (ts.getCombinedNodeFlags(decl) & ts.NodeFlags.Const) !== 0;
  if (!isConst && !bindingNeverReassigned(ctx, sym, decl))
    return top(expr, `'${expr.text}', which is written after its declaration`);
  const init = decl.initializer;
  if (init === undefined) return top(expr, `'${expr.text}', which has no initializer`);
  inProgress.add(sym);
  try {
    return bound(ctx, init, inProgress);
  } finally {
    inProgress.delete(sym);
  }
}

/** A parameter of a module-local function: bounded when the function never
 * escapes as a value — every reference in its own file is a direct call, and
 * the module does not export it (another module's callers are outside the
 * scan) — and the union of the call arguments is finite. */
function boundParameter(
  ctx: SpecifierBoundContext,
  expr: ts.Identifier,
  sym: ts.Symbol,
  decl: ts.ParameterDeclaration,
  inProgress: Set<ts.Symbol>,
): SpecifierBound {
  const fn = decl.parent;
  if (fn === undefined || !ts.isFunctionLike(fn))
    return top(expr, `'${expr.text}', a parameter of a non-function scope`);
  if (decl.dotDotDotToken !== undefined) return top(expr, `'${expr.text}', a rest parameter`);
  const binding = functionBindingName(fn);
  if (binding === null)
    return top(expr, `'${expr.text}', a parameter of a function with no local name`);
  if (isExported(ctx, binding))
    return top(binding, `a parameter of the exported function '${binding.text}'`);
  const fnSym = ctx.checker.getSymbolAtLocation(binding);
  if (fnSym === undefined)
    return top(binding, `a parameter of the function '${binding.text}', which has no symbol`);
  if (inProgress.has(fnSym))
    return top(binding, `a parameter of the recursive function '${binding.text}'`);
  const sf = ts.getSourceFileOfNode(fn);
  const calls: ts.CallExpression[] = [];
  let escaped: ts.Node | null = null;
  ts.walkPreorder(sf, (node) => {
    if (escaped !== null) return "stop";
    if (!ts.isIdentifier(node) || node === binding) return;
    if (ts.isTypeNode(node)) return;
    if (ctx.checker.getSymbolAtLocation(node) !== fnSym) return;
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
        bounds.push(bound(ctx, arg, inProgress));
      } else if (decl.initializer !== undefined) {
        bounds.push(bound(ctx, decl.initializer, inProgress));
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
function isExported(ctx: SpecifierBoundContext, name: ts.Identifier): boolean {
  for (let p: ts.Node | undefined = name; p !== undefined; p = p.parent) {
    if (ts.isSourceFile(p)) return exportedByClause(ctx, p, name);
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
    if (ts.isStatement(p)) return false;
  }
  return false;
}

/** Whether the module's export clauses name the local `name`. */
function exportedByClause(
  ctx: SpecifierBoundContext,
  sf: ts.SourceFile,
  name: ts.Identifier,
): boolean {
  const sym = ctx.checker.getSymbolAtLocation(name);
  // No symbol means no proof the export clauses miss it: refuse.
  if (sym === undefined) return true;
  for (const stmt of sf.statements.nodes) {
    if (ts.isExportDeclaration(stmt) && stmt.exportClause !== undefined) {
      if (!ts.isNamedExports(stmt.exportClause)) continue;
      for (const element of stmt.exportClause.elements.nodes) {
        const local = element.propertyName ?? element.name;
        if (ctx.checker.getSymbolAtLocation(local) === sym) return true;
      }
    } else if (ts.isExportAssignment(stmt) && !stmt.isExportEquals) {
      if (ctx.checker.getSymbolAtLocation(stmt.expression) === sym) return true;
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
