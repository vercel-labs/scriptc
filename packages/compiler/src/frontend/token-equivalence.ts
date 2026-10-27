/* Token equivalence of two versions of a source file, for frontend cache
 * reuse after edits that touch only comments and whitespace.
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

function equivalentSources(
  path: string,
  previous: string,
  current: string,
  positions: boolean,
): boolean {
  if (previous === current) return true;
  const left = scan(path, previous);
  if (left === null) return false;
  const right = scan(path, current);
  if (right === null || left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) {
    const a = left[index]!;
    const b = right[index]!;
    if (a.text !== b.text || a.comment !== b.comment) return false;
    if (index > 0 && a.lineBreakBefore !== b.lineBreakBefore) return false;
  }
  if (!positions) return true;
  const before = tokenPositions(previous, left);
  const after = tokenPositions(current, right);
  return before.every((value, index) => value === after[index]);
}

/** Whether `current` differs from `previous` only in whitespace and in
 * comments that cannot affect compilation. */
export function tokenEquivalentSource(path: string, previous: string, current: string): boolean {
  return equivalentSources(path, previous, current, false);
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
): boolean {
  return equivalentSources(path, previous, current, true);
}
