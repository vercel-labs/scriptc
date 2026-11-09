/* `void 0` as the initializer of a JavaScript variable that is assigned
 * later:
 *
 *   var val = void 0;
 *   try { val = fn(); } catch (err) { ... }
 *
 * The checker gives `var val;`, `var val = undefined;` and `var val = null;`
 * in a JavaScript file the open type, but it does not know the spelling
 * transpilers write: it types the binding `undefined`, keeps that type for
 * every read whatever the writes stored, and derives the types of the
 * enclosing expressions from it. The file-system shadow therefore serves
 * the initializer as a cast,
 *
 *   var val = /** @type {any} *\/ (void 0);
 *
 * so the checker sees the open type where the value enters: the value, its
 * evaluation and the binding's scope are unchanged.
 *
 * In: a `var` or `let` declarator of a JavaScript file whose name is an
 * identifier, that has no `@type` annotation, and whose initializer is
 * `void` of a literal, written without parentheses; every such declarator
 * of a statement with several, and of a `for` statement's head. Out, with
 * the text as written: TypeScript files, `const` and `using` declarations,
 * annotated declarators, destructuring patterns and their defaults,
 * parameter defaults, a parenthesized initializer, and `void` of anything
 * that is not a literal.
 *
 * The cast never adds a line break. What it inserted is recorded per file
 * and served text, and a diagnostic whose code frame shows such a line
 * carries those spans (ScrDiagnostic.inserted), so the renderer reports the
 * column and shows the line as written. */
import type { ScrDiagnostic } from "../diagnostics/diagnostic.js";
import * as ts from "./ts7/syntax.js";
import { tokenStartOfNode } from "./ts7/node-functions.js";

const CAST_OPEN = "/** @type {any} */ (";
const CAST_CLOSE = ")";

/** A span the shadow inserted: its offset in the served text and its length. */
export type InsertedSpan = readonly [start: number, length: number];

export interface VoidInitializerCasts {
  /** The text with the casts. */
  text: string;
  /** The spans the casts inserted, in ascending order. */
  inserted: InsertedSpan[];
}

/** Whether `path` names a JavaScript file. */
export function isVoidInitializerFile(path: string): boolean {
  return /\.[cm]?jsx?$/.test(path);
}

/** A cheap probe: some `= void` may be present. */
export function mayHoldVoidInitializer(source: string): boolean {
  return /=\s*void\b/.test(source);
}

function isLiteral(node: ts.Expression): boolean {
  return (
    ts.isNumericLiteral(node) ||
    ts.isStringLiteral(node) ||
    ts.isBigIntLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    node.kind === ts.SyntaxKind.TrueKeyword ||
    node.kind === ts.SyntaxKind.FalseKeyword ||
    node.kind === ts.SyntaxKind.NullKeyword
  );
}

/** Whether `node` is `void` of a literal. */
export function isVoidOfLiteral(node: ts.Node | undefined): node is ts.VoidExpression {
  return node !== undefined && ts.isVoidExpression(node) && isLiteral(node.expression);
}

/** Whether `node` is the cast's operand as the shadow serves it, a
 * parenthesized `void` of a literal: a `@type` comment before it types the
 * initializer, not the declarators that follow in the statement. The parser
 * gives a JSDoc cast as `(<operand> as <type>)`. */
export function isVoidLiteralCast(node: ts.Node | undefined): node is ts.ParenthesizedExpression {
  if (node === undefined || !ts.isParenthesizedExpression(node)) return false;
  const operand = node.expression;
  return isVoidOfLiteral(ts.isAsExpression(operand) ? operand.expression : operand);
}

/** The module text with each `void <literal>` initializer of an unannotated
 * `var` or `let` declarator served as a cast to the open type, or null when
 * there is none. */
export function castVoidInitializers(sf: ts.SourceFile): VoidInitializerCasts | null {
  const source = sf.text;
  const edits: { at: number; text: string }[] = [];
  const visitList = (list: ts.VariableDeclarationList, from: number): void => {
    if ((list.flags & (ts.NodeFlags.Const | ts.NodeFlags.Using | ts.NodeFlags.AwaitUsing)) !== 0)
      return;
    // An annotation types the binding, and the declarator stays as written.
    // The lowering's hasJsTypeAnnotation reads the same text: the
    // statement's, up to the declarator, without the written casts of
    // earlier declarators.
    let annotatedBefore = false;
    let unread = from;
    for (const decl of list.declarations.nodes) {
      const annotated: boolean =
        annotatedBefore || /@type\b/.test(source.slice(unread, tokenStartOfNode(decl)));
      const init = decl.initializer;
      if (isVoidLiteralCast(init)) {
        annotatedBefore = annotated;
        unread = decl.end;
      }
      if (annotated || init === undefined || !ts.isIdentifier(decl.name)) continue;
      if (!isVoidOfLiteral(init)) continue;
      const start = tokenStartOfNode(init);
      // The cast is written on the initializer's own lines.
      if (/[\r\n\u2028\u2029]/.test(source.slice(start, init.end))) continue;
      edits.push({ at: start, text: CAST_OPEN }, { at: init.end, text: CAST_CLOSE });
    }
  };
  ts.walkPreorder(sf, (node) => {
    if (ts.isVariableStatement(node)) visitList(node.declarationList, node.pos);
    else if (
      ts.isForStatement(node) &&
      node.initializer !== undefined &&
      ts.isVariableDeclarationList(node.initializer)
    )
      visitList(node.initializer, node.initializer.pos);
    return undefined;
  });
  if (edits.length === 0) return null;
  edits.sort((a, b) => a.at - b.at);
  const inserted: InsertedSpan[] = [];
  let text = "";
  let at = 0;
  for (const edit of edits) {
    text += source.slice(at, edit.at);
    inserted.push([text.length, edit.text.length]);
    text += edit.text;
    at = edit.at;
  }
  text += source.slice(at);
  return { text, inserted };
}

/** What the shadow answered for a file's text (null: no cast), so a file
 * the checker reads again is parsed once. */
const answers = new Map<string, { source: string; casts: VoidInitializerCasts | null }>();
/** The spans inserted into each served text of a file. */
const insertedByFile = new Map<string, Map<string, readonly InsertedSpan[]>>();

/** Forgets the casts of the previous program load. */
export function resetVoidInitializerCasts(): void {
  answers.clear();
  insertedByFile.clear();
}

/** The shadow's text for the JavaScript file at `path`, whose text before
 * this shadow is `source`: undefined when the file keeps that text. */
export function voidInitializerShadow(
  path: string,
  text: string,
  cast: (source: string, path: string) => VoidInitializerCasts | null,
): string | undefined {
  if (!isVoidInitializerFile(path) || !mayHoldVoidInitializer(text)) return undefined;
  // The host serves a file without its byte order mark: so are the offsets.
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const key = path.split("\\").join("/");
  const known = answers.get(key);
  let casts: VoidInitializerCasts | null;
  if (known !== undefined && known.source === source) {
    casts = known.casts;
  } else {
    try {
      casts = cast(source, path);
    } catch {
      casts = null; // unparseable: the file keeps its text
    }
    answers.set(key, { source, casts });
  }
  if (casts === null) return undefined;
  let served = insertedByFile.get(key);
  if (served === undefined) insertedByFile.set(key, (served = new Map()));
  served.set(casts.text, casts.inserted);
  return casts.text;
}

/** The spans the shadow inserted into `served`, the text of `file` a
 * diagnostic points into; undefined when the text holds none (another
 * rewrite's text of the file included: its offsets are its own). */
export function voidInitializerInsertions(
  file: string,
  served: string,
): readonly InsertedSpan[] | undefined {
  return insertedByFile.get(file.split("\\").join("/"))?.get(served);
}

/** `diagnostics` with the spans the shadow inserted into the lines of each
 * one's code frame (the diagnostic's line and its two neighbours). A
 * diagnostic of a file without casts is returned as it is. */
export function withInsertedSpans(
  diagnostics: readonly ScrDiagnostic[],
  sourceTexts: ReadonlyMap<string, string>,
): ScrDiagnostic[] {
  if (insertedByFile.size === 0) return diagnostics as ScrDiagnostic[];
  return diagnostics.map((diag) => {
    if (diag.inserted !== undefined) return diag;
    const text = sourceTexts.get(diag.loc.file);
    if (text === undefined) return diag;
    const spans = voidInitializerInsertions(diag.loc.file, text);
    if (spans === undefined) return diag;
    // The frame: from the start of the line before the diagnostic's to the
    // end of the line after it.
    let from = diag.loc.start;
    for (let lines = 0; from > 0; from--) {
      if (text.charCodeAt(from - 1) === 10 && ++lines === 2) break;
    }
    let to = diag.loc.start;
    for (let lines = 0; to < text.length; to++) {
      if (text.charCodeAt(to) === 10 && ++lines === 2) break;
    }
    const inFrame = spans.filter(([start]) => start >= from && start < to);
    return inFrame.length === 0 ? diag : { ...diag, inserted: inFrame };
  });
}
