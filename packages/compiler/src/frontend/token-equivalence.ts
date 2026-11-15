/* Token equivalence of two versions of a source file, for frontend cache
 * reuse after edits that touch only comments and whitespace.
 *
 * The frontend also reads raw text beside the tokens (SourceTextObserver):
 * a node's text, its leading comments, a line number, whether a word occurs
 * in the file. An entry records those reads (SourceTextReads), and two
 * token-equivalent versions are equivalent for it only when every recorded
 * read has the same answer in both. Offsets are carried from one version to
 * the other through the tokens: an offset inside or at the edge of a token
 * keeps its distance from that token's start. An offset that cannot be
 * carried over with certainty makes the versions not equivalent.
 *
 * A file the frontend compiled in another form (SourceTextRewrite: spans
 * blanked, a tail appended) records the rewrite with the reads of that form.
 * The edited version's form is made again from its own text, with the
 * blanks placed by its tokens, and the form's reads are answered over the
 * two forms. An offset in the tail keeps its distance from the tail's start.
 *
 * Two versions are equivalent when they have the same tokens, in the same
 * order, with line breaks between the same pairs of tokens (automatic
 * semicolon insertion depends on them), and differ only in whitespace and
 * in comments that cannot affect compilation. The scanner answers "not
 * equivalent" whenever it cannot classify text with certainty, so a wrong
 * answer can only cost a cache hit:
 *
 * - Every comment in a file that is not TypeScript (`.ts`, `.mts`, `.cts`)
 *   is kept as a token: JavaScript types come from JSDoc. TypeScript
 *   comments are kept when they start with `///` (references and
 *   directives) or contain `@` or `#` (checker directives, JSDoc tags, and
 *   annotations lowering reads).
 * - A `/` starts a regular expression or divides according to the token
 *   before it. After `)` it divides unless the parenthesis closes an `if`,
 *   `while`, `for`, `for await`, or `with` header. After `}`, `++` or
 *   `--` the scanner cannot tell which, so it gives up, as it does for
 *   escaped identifiers, which can spell keywords. After `!` in
 *   TypeScript it divides when the `!` follows an operand on the same line
 *   (a non-null assertion, `x! / 2`) and gives up when that operand is a
 *   `)`, `}`, `++` or `--`.
 * - A `/` with a line break (or a comment that spans lines) since the
 *   previous token gives up: whether automatic semicolon insertion ends the
 *   statement before it decides how it reads.
 * - Template literals track their `${` substitutions on a brace stack.
 * - Any code unit outside ASCII gives up, except inside strings, templates
 *   and comments. So do files that contain whitespace or a line terminator
 *   outside ASCII anywhere (U+2028 and U+2029 end a line comment), JSX
 *   files, and unterminated strings, comments, templates and regular
 *   expressions.
 *
 * The scanner models only what these rules name; anything else makes the
 * versions not equivalent, which rebuilds. */

import type { SourceTextFact, SourceTextReads } from "./input-tracker.js";
import { astLineOfPosition, astLineStarts } from "./ts7/ast-text.js";
import {
  rewrittenSourceText,
  rewrittenTailStart,
  sourceTextPredicateTest,
} from "./ts7/ast-node.js";

interface Token {
  text: string;
  comment: boolean;
  lineBreakBefore: boolean;
  /** The offset of the token's first code unit. */
  start: number;
}

/** Keywords after which `/` starts a regular expression. */
const EXPRESSION_KEYWORDS = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "case",
  "do",
  "else",
  "yield",
  "await",
  "default",
  "extends",
]);

/** Whitespace and line terminators outside ASCII. */
const NON_ASCII_SPACE = /[\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]/;

/** Keywords whose parenthesized header is followed by a statement. */
const HEADER_KEYWORDS = new Set(["if", "while", "for", "with"]);

const PUNCTUATORS = [
  ">>>=",
  "...",
  "===",
  "!==",
  "**=",
  "<<=",
  ">>=",
  ">>>",
  "&&=",
  "||=",
  "??=",
  "=>",
  "==",
  "!=",
  "<=",
  ">=",
  "&&",
  "||",
  "??",
  "?.",
  "++",
  "--",
  "+=",
  "-=",
  "*=",
  "%=",
  "&=",
  "|=",
  "^=",
  "**",
  "<<",
  ">>",
];

function isTypeScript(path: string): boolean {
  return path.endsWith(".ts") || path.endsWith(".mts") || path.endsWith(".cts");
}

function isIdentifierCode(code: number): boolean {
  return (
    (code >= 97 && code <= 122) ||
    (code >= 65 && code <= 90) ||
    (code >= 48 && code <= 57) ||
    code === 36 ||
    code === 95 ||
    code === 92
  );
}

function isLineBreak(code: number): boolean {
  return code === 10 || code === 13;
}

function isSpace(code: number): boolean {
  return code === 32 || code === 9 || code === 11 || code === 12 || isLineBreak(code);
}

/** The tokens of `source`, or null when the scanner cannot classify it. */
function scan(path: string, source: string): Token[] | null {
  if (path.endsWith(".tsx") || path.endsWith(".jsx")) return null;
  if (NON_ASCII_SPACE.test(source)) return null;
  const typeScript = isTypeScript(path);
  const tokens: Token[] = [];
  // Brace kinds: true for a template substitution, false otherwise.
  const braces: boolean[] = [];
  // Paren kinds: true for a statement header.
  const parens: boolean[] = [];
  let lineBreakBefore = false;
  // A line break, or a comment spanning lines, since the last token other
  // than a comment.
  let breakSinceCode = false;
  // The previous token and the one before it, whether a line break came
  // before the previous token, and whether a `)` closed a statement header.
  const last: { token: string | null; before: string | null; broke: boolean } = {
    token: null,
    before: null,
    broke: false,
  };
  let closedHeader = false;
  // Every token ends at `index` when it is pushed.
  const push = (text: string, comment = false): void => {
    tokens.push({ text, comment, lineBreakBefore, start: index - text.length });
    lineBreakBefore = false;
    if (!comment) {
      last.broke = breakSinceCode;
      breakSinceCode = false;
      last.before = last.token;
      last.token = text;
    }
  };
  let index = 0;
  const length = source.length;
  // A shebang is one token.
  if (source.startsWith("#!")) {
    while (index < length && !isLineBreak(source.charCodeAt(index))) index++;
    push(source.slice(0, index));
  }
  /** Scans template text from `index` (after a backtick or a closing
   * substitution brace) through the closing backtick or `${`. */
  const template = (start: number): boolean => {
    let position = index;
    while (position < length) {
      const code = source.charCodeAt(position);
      if (code === 92) {
        position += 2;
        continue;
      }
      if (code === 96) {
        position++;
        index = position;
        push(source.slice(start, position));
        closedHeader = false;
        return true;
      }
      if (code === 36 && source.charCodeAt(position + 1) === 123) {
        position += 2;
        index = position;
        push(source.slice(start, position));
        braces.push(true);
        last.before = last.token;
        last.token = "${";
        return true;
      }
      position++;
    }
    return false;
  };
  while (index < length) {
    const code = source.charCodeAt(index);
    if (isSpace(code)) {
      if (isLineBreak(code)) lineBreakBefore = breakSinceCode = true;
      index++;
      continue;
    }
    // Outside strings, templates and comments, the scanner models ASCII only.
    if (code > 127) return null;
    const next = source.charCodeAt(index + 1);
    // Comments.
    if (code === 47 && (next === 47 || next === 42)) {
      const start = index;
      if (next === 47) {
        while (index < length && !isLineBreak(source.charCodeAt(index))) index++;
      } else {
        const end = source.indexOf("*/", index + 2);
        if (end < 0) return null;
        index = end + 2;
      }
      const text = source.slice(start, index);
      const semantic =
        !typeScript || text.startsWith("///") || text.includes("@") || text.includes("#");
      const multiline = /[\r\n]/.test(text);
      if (multiline) breakSinceCode = true;
      if (semantic) push(text, true);
      else if (multiline) lineBreakBefore = true;
      continue;
    }
    // Strings.
    if (code === 34 || code === 39) {
      const start = index;
      index++;
      while (index < length) {
        const inner = source.charCodeAt(index);
        if (inner === 92) {
          index += 2;
          continue;
        }
        if (isLineBreak(inner)) return null;
        index++;
        if (inner === code) break;
        if (index >= length) return null;
      }
      if (source.charCodeAt(index - 1) !== code || index - start < 2) return null;
      push(source.slice(start, index));
      closedHeader = false;
      continue;
    }
    // Templates.
    if (code === 96) {
      const start = index;
      index++;
      if (!template(start)) return null;
      continue;
    }
    // Identifiers, keywords and numbers.
    if (isIdentifierCode(code) || (code === 46 && next >= 48 && next <= 57)) {
      const start = index;
      index++;
      while (index < length) {
        const inner = source.charCodeAt(index);
        if (isIdentifierCode(inner) || inner === 46) {
          // A dot continues only a number (`1.5`), not member access.
          if (inner === 46) {
            const first = source.charCodeAt(start);
            if (!((first >= 48 && first <= 57) || first === 46)) break;
          }
          index++;
          continue;
        }
        // Exponent signs (`1e-5`).
        if (
          (inner === 43 || inner === 45) &&
          (source.charCodeAt(index - 1) === 101 || source.charCodeAt(index - 1) === 69)
        ) {
          const first = source.charCodeAt(start);
          if ((first >= 48 && first <= 57) || first === 46) {
            index++;
            continue;
          }
        }
        break;
      }
      const word = source.slice(start, index);
      // An escaped identifier can spell a keyword (`\u0072eturn`).
      if (word.includes("\\")) return null;
      push(word);
      closedHeader = false;
      continue;
    }
    // Division or a regular expression.
    if (code === 47) {
      if (breakSinceCode) return null;
      const before = last.token;
      let regex: boolean;
      if (before === null) regex = true;
      else if (before === "}") return null;
      else if (before === ")") regex = closedHeader;
      // `++/re/.lastIndex` is valid, `x++ / 2` too.
      else if (before === "++" || before === "--") return null;
      else if (before === "]") regex = false;
      else if (/^[A-Za-z0-9_$\\]/.test(before)) regex = EXPRESSION_KEYWORDS.has(before);
      else if (before.startsWith("'") || before.startsWith('"') || before.endsWith("`"))
        regex = false;
      else if (before.startsWith("/") && before.length > 1 && before !== "/=") regex = false;
      else if (before === "!" && typeScript && !last.broke && last.before !== null) {
        // `x! / 2` divides: a `!` right after an operand on the same line is
        // a non-null assertion. `!/re/.test(s)` negates a regular expression.
        const operand = last.before;
        if (operand === ")" || operand === "}" || operand === "++" || operand === "--") return null;
        regex = !(
          operand === "]" ||
          operand.startsWith("'") ||
          operand.startsWith('"') ||
          operand.endsWith("`") ||
          (/^[A-Za-z0-9_$]/.test(operand) && !EXPRESSION_KEYWORDS.has(operand))
        );
      } else regex = true;
      if (regex) {
        const start = index;
        index++;
        let inClass = false;
        while (index < length) {
          const inner = source.charCodeAt(index);
          if (isLineBreak(inner) || inner > 127) return null;
          if (inner === 92) {
            index += 2;
            continue;
          }
          if (inner === 91) inClass = true;
          else if (inner === 93) inClass = false;
          else if (inner === 47 && !inClass) break;
          index++;
        }
        if (index >= length) return null;
        index++;
        while (index < length && isIdentifierCode(source.charCodeAt(index))) index++;
        push(source.slice(start, index));
        closedHeader = false;
        continue;
      }
      const text = next === 61 ? "/=" : "/";
      index += text.length;
      push(text);
      closedHeader = false;
      continue;
    }
    // Brackets.
    if (code === 40) {
      parens.push(
        last.token !== null &&
          (HEADER_KEYWORDS.has(last.token) || (last.token === "await" && last.before === "for")),
      );
      index++;
      push("(");
      closedHeader = false;
      continue;
    }
    if (code === 41) {
      const header = parens.pop() ?? false;
      index++;
      push(")");
      closedHeader = header;
      continue;
    }
    if (code === 123) {
      braces.push(false);
      index++;
      push("{");
      closedHeader = false;
      continue;
    }
    if (code === 125) {
      if (braces.pop() === true) {
        const start = index;
        index++;
        if (!template(start)) return null;
        continue;
      }
      index++;
      push("}");
      closedHeader = false;
      continue;
    }
    // Other punctuators.
    let text = source[index]!;
    for (const punctuator of PUNCTUATORS)
      if (source.startsWith(punctuator, index)) {
        text = punctuator;
        break;
      }
    index += text.length;
    push(text);
    closedHeader = false;
  }
  if (braces.length !== 0 || parens.length !== 0) return null;
  return tokens;
}

/** The line and column of each token's start, with the line terminators
 * source locations count (backend/source-locations.ts). */
function tokenPositions(source: string, tokens: readonly Token[]): number[] {
  const positions: number[] = [];
  let line = 0;
  let lineStart = 0;
  let offset = 0;
  for (const token of tokens) {
    for (; offset < token.start; offset++) {
      const code = source.charCodeAt(offset);
      if (code === 13 && source.charCodeAt(offset + 1) === 10) offset++;
      if (code === 10 || code === 13 || code === 0x2028 || code === 0x2029) {
        line++;
        lineStart = offset + 1;
      }
    }
    positions.push(line, token.start - lineStart);
  }
  return positions;
}

/** How an offset is anchored: at the start of a token, at the place the
 * token before it ended (the start of the text when there is none), or
 * unknown. */
type Anchor = "start" | "end" | "any";

/** The offset in `current` of the place `offset` names in `previous`, two
 * versions with the same tokens (`left` and `right`), or -1 when the place
 * is not certain. An offset strictly within a token keeps its distance from
 * the token's start. Otherwise the anchor decides: the start of the token
 * that starts there, or the end of the token that ends there. The start of
 * the text is an end anchor too (nothing came before it), and its end is
 * both (the text ends there and the end-of-file token starts there); where
 * a token touches the end of the text, both readings must be one offset in
 * `current`. An offset anchored where no such token is, in the whitespace
 * and dropped comments between two tokens, has no counterpart. With an
 * unknown anchor every reading must be one offset. */
function carriedOffset(
  offset: number,
  anchor: Anchor,
  previous: string,
  current: string,
  left: readonly Token[],
  right: readonly Token[],
): number {
  let carried = -1;
  let certain = true;
  const place = (candidate: number): void => {
    if (carried === -1) carried = candidate;
    else if (carried !== candidate) certain = false;
  };
  // The last token that starts at or before the offset.
  let low = 0;
  let high = left.length - 1;
  while (low <= high) {
    const middle = low + ((high - low) >> 1);
    if (left[middle]!.start <= offset) low = middle + 1;
    else high = middle - 1;
  }
  const index = low - 1;
  const token = index >= 0 ? left[index]! : undefined;
  if (token !== undefined && offset > token.start && offset < token.start + token.text.length) {
    return right[index]!.start + (offset - token.start);
  }
  // The token that starts here, and the one that ends here.
  const starts = token !== undefined && token.start === offset ? index : -1;
  const before = starts >= 0 ? index - 1 : index;
  const ends =
    before >= 0 && left[before]!.start + left[before]!.text.length === offset ? before : -1;
  if (anchor !== "end" && starts >= 0) place(right[starts]!.start);
  if (anchor !== "start" && ends >= 0) place(right[ends]!.start + left[ends]!.text.length);
  // The edges of the text: its start is where "the token before" ended, and
  // its end is where the end-of-file token starts and where the text ends.
  if (offset === 0 && anchor !== "start") place(0);
  if (offset === previous.length) place(current.length);
  return certain ? carried : -1;
}

/** One set of reads: of a file's text, or of the form it was compiled in. */
interface TextReadSet {
  ranges: number[];
  positions: number[];
  facts: SourceTextFact[];
}

/** `reads`, recorded of `previous`, as reads of `current`: every offset
 * carried over by `carry`, when every read has the same answer over both
 * texts. Else the first read that does not, in words. */
function carriedReadSet(
  reads: TextReadSet,
  previous: string,
  current: string,
  carry: (offset: number, anchor: Anchor) => number,
): TextReadSet | string {
  /** An anchored range in both versions: its texts and its anchored offsets
   * in `current`, or null. */
  const range = (
    anchoredStart: number,
    anchoredEnd: number,
  ): { before: string; after: string; start: number; end: number } | null => {
    const start = Math.floor(anchoredStart / 2);
    const end = Math.floor(anchoredEnd / 2);
    if (start > end || end > previous.length) return null;
    const newStart = carry(start, anchoredStart % 2 === 1 ? "start" : "end");
    const newEnd = carry(end, anchoredEnd % 2 === 1 ? "start" : "end");
    if (newStart < 0 || newEnd < newStart) return null;
    return {
      before: previous.substring(start, end),
      after: current.substring(newStart, newEnd),
      start: newStart * 2 + (anchoredStart % 2),
      end: newEnd * 2 + (anchoredEnd % 2),
    };
  };
  const carried: TextReadSet = { ranges: [], positions: [], facts: [] };
  for (const fact of reads.facts) {
    // A recorded answer is the one over `previous`; a predicate that no
    // longer gives it there cannot be replayed.
    const test = sourceTextPredicateTest(fact.predicate);
    const same = (before: string, after: string, result: boolean): boolean =>
      test(before) === result && test(after) === result;
    const asked =
      fact.predicate.kind === "includes"
        ? `whether it includes ${JSON.stringify(fact.predicate.needle)}`
        : `whether /${fact.predicate.source}/${fact.predicate.flags} matches it`;
    if (fact.whole !== undefined && !same(previous, current, fact.whole))
      return `the frontend asked of the text ${asked}`;
    const lists: [number[], number[]] = [[], []];
    for (const [list, result, to] of [
      [fact.yes, true, lists[0]],
      [fact.no, false, lists[1]],
    ] as const) {
      for (let index = 0; index + 1 < list.length; index += 2) {
        const found = range(list[index]!, list[index + 1]!);
        if (found === null || !same(found.before, found.after, result))
          return `the frontend asked of the text at offset ${Math.floor(list[index]! / 2)} ${asked}`;
        to.push(found.start, found.end);
      }
    }
    carried.facts.push({
      predicate: fact.predicate,
      ...(fact.whole === undefined ? {} : { whole: fact.whole }),
      yes: lists[0],
      no: lists[1],
    });
  }
  for (let index = 0; index + 1 < reads.ranges.length; index += 2) {
    const found = range(reads.ranges[index]!, reads.ranges[index + 1]!);
    if (found === null || found.before !== found.after)
      return `the frontend read the text at offset ${Math.floor(reads.ranges[index]! / 2)}`;
    carried.ranges.push(found.start, found.end);
  }
  if (reads.positions.length === 0) return carried;
  // Lines as the syntax tree counts them (AstNode.getLineAndCharacterOfPosition).
  const before = astLineStarts(previous);
  const after = astLineStarts(current);
  for (const position of reads.positions) {
    const moved = `the frontend read the line and column of offset ${position}`;
    if (position > previous.length) return moved;
    const place = carry(position, "any");
    if (place < 0) return moved;
    const line = astLineOfPosition(before, position);
    if (line !== astLineOfPosition(after, place)) return moved;
    if (position - before[line]! !== place - after[line]!) return moved;
    carried.positions.push(place);
  }
  return carried;
}

/** `reads`, the reads recorded of `previous`, as reads of `current`, a
 * version with the same tokens: every offset carried over, when every read
 * has the same answer over both. Else the first read that does not, in
 * words. The reads of a rewritten form are answered over the forms of the
 * two versions; with `positions`, the form's tail must also start at the
 * same line in both, since the tokens of the tail have positions too. */
function carriedTextReads(
  reads: SourceTextReads,
  previous: string,
  current: string,
  left: readonly Token[],
  right: readonly Token[],
  positions: boolean,
): SourceTextReads | string {
  const carry = (offset: number, anchor: Anchor): number =>
    carriedOffset(offset, anchor, previous, current, left, right);
  const carried = carriedReadSet(reads, previous, current, carry);
  if (typeof carried === "string") return carried;
  const form = reads.rewritten;
  if (form === undefined) return carried;
  // The blanks, placed in `current` by its tokens.
  const blanks: number[] = [];
  let at = 0;
  for (let index = 0; index + 1 < form.blanks.length; index += 2) {
    const start = carry(form.blanks[index]! >> 1, form.blanks[index]! % 2 === 1 ? "start" : "end");
    const end = carry(
      form.blanks[index + 1]! >> 1,
      form.blanks[index + 1]! % 2 === 1 ? "start" : "end",
    );
    if (start < at || end < start)
      return "the frontend compiled a rewritten form of it, and a rewritten span cannot be placed in the new text";
    blanks.push(start * 2 + (form.blanks[index]! % 2), end * 2 + (form.blanks[index + 1]! % 2));
    at = end;
  }
  const formBefore = rewrittenSourceText(previous, form);
  const rewrite = { blanks, tail: form.tail };
  const formAfter = rewrittenSourceText(current, rewrite);
  // Below the tail an offset of the form is an offset of the text, and the
  // form's tokens there are tokens of the text. The tail moves as a whole.
  const tailBefore = rewrittenTailStart(previous, form);
  const tailAfter = rewrittenTailStart(current, rewrite);
  const carryForm = (offset: number, anchor: Anchor): number =>
    form.tail !== "" && offset >= tailBefore
      ? offset - tailBefore + tailAfter
      : carry(offset, anchor);
  const carriedForm = carriedReadSet(form, formBefore, formAfter, carryForm);
  if (typeof carriedForm === "string") return `in its rewritten form, ${carriedForm}`;
  if (positions && form.tail !== "") {
    const lineBefore = astLineOfPosition(astLineStarts(formBefore), tailBefore);
    if (lineBefore !== astLineOfPosition(astLineStarts(formAfter), tailAfter))
      return "the declarations the frontend added after its last line moved, and the build records source positions";
  }
  return { ...carried, rewritten: { ...rewrite, ...carriedForm } };
}

/** An edit that is equivalent: the reads recorded of the previous text, as
 * reads of the current one (undefined when none were recorded). */
export interface EquivalentSourceEdit {
  reads: SourceTextReads | undefined;
}

/** The equivalent edit from `previous` to `current`, or why it is not one. */
function sourceEdit(
  path: string,
  previous: string,
  current: string,
  positions: boolean,
  reads: SourceTextReads | undefined,
): EquivalentSourceEdit | string {
  if (previous === current) return { reads };
  const left = scan(path, previous);
  const right = left === null ? null : scan(path, current);
  if (left === null || right === null) return "its text cannot be compared token by token";
  if (left.length !== right.length) return "its tokens changed";
  for (let index = 0; index < left.length; index++) {
    const a = left[index]!;
    const b = right[index]!;
    if (a.text !== b.text || a.comment !== b.comment) return "its tokens changed";
    if (index > 0 && a.lineBreakBefore !== b.lineBreakBefore)
      return "a line break between two tokens changed";
  }
  const carried =
    reads === undefined
      ? undefined
      : carriedTextReads(reads, previous, current, left, right, positions);
  if (typeof carried === "string") return carried;
  if (positions) {
    const before = tokenPositions(previous, left);
    const after = tokenPositions(current, right);
    if (!before.every((value, index) => value === after[index]))
      return "a token moved, and the build records source positions";
  }
  return { reads: carried };
}

/** The edit from `previous` to `current` when it is equivalent, else null:
 * the versions differ only in whitespace and in comments that cannot affect
 * compilation, every read `reads` records of the raw text of `previous` has
 * the same answer over `current`, and, with `positions`, every token keeps
 * its line and column (the source positions debug information records). The
 * edit carries the reads over to `current`, so that the entry it refreshes
 * describes the text it now holds. */
export function equivalentSourceEdit(
  path: string,
  previous: string,
  current: string,
  positions: boolean,
  reads?: SourceTextReads,
): EquivalentSourceEdit | null {
  const edit = sourceEdit(path, previous, current, positions, reads);
  return typeof edit === "string" ? null : edit;
}

/** Why the edit from `previous` to `current` is not equivalent
 * (equivalentSourceEdit), or null when it is: the reason a rebuild after a
 * comment or whitespace edit ran the frontend. */
export function sourceEditDifference(
  path: string,
  previous: string,
  current: string,
  positions: boolean,
  reads?: SourceTextReads,
): string | null {
  const edit = sourceEdit(path, previous, current, positions, reads);
  return typeof edit === "string" ? edit : null;
}

/** Whether `current` differs from `previous` only in whitespace and in
 * comments that cannot affect compilation, and every read `reads` records
 * of the raw text of `previous` has the same answer over `current`. */
export function tokenEquivalentSource(
  path: string,
  previous: string,
  current: string,
  reads?: SourceTextReads,
): boolean {
  return equivalentSourceEdit(path, previous, current, false, reads) !== null;
}

/** Whether `current` is token-equivalent to `previous` (tokenEquivalentSource)
 * and every token keeps its line and column: the edit leaves the source
 * positions debug information records unchanged (a comment's text within
 * its line, comments and whitespace after the last token, trailing
 * whitespace). */
export function tokenPositionEquivalentSource(
  path: string,
  previous: string,
  current: string,
  reads?: SourceTextReads,
): boolean {
  return equivalentSourceEdit(path, previous, current, true, reads) !== null;
}
