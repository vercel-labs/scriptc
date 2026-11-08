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
 * (boundStringCall). The Worker-entry slice (wave2 §4.2) adds the three
 * value forms a computed `new Worker(entry)` needs and `import()` does not:
 *
 *   - a MODULE-RELATIVE URL, `new URL(<bounded text>, import.meta.url)`,
 *     resolved against the module that spelled it;
 *   - the RETURN VALUES of a module-local function every call of which is
 *     direct (`defaultWorkerUrl()`), under the same escape and recursion
 *     rules as a parameter;
 *   - a PARTIAL bound `{ values, top }`: `a ?? b` with a Top `a` keeps b's
 *     values and marks the residual a Worker entry can still be. `import()`
 *     has no residual arm, so it reads a partial bound as Top.
 *
 * Every other form is Top — including `path.join` folding and glob
 * expansion, which the sites these slices clear do not need. A bound is an
 * OVER-approximation: a superset is sound (the selector's final arm is a
 * thrown ERR_MODULE_NOT_FOUND, or a Worker's named entry error), a set that
 * misses a runtime value is not.
 *
 * The analysis runs only on NON-literal load sites (pitfall P4): a literal
 * specifier keeps its exact existing lowering, unfiltered. It needs no
 * `Lowerer` — only a checker, a reassignment cache and symbol resolution
 * (SpecifierBoundContext, a record) — so the program's graph walks, which
 * run before lowering, bound a site exactly as its lowering does. */

import { pathToFileURL } from "node:url";
import * as ts from "./ts7/adapter.js";
import { bindingNeverReassigned, type BindingScope } from "./binding-writes.js";
import { withoutParenthesesTypeWrappers } from "./outer-expressions.js";
import { importMetaUrl, isUrlConstructor } from "./fork-target.js";

/** At most this many values: beyond it the cartesian products are no longer
 * a catalogue a selector should spell out. */
const MAX_VALUES = 256;

/** One value a computed module load may take. `text` is a plain string: a
 * specifier for `import()` and a path for a module load. `url` is a value
 * built by `new URL(<bounded text>, import.meta.url)`: an absolute file URL
 * resolved at build time against the module that spelled it. Only a module
 * load resolves a URL; `import()` reads URL values as Top. */
export type SpecifierValue =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "url"; readonly href: string };

/** The values a load site may take, with `partial`'s values plus the Top
 * part that keeps a residual (`values` covers the values the analysis
 * bounded, `at`/`why` name the first source it could not). */
export type SpecifierBound =
  | { kind: "set"; values: SpecifierValue[] }
  | { kind: "partial"; values: SpecifierValue[]; at: ts.Node; why: string }
  | { kind: "top"; at: ts.Node; why: string };

/** A bound as `import()` reads it: text values only, and no residual — an
 * `import()` whose operand may hold a value outside the set cannot be
 * lowered, so a partial bound is Top there. */
export type TextBound =
  | { kind: "set"; values: string[] }
  | { kind: "top"; at: ts.Node; why: string };

/** What the analysis reads of its surroundings: a record. The lowering
 * passes `lowerer.specifierBoundContext()` and the pre-lowering graph walks
 * `specifierBoundContextOf(program)`; never the Lowerer itself, which this
 * interface would turn into a dynamic value when the compiler compiles
 * itself (see Lowerer.isStdlibFile). */
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
 * bounding it: the full domain, with URL values and the residual part of a
 * partial bound. A module load (a Worker entry) reads this answer. */
export function boundLoadValues(ctx: SpecifierBoundContext, expr: ts.Expression): SpecifierBound {
  const inProgress: InProgress = new Set();
  return bound(ctx, expr, inProgress);
}

/** What the walk is in the middle of bounding, so a value that depends on
 * itself is Top instead of an endless descent: a variable's symbol while its
 * initializer is bounded, a function's symbol while the arguments its calls
 * pass (its PARAMETERS) are, and a function's declaration while the values
 * it RETURNS are. The last two are separate entries because a return value
 * that reads the function's own parameter (`entryUrl(specifier)` returning
 * `new URL(specifier, import.meta.url)`) is not a recursion: the parameter
 * is bounded from the call sites while the returns are in progress. */
type InProgress = Set<ts.Symbol | ts.SignatureDeclaration>;

/** The values an `import()` specifier may evaluate to: `boundLoadValues`,
 * read as text values only. A URL value or a partial bound is Top — an
 * `import()` has a single selector with no residual arm. */
export function boundSpecifier(ctx: SpecifierBoundContext, expr: ts.Expression): TextBound {
  const load = boundLoadValues(ctx, expr);
  if (load.kind === "top") return { kind: "top", at: load.at, why: load.why };
  const values: string[] = [];
  for (const value of load.values) {
    if (value.kind !== "text")
      return { kind: "top", at: expr, why: "the URL value of a `new URL(...)`" };
    values.push(value.text);
  }
  // A partial bound has a residual an import() cannot answer: it is Top.
  if (load.kind === "partial") return { kind: "top", at: load.at, why: load.why };
  const unique = [...new Set(values)].sort();
  if (unique.length > MAX_VALUES)
    return { kind: "top", at: expr, why: `more than ${MAX_VALUES} possible values` };
  return { kind: "set", values: unique };
}

function top(at: ts.Node, why: string): SpecifierBound {
  return { kind: "top", at, why };
}

/** A single text value. */
function textValue(text: string): SpecifierValue {
  return { kind: "text", text };
}

/** Deduplicated, sorted text values; over the cap is Top at `at`. */
function finiteText(values: readonly string[], at: ts.Node): SpecifierBound {
  const unique = [...new Set(values)].sort();
  if (unique.length > MAX_VALUES) return top(at, `more than ${MAX_VALUES} possible values`);
  return { kind: "set", values: unique.map(textValue) };
}

/** Deduplicated values in their own order (text values sorted, URL values
 * kept in discovery order after them); over the cap is Top at `at`. */
function finiteValues(values: readonly SpecifierValue[], at: ts.Node): SpecifierBound {
  const texts = [...new Set(values.filter((v) => v.kind === "text").map((v) => v.text))].sort();
  const urls = [...new Set(values.filter((v) => v.kind === "url").map((v) => v.href))];
  const unique: SpecifierValue[] = [
    ...texts.map((text): SpecifierValue => ({ kind: "text", text })),
    ...urls.map((href): SpecifierValue => ({ kind: "url", href })),
  ];
  if (unique.length > MAX_VALUES) return top(at, `more than ${MAX_VALUES} possible values`);
  return { kind: "set", values: unique };
}

/** The values of a bound as a string operation consumes them, or null when
 * the bound is not a finite set. A URL value is its href: `import.meta.url`
 * is that string, and a URL object converts to it wherever a string is
 * asked of it (`+`, a template, `new URL(url)`). The operation's result is
 * text: `import.meta.url.replace("main.ts", "job.ts")` is a string, and names
 * a file again only inside `new URL(...)`. Answering the receiver's own
 * bound for it would compile the module itself as the target. */
function textValues(bound: SpecifierBound): string[] | null {
  if (bound.kind !== "set") return null;
  return bound.values.map((value) => (value.kind === "text" ? value.text : value.href));
}

/** `bound` as the text values a string operation consumes, or the Top it
 * stops at. A partial bound stops as Top: a string operation over a partly
 * unknown operand has no build-time value. */
function textOrStop(bound: SpecifierBound): string[] | SpecifierBound {
  const values = textValues(bound);
  return values !== null ? values : bound.kind === "partial" ? top(bound.at, bound.why) : bound;
}

/** The Top a fold must stop at, or null when `bound` is a set of text
 * values. */
function stops(bound: SpecifierBound): SpecifierBound | null {
  const stopped = textOrStop(bound);
  return Array.isArray(stopped) ? null : stopped;
}

/** The union of the branches a site may take. A Top branch makes the answer
 * partial when another branch is bounded: a Worker entry keeps those values
 * and the residual arm, while `import()` reads the partial bound as Top, the
 * first branch that could not be bounded. */
function union(bounds: readonly SpecifierBound[], at: ts.Node): SpecifierBound {
  const values: SpecifierValue[] = [];
  let residual: { at: ts.Node; why: string } | null = null;
  for (const b of bounds) {
    if (b.kind !== "set") {
      residual ??= b;
      if (b.kind === "top") continue;
    }
    values.push(...b.values);
  }
  if (residual === null) return finiteValues(values, at);
  const finite = finiteValues(values, at);
  // The residual stays the reason: over the cap, nothing else is kept.
  if (finite.kind !== "set" || finite.values.length === 0) return top(residual.at, residual.why);
  return { kind: "partial", values: finite.values, at: residual.at, why: residual.why };
}

/** The cartesian concatenation of two bounds, or the operand that is Top.
 * The cap counts DISTINCT strings: pairs can repeat a string, and a product
 * cut short at a raw pair count would lack the values only later pairs
 * produce while still looking finite. */
function concat(left: SpecifierBound, right: SpecifierBound, at: ts.Node): SpecifierBound {
  const stopped = stops(left) ?? stops(right);
  if (stopped !== null) return stopped;
  const values = new Set<string>();
  for (const l of textValues(left)!) {
    for (const r of textValues(right)!) {
      values.add(l + r);
      if (values.size > MAX_VALUES) return top(at, `more than ${MAX_VALUES} possible values`);
    }
  }
  return finiteText([...values], at);
}

function bound(
  ctx: SpecifierBoundContext,
  expression: ts.Expression,
  inProgress: InProgress,
): SpecifierBound {
  const expr = withoutParenthesesTypeWrappers(expression);
  if (ts.isStringLiteralLike(expr)) return textOf(expr.text);
  if (ts.isTemplateExpression(expr)) {
    // The head, then one cartesian step per span (its expression) with the
    // literal that follows it appended to every value.
    let values: SpecifierBound = textOf(expr.head.text);
    for (const span of expr.templateSpans.nodes) {
      const part = bound(ctx, span.expression, inProgress);
      values = concat(values, part, expr);
      const tail: SpecifierBound = textOf(span.literal.text);
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
  if (ts.isPropertyAccessExpression(expr) && importMetaUrl(expr)) return moduleUrlOf(expr);
  if (ts.isNewExpression(expr)) {
    const url = boundUrl(ctx, expr, inProgress);
    if (url !== null) return url;
  }
  if (ts.isCallExpression(expr)) {
    const folded = boundStringCall(ctx, expr, inProgress);
    if (folded !== null) return folded;
    const returned = boundReturns(ctx, expr, inProgress);
    if (returned !== null) return returned;
  }
  return top(expr, describeUnbounded(expr));
}

/** A bound holding exactly one text value. */
function textOf(text: string): SpecifierBound {
  return { kind: "set", values: [textValue(text)] };
}

/** The module's own file URL — the value `import.meta.url` has in the
 * compiled program (lowering/import-meta.ts). */
function moduleUrlOf(node: ts.Node): SpecifierBound {
  return {
    kind: "set",
    values: [{ kind: "url", href: pathToFileURL(ts.getSourceFileOfNode(node).fileName).href }],
  };
}

/** `new URL(<bounded text>, import.meta.url)` (or the one-argument absolute
 * form): one URL value per bounded string, resolved against the module that
 * spelled it. Any other base or a value URL throws for is Top. */
function boundUrl(
  ctx: SpecifierBoundContext,
  expr: ts.NewExpression,
  inProgress: InProgress,
): SpecifierBound | null {
  if (!isUrlConstructor(ctx.program, expr.expression)) return null;
  const args = expr.arguments?.nodes ?? [];
  if (args.length < 1 || args.length > 2 || args.some(ts.isSpreadElement))
    return top(expr, describeUnbounded(expr));
  const input = bound(ctx, args[0]!, inProgress);
  const stopped = stops(input);
  if (stopped !== null) return stopped;
  let base: string | null = null;
  if (args.length === 2) {
    if (!importMetaUrl(args[1]!))
      return top(
        args[1]!,
        "a `new URL(...)` base other than `import.meta.url` (the module the URL is relative to)",
      );
    base = pathToFileURL(ts.getSourceFileOfNode(expr).fileName).href;
  }
  const values: SpecifierValue[] = [];
  for (const text of textValues(input)!) {
    try {
      values.push({
        kind: "url",
        href: base === null ? new URL(text).href : new URL(text, base).href,
      });
    } catch {
      return top(expr, "a `new URL(...)` that throws for one of its values");
    }
  }
  return finiteValues(values, expr);
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
  inProgress: InProgress,
): SpecifierBound | null {
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee)) return null;
  const method = callee.name.text;
  if (!FOLDED_STRING_METHODS.has(method)) return null;
  if (callee.questionDotToken !== undefined || call.questionDotToken !== undefined) return null;
  const receiver = textOrStop(bound(ctx, callee.expression, inProgress));
  if (!Array.isArray(receiver)) return receiver;
  const args = call.arguments.nodes;
  // The argument shapes: none for the case methods and trim; number literals
  // for slice; strings (and, for replace, a regex literal) otherwise. Each
  // arm calls the method on the value itself: the fold has to stay
  // expressible in the language this compiler compiles, which lowers a
  // String method call but not `String.prototype` or `Function.prototype.call`.
  if (method === "toLowerCase" || method === "toUpperCase" || method === "trim") {
    if (args.length !== 0) return null;
    return foldValues(receiver, (value) => [caseOrTrim(method, value)], call);
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
      receiver,
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
      const part = textOrStop(bound(ctx, arg, inProgress));
      if (!Array.isArray(part)) return part;
      parts.push(part);
    }
    // Every argument contributes one of its values, so the result is the
    // cartesian product of the receiver and those choices — not the single
    // string of every value joined (a runtime value would miss it).
    let total = receiver.length;
    for (const part of parts) total *= part.length;
    if (total > MAX_VALUES) return top(call, `more than ${MAX_VALUES} possible values`);
    return foldValues(
      receiver,
      (value) => {
        let results = [value];
        for (const part of parts)
          results = results.flatMap((prefix) => part.map((piece) => prefix + piece));
        return results;
      },
      call,
    );
  }
  // replace / replaceAll: a regex literal or a bounded string pattern, with
  // a bounded string replacement (a callback has no build-time value).
  if (args.length !== 2) return null;
  const replacement = textOrStop(bound(ctx, args[1]!, inProgress));
  if (!Array.isArray(replacement)) return replacement;
  const regex = regexLiteralOf(args[0]!);
  const patterns = regex === null ? boundPatterns(ctx, args[0]!, inProgress) : null;
  if (regex === null && patterns === null) return null;
  if (patterns !== null && (patterns.length === 0 || replacement.length === 0)) return null;
  return foldValues(
    receiver,
    (value) => {
      const out: string[] = [];
      if (regex !== null) {
        for (const part of replacement) out.push(replaceIn(method, value, regex, part));
      } else if (patterns !== null) {
        for (const pattern of patterns)
          for (const part of replacement) out.push(replaceText(method, value, pattern, part));
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
  return finiteText(out, at);
}

/** The regex literal `node` denotes (its source and flags), or null. */
function regexLiteralOf(node: ts.Expression): RegExp | null {
  const expr = withoutParenthesesTypeWrappers(node);
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
  inProgress: InProgress,
): string[] | null {
  return textValues(bound(ctx, node, inProgress));
}

/** The number a `slice` argument literal denotes (an optionally negated
 * numeric literal), or null. */
function numericLiteralValue(node: ts.Expression): number | null {
  const expr = withoutParenthesesTypeWrappers(node);
  if (ts.isNumericLiteral(expr)) return Number(expr.text);
  if (ts.isPrefixUnaryExpression(expr) && expr.operator === ts.SyntaxKind.MinusToken) {
    const operand = withoutParenthesesTypeWrappers(expr.operand);
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
  inProgress: InProgress,
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
  inProgress: InProgress,
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
  inProgress: InProgress,
): SpecifierBound {
  const fn = decl.parent;
  if (fn === undefined || !ts.isFunctionLike(fn))
    return top(expr, `'${expr.text}', a parameter of a non-function scope`);
  if (decl.dotDotDotToken !== undefined) return top(expr, `'${expr.text}', a rest parameter`);
  // A parameter the function assigns takes values the call arguments do not
  // show.
  if (!bindingNeverReassigned(ctx, sym, decl))
    return top(expr, `'${expr.text}', a parameter written in its function`);
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
  // A named function expression is also called through its own name, inside
  // its body.
  const ownName = ownNameOf(fn);
  const ownSym = ownName === null ? undefined : ctx.checker.getSymbolAtLocation(ownName);
  if (ownName !== null && ownSym === undefined)
    return top(ownName, `a parameter of the function '${ownName.text}', which has no symbol`);
  const { calls, escaped } = scanCalls(ctx, binding, fnSym, ownName, ownSym);
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
      // A spread element supplies any number of values, so no argument from
      // it on has a fixed position: the parameter's value is not the one
      // written at its index (nor its default when nothing is written there).
      const spread = call.arguments.nodes.findIndex((argument) => ts.isSpreadElement(argument));
      if (spread >= 0 && spread <= index) {
        bounds.push(top(call, `a call of '${binding.text}' that spreads its arguments`));
        continue;
      }
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

/** The name a function expression gives itself (`function loadInner() {}`
 * as a value), or null: its body calls it through that name too. */
function ownNameOf(fn: ts.SignatureDeclaration): ts.Identifier | null {
  return ts.isFunctionExpression(fn) && fn.name !== undefined ? fn.name : null;
}

/** Every reference to a module-local function in its own file — through
 * `binding`, or through the name `ownName` a function expression gives
 * itself — split into the direct calls and the first reference that is not
 * one (the function escapes as a value then, and another module's callers
 * would be outside the scan). */
function scanCalls(
  ctx: SpecifierBoundContext,
  binding: ts.Identifier,
  fnSym: ts.Symbol,
  ownName: ts.Identifier | null,
  ownSym: ts.Symbol | undefined,
): { calls: ts.CallExpression[]; escaped: ts.Node | null } {
  const calls: ts.CallExpression[] = [];
  let escaped: ts.Node | null = null;
  ts.walkPreorder(ts.getSourceFileOfNode(binding), (node) => {
    if (escaped !== null) return "stop";
    if (!ts.isIdentifier(node) || node === binding || node === ownName) return;
    if (ts.isTypeNode(node)) return;
    // resolveValueSymbol reads a shorthand property (`{ load }`) as the
    // binding it stores, which escapes like any other value use.
    const target = ctx.resolveValueSymbol(node) ?? ctx.checker.getSymbolAtLocation(node);
    if (target !== fnSym && (ownSym === undefined || target !== ownSym)) return;
    const call = directCallee(node);
    if (call === null) escaped = node;
    else calls.push(call);
    return;
  });
  return { calls, escaped };
}

/** The values a call of a module-local function returns
 * (`defaultWorkerUrl()`): every call of it in its file must be direct, the
 * module must not export it, and every path through its body must return a
 * bounded value. A call of anything else (an imported function, a parameter,
 * a method) is null, so the caller reports it. */
function boundReturns(
  ctx: SpecifierBoundContext,
  call: ts.CallExpression,
  inProgress: InProgress,
): SpecifierBound | null {
  if (call.questionDotToken !== undefined || call.arguments.nodes.some(ts.isSpreadElement))
    return null;
  let callee: ts.Expression = call.expression;
  while (ts.isParenthesizedExpression(callee)) callee = callee.expression;
  if (!ts.isIdentifier(callee)) return null;
  const sym = ctx.resolveValueSymbol(callee) ?? ctx.checker.getSymbolAtLocation(callee);
  if (sym === undefined) return null;
  const fn = localFunctionOf(sym);
  if (fn === null) return null;
  const binding = functionBindingName(fn);
  if (binding === null) return top(callee, `'${callee.text}', a function with no local name`);
  // An exported function's callers may live in another file, so its returns
  // are not this file's to bound: decline, and the site reports the call it
  // actually wrote (`the result of \`tag(...)\``) rather than the
  // declaration's own file.
  if (isExported(ctx, binding)) return null;
  const fnSym = ctx.checker.getSymbolAtLocation(binding);
  if (fnSym === undefined) return top(binding, `'${binding.text}', whose function has no symbol`);
  if (inProgress.has(fn)) return top(callee, `'${binding.text}', which is recursive`);
  const ownName = ownNameOf(fn);
  const ownSym = ownName === null ? undefined : ctx.checker.getSymbolAtLocation(ownName);
  if (ownName !== null && ownSym === undefined)
    return top(ownName, `'${ownName.text}', whose function has no symbol`);
  const { escaped } = scanCalls(ctx, binding, fnSym, ownName, ownSym);
  if (escaped !== null)
    return top(
      escaped,
      `the function value '${binding.text}', which is used other than as a direct call`,
    );
  return returnedValues(ctx, fn, inProgress);
}

/** The function a `const` binding's symbol declares, or null for anything
 * that is not a module-local function with a body. */
function localFunctionOf(sym: ts.Symbol): ts.SignatureDeclaration | null {
  const decl = sym.valueDeclaration ?? sym.declarations?.[0];
  if (decl === undefined) return null;
  if (ts.isFunctionDeclaration(decl)) return decl;
  if (!ts.isVariableDeclaration(decl) || decl.initializer === undefined) return null;
  const init = decl.initializer;
  return ts.isArrowFunction(init) || ts.isFunctionExpression(init) ? init : null;
}

/** The union of every value `fn` returns. A body that can fall off its end
 * returns undefined on that path, and a bare `return` has no value: both are
 * Top. A returned expression may read the function's own parameters; those
 * are bounded from every call site (boundParameter), so the answer covers
 * the returns of every call, not only the one being bounded. */
function returnedValues(
  ctx: SpecifierBoundContext,
  fn: ts.SignatureDeclaration,
  inProgress: InProgress,
): SpecifierBound {
  const body = fn.body;
  if (body === undefined) return top(fn, "a function with no body");
  const expressions: ts.Expression[] = [];
  if (!ts.isBlock(body)) {
    // An arrow's expression body is its return value.
    expressions.push(body as ts.Expression);
  } else {
    const statements = body.statements.nodes;
    const last = statements[statements.length - 1];
    if (last === undefined || !(ts.isReturnStatement(last) || ts.isThrowStatement(last)))
      return top(fn, "a function that can return without a value");
    let refused: ts.Node | null = null;
    ts.walkPreorder(body, (node) => {
      if (!ts.isReturnStatement(node) || nearestFunctionLike(node) !== fn) return;
      if (node.expression === undefined) refused = node;
      else expressions.push(node.expression);
    });
    if (refused !== null) return top(refused, "a function that returns without a value");
  }
  if (expressions.length === 0) return top(fn, "a function that returns no value");
  const bounds: SpecifierBound[] = [];
  inProgress.add(fn);
  try {
    for (const expression of expressions) bounds.push(bound(ctx, expression, inProgress));
  } finally {
    inProgress.delete(fn);
  }
  return union(bounds, fn);
}

/** The innermost function-like scope `node` is written in — a `return` in a
 * nested closure belongs to that closure, not to the function whose returns
 * are bounded. */
function nearestFunctionLike(node: ts.Node): ts.Node | undefined {
  for (let parent = node.parent; parent !== undefined; parent = parent.parent)
    if (ts.isFunctionLike(parent)) return parent;
  return undefined;
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
    // A module-level declaration can still be exported by a clause.
    if (ts.isStatement(p))
      return p.parent !== undefined && ts.isSourceFile(p.parent)
        ? exportedByClause(ctx, p.parent, name)
        : false;
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
      // A re-export from another module names no local binding.
      if (stmt.moduleSpecifier !== undefined) continue;
      for (const element of stmt.exportClause.elements.nodes) {
        const local = element.propertyName ?? element.name;
        // The specifier's name resolves to the export's alias symbol, which
        // aliases the local binding.
        let target = ctx.checker.getSymbolAtLocation(local);
        if (target !== undefined && target.flags & ts.SymbolFlags.Alias)
          target = ctx.checker.getAliasedSymbol(target);
        if (target === sym) return true;
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
