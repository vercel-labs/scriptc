/* The text Function.prototype.toString prints for a function value.
 *
 * Node strips a function's TypeScript syntax and prints what is left, with
 * every erased character standing as a space and newlines kept:
 * `function f(a: number): number { return a + 1; }` prints as
 * "function f(a        )         { return a + 1; }". A module that converts
 * dynamic values to text and boxes a function of its own hands the backend
 * that text (IrFunction.sourceText), which emits it beside the closure's
 * entry point (dyn.ts's closureSourceTable); the runtime prints the text
 * where it printed the native-code form. A program that converts no dynamic
 * value to text, or boxes no function of its own, keeps its functions as
 * they were.
 *
 * The erasure is a walk of the function's own subtree. Node prints one span
 * of the source, so a blank is a range: a type annotation from its colon, a
 * type parameter or argument list including its angle brackets, a `?` or
 * `!`, the `as`/`satisfies`/`!` tail of an expression, a `this` parameter
 * and the comma that follows it, a type-only declaration or class member
 * whole, and a type-only modifier's keyword. The printed text starts at the
 * first surviving token: the erased prefix of a private method is not part
 * of it. */
import * as ts from "../ts7/adapter.js";
import { sourceTextRange, tokenStartOfNode } from "../ts7/node-functions.js";
import { isThisParameter } from "./call-signatures.js";
import type { IrFunction, IrLibFn, SrcLoc } from "../../ir/ir.js";
import { everyStmtList } from "../../ir/traverse.js";
import type { Lowerer } from "./lowerer.js";

/** The library calls that turn a dynamic value into text. A function boxed
 * in a module that makes one of them may be printed, so it is the module
 * that needs its text (and the inline String(unknown) spelling, an IR
 * `toString` over a dyn operand, is the fourth). */
const TEXT_CONVERSIONS: ReadonlySet<IrLibFn> = new Set<IrLibFn>([
  "dyn.stringConstructor",
  "dyn.toString",
  "dyn.toStringCoerce",
]);

/** The modifiers the printed text drops: the keyword is blanked and the
 * text around it stays. `async` is not in the set — Node prints it. */
const ERASED_MODIFIERS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.PrivateKeyword,
  ts.SyntaxKind.PublicKeyword,
  ts.SyntaxKind.ProtectedKeyword,
  ts.SyntaxKind.ReadonlyKeyword,
  ts.SyntaxKind.OverrideKeyword,
  ts.SyntaxKind.AbstractKeyword,
  ts.SyntaxKind.DeclareKeyword,
  // Not TypeScript, but not part of the printed text either: Node prints a
  // function from its `async`/`get`/`set`/`*` or its name, never from
  // `static`, `export` or `default`.
  ts.SyntaxKind.StaticKeyword,
  ts.SyntaxKind.ExportKeyword,
  ts.SyntaxKind.DefaultKeyword,
]);

/** The modifiers that mark a whole declaration or member as type-only. */
const WHOLE_MODIFIERS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.DeclareKeyword,
  ts.SyntaxKind.AbstractKeyword,
]);

interface Blank {
  readonly start: number;
  readonly end: number;
}

/** The type-world fields every annotated node carries; a node reads the
 * ones its kind has. */
interface AnnotationFields {
  readonly type?: ts.Node | undefined;
  readonly typeParameters?: { readonly nodes: readonly ts.Node[] } | undefined;
  readonly typeArguments?: { readonly nodes: readonly ts.Node[] } | undefined;
  readonly questionToken?: ts.Node | undefined;
  readonly postfixToken?: ts.Node | undefined;
  readonly exclamationToken?: ts.Node | undefined;
}

/** Records the source span of the node the lifted function `fn` came from,
 * so that the trees a module boxes can be given their source text once the
 * module's boxing and its text conversions are known
 * (finalizeFunctionSourceText). */
export function noteFunctionSourceNode(lowerer: Lowerer, fn: IrFunction, node: ts.Node): void {
  const sf = ts.getSourceFileOfNode(node);
  lowerer.functionSourceLocs.set(fn.name, {
    file: sf.fileName,
    start: tokenStartOfNode(node),
    end: node.end,
  });
}

/** Gives every function this module boxes into a checked value its source
 * text when the module converts dynamic values to text. */
export function finalizeFunctionSourceText(
  lowerer: Lowerer,
  functions: readonly IrFunction[],
): void {
  if (lowerer.functionSourceLocs.size === 0) return;
  const boxed = boxedFunctionNames(functions);
  if (boxed === null) return;
  // A generic function or arrow is lowered again for each instantiation, as
  // a function of its own over the same source node; the span finds it.
  const bySpan = new Map<string, SrcLoc>();
  for (const loc of lowerer.functionSourceLocs.values()) bySpan.set(spanKey(loc), loc);
  for (const fn of functions) {
    if (!boxed.has(fn.name)) continue;
    const loc = lowerer.functionSourceLocs.get(fn.name) ?? bySpan.get(spanKey(fn.loc));
    if (loc === undefined) continue;
    const node = lowerer.nodeAtLoc(loc);
    if (node !== null) fn.sourceText = erasedFunctionText(node);
  }
}

/** The key a span is looked up by. */
function spanKey(loc: SrcLoc): string {
  return `${loc.file}:${loc.start}:${loc.end}`;
}

/** The names of the functions the IR makes values of, or null when the
 * module converts no dynamic value to text (and so can print none). A
 * closure is a function value; a box of one may follow it through locals
 * and records, so every closure keeps its text. */
function boxedFunctionNames(functions: readonly IrFunction[]): Set<string> | null {
  const names = new Set<string>();
  let toText = false;
  for (const fn of functions) {
    everyStmtList(fn.body, {
      stmt: () => true,
      expr: (e) => {
        if (e.kind === "closure") names.add(e.fnName);
        else if (e.kind === "toString" && e.operand.type.kind === "dyn") toText = true;
        else if (e.kind === "libCall" && TEXT_CONVERSIONS.has(e.fn)) toText = true;
        // `values.join(sep)` over checked-dynamic elements converts each
        // element to text through the same runtime display a coercion uses.
        else if (e.kind === "dynInvoke" && e.method === "join") toText = true;
        return true;
      },
    });
  }
  return toText && names.size > 0 ? names : null;
}

/** The function's source text as Node prints it: the span from its first
 * token to its end, TypeScript syntax blanked, without the erased prefix. */
function erasedFunctionText(node: ts.Node): string {
  const sf = ts.getSourceFileOfNode(node);
  const start = tokenStartOfNode(node);
  const end = node.end;
  if (end <= start) return "";
  const source = sourceTextRange(sf, start, end);
  const at = (offset: number): number =>
    offset >= start && offset < end ? source.charCodeAt(offset - start) : -1;
  const blanks: Blank[] = [];
  eraseNode(node, at, blanks);
  return blanked(source, start, blanks);
}

/** Blanks `source` over every blank range, keeping line breaks, and drops
 * the blank prefix: Node's printed text starts at the first surviving
 * token. */
function blanked(source: string, start: number, blanks: readonly Blank[]): string {
  const chars = source.split("");
  for (const blank of blanks) {
    const from = Math.max(blank.start, start) - start;
    const to = Math.min(blank.end, start + chars.length) - start;
    for (let i = from; i < to; i++) {
      const c = chars[i];
      if (c !== "\n" && c !== "\r") chars[i] = " ";
    }
  }
  let first = 0;
  while (first < chars.length && chars[first] === " ") first++;
  // Node prints the last surviving token and no blank after it.
  return chars.slice(first).join("").trimEnd();
}

/** The node's children with their TypeScript syntax blanked, in preorder. */
function eraseNode(node: ts.Node, at: (offset: number) => number, blanks: Blank[]): void {
  if (isTypeOnlyWhole(node)) {
    blanks.push({ start: tokenStartOfNode(node), end: node.end });
    return;
  }
  const blank = (start: number, end: number): void => {
    if (end > start) blanks.push({ start, end });
  };
  for (const modifier of ts.canHaveModifiers(node) ? (ts.getModifiers(node) ?? []) : []) {
    if (ERASED_MODIFIERS.has(modifier.kind)) blank(tokenStartOfNode(modifier), modifier.end);
  }
  const typed = node as AnnotationFields;
  if (typed.typeParameters !== undefined && typed.typeParameters.nodes.length > 0)
    blankAngleList(typed.typeParameters, at, blank);
  if (typed.typeArguments !== undefined && typed.typeArguments.nodes.length > 0)
    blankAngleList(typed.typeArguments, at, blank);
  if (typed.type !== undefined) {
    // The annotation from its colon: `a?: string` and `): number` both.
    const from = tokenStartOfNode(typed.type);
    let colon = from - 1;
    while (colon > 0 && isSpace(at(colon))) colon--;
    if (at(colon) === 58 /* : */) blank(colon, typed.type.end);
  }
  // A conditional expression's `?` is its operator, not an optional marker,
  // so a ternary keeps its text.
  if (typed.questionToken !== undefined && !ts.isConditionalExpression(node))
    blank(tokenStartOfNode(typed.questionToken), typed.questionToken.end);
  if (typed.postfixToken !== undefined)
    blank(tokenStartOfNode(typed.postfixToken), typed.postfixToken.end);
  if (typed.exclamationToken !== undefined)
    blank(tokenStartOfNode(typed.exclamationToken), typed.exclamationToken.end);
  if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) {
    // `x as T` / `x satisfies T`: the assertion's tail goes, the value stays.
    blank(node.expression.end, node.end);
  } else if (ts.isNonNullExpression(node)) {
    blank(node.expression.end, node.end);
  }
  if (ts.isParameterDeclaration(node) && isThisParameter(node)) {
    // A `this` parameter is a type: it and its comma leave the parameter
    // list, the space after the comma stays.
    blank(tokenStartOfNode(node), node.end);
    let comma = node.end;
    while (comma < node.end + 64 && isSpace(at(comma))) comma++;
    if (at(comma) === 44 /* , */) blank(node.end, comma + 1);
  }
  ts.forEachChild(node, (child) => eraseNode(child, at, blanks));
}

/** Blanks `<`...`>` around a type parameter or argument list. */
function blankAngleList(
  list: { readonly nodes: readonly ts.Node[] },
  at: (offset: number) => number,
  blank: (start: number, end: number) => void,
): void {
  const first = list.nodes[0];
  const last = list.nodes[list.nodes.length - 1];
  if (first === undefined || last === undefined) return;
  let open = tokenStartOfNode(first) - 1;
  while (open > 0 && isSpace(at(open))) open--;
  if (at(open) !== 60 /* < */) return;
  let close = last.end;
  while (at(close) !== 62 /* > */ && at(close) !== -1) close++;
  if (at(close) === 62) blank(open, close + 1);
}

function isSpace(code: number): boolean {
  return code === 32 || code === 9 || code === 10 || code === 13;
}

/** Whether `node` is syntax Node does not print at all: a type-only
 * declaration, or a class member or class that only a type declares. */
function isTypeOnlyWhole(node: ts.Node): boolean {
  if (
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isModuleDeclaration(node) ||
    ts.isImportDeclaration(node) ||
    ts.isImportEqualsDeclaration(node) ||
    ts.isExportDeclaration(node) ||
    ts.isMethodSignatureDeclaration(node) ||
    ts.isCallSignatureDeclaration(node) ||
    ts.isConstructSignatureDeclaration(node) ||
    ts.isIndexSignatureDeclaration(node) ||
    ts.isPropertySignatureDeclaration(node)
  )
    return true;
  // A `declare` or `abstract` declaration or member. An abstract CLASS
  // keeps its text from `class`: the keyword alone is erased.
  if (
    !ts.isClassLikeDeclaration(node) &&
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some((modifier) => WHOLE_MODIFIERS.has(modifier.kind))
  )
    return true;
  // A function or accessor with no body: an overload's signature.
  if (
    (ts.isFunctionDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node)) &&
    node.body === undefined
  )
    return true;
  return false;
}
