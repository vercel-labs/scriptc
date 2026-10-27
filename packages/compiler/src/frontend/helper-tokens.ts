/** Token fingerprints for the fixed bundler helpers we recognize. This is
 * deliberately not a JavaScript parser: regexes, templates, escaped names,
 * numbers other than plain decimal integers, and unknown punctuation refuse
 * the helper. None occur in the canonical helpers. Every accepted token is
 * represented in the result; comments and whitespace alone may disappear. */
const operators = [
  ">>>=",
  "===",
  "!==",
  ">>>",
  "**=",
  "&&=",
  "||=",
  "??=",
  "<<=",
  ">>=",
  "...",
  "=>",
  "==",
  "!=",
  "<=",
  ">=",
  "++",
  "--",
  "&&",
  "||",
  "??",
  "**",
  "<<",
  ">>",
  "+=",
  "-=",
  "*=",
  "/=",
  "%=",
  "&=",
  "|=",
  "^=",
  "?.",
];

function hex(text: string): number {
  return /^[0-9a-fA-F]+$/.test(text) ? parseInt(text, 16) : -1;
}

interface QuotedToken {
  end: number;
  value: string;
}

/** Decode string literals without evaluating source. Invalid, unterminated,
 * and legacy octal escapes refuse the match. Line continuations and Unicode
 * escapes use JavaScript's UTF-16 string semantics. */
function quoted(text: string, start: number): QuotedToken | null {
  const quote = text.charAt(start);
  let value = "";
  for (let i = start + 1; i < text.length;) {
    const ch = text.charAt(i++);
    if (ch === quote) return { end: i, value };
    if (ch === "\n" || ch === "\r") return null;
    if (ch !== "\\") {
      value += ch;
      continue;
    }
    if (i === text.length) return null;
    const escape = text.charAt(i++);
    if (escape === "\r") {
      if (text.charAt(i) === "\n") i++;
      continue;
    }
    if (escape === "\n" || escape === "\u2028" || escape === "\u2029") continue;
    if (escape === "x" || escape === "u") {
      let code: number;
      if (escape === "u" && text.charAt(i) === "{") {
        const end = text.indexOf("}", i + 1);
        if (end < 0) return null;
        code = hex(text.slice(i + 1, end));
        i = end + 1;
      } else {
        const size = escape === "x" ? 2 : 4;
        if (i + size > text.length) return null;
        code = hex(text.slice(i, i + size));
        i += size;
      }
      if (code < 0 || code > 0x10ffff) return null;
      value += String.fromCodePoint(code);
    } else if (escape === "0") {
      if (/[0-9]/.test(text.charAt(i))) return null;
      value += "\0";
    } else if (/[1-9]/.test(escape)) {
      return null;
    } else {
      value +=
        escape === "n"
          ? "\n"
          : escape === "r"
            ? "\r"
            : escape === "t"
              ? "\t"
              : escape === "b"
                ? "\b"
                : escape === "f"
                  ? "\f"
                  : escape === "v"
                    ? "\v"
                    : escape;
    }
  }
  return null;
}

function fingerprint(kind: string, text: string): string {
  // Length framing prevents a quoted value containing separators from
  // impersonating several tokens in the canonical stream.
  return kind + text.length + ":" + text + ";";
}

export function helperTokens(text: string): string | null {
  let result = "";
  let previous = "";
  let lineBreak = false;
  for (let i = 0; i < text.length;) {
    const ch = text.charAt(i);
    if (/\s/.test(ch)) {
      if (/[\r\n\u2028\u2029]/.test(ch)) lineBreak = true;
      i++;
      continue;
    }
    if (ch === "/" && text.charAt(i + 1) === "/") {
      i += 2;
      while (i < text.length && !/[\r\n\u2028\u2029]/.test(text.charAt(i))) i++;
      continue;
    }
    if (ch === "/" && text.charAt(i + 1) === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end < 0) return null;
      if (/[\r\n\u2028\u2029]/.test(text.slice(i, end))) lineBreak = true;
      i = end + 2;
      continue;
    }
    // A return followed by a line terminator returns undefined. Ignoring
    // that trivia would recognize a different program as a trusted helper.
    if (
      lineBreak &&
      (previous === "return" ||
        previous === "throw" ||
        previous === "yield" ||
        previous === "async" ||
        text.startsWith("=>", i))
    ) {
      result += "linebreak;";
    }
    lineBreak = false;
    if (ch === "'" || ch === '"') {
      const token = quoted(text, i);
      if (token === null) return null;
      result += fingerprint("s", token.value);
      i = token.end;
      previous = "string";
    } else if (/[0-9]/.test(ch)) {
      // Plain decimal integers only (esbuild's `cb[keys(cb)[0]]`): a
      // legacy octal, fraction, exponent, radix prefix, BigInt suffix or
      // numeric separator refuses rather than aliasing another value.
      const start = i++;
      while (i < text.length && /[0-9]/.test(text.charAt(i))) i++;
      if (/[A-Za-z0-9_$.\\]/.test(text.charAt(i)) || (ch === "0" && i - start > 1)) return null;
      previous = text.slice(start, i);
      result += fingerprint("n", previous);
    } else if (/[A-Za-z_$]/.test(ch)) {
      const start = i++;
      while (i < text.length && /[A-Za-z0-9_$]/.test(text.charAt(i))) i++;
      previous = text.slice(start, i);
      result += fingerprint("t", previous);
    } else {
      let token = "";
      for (const operator of operators) {
        if (text.startsWith(operator, i)) {
          token = operator;
          break;
        }
      }
      if (token === "" && "{}()[];,.?:=+-*%!~&|^<>".includes(ch)) token = ch;
      if (token === "") return null;
      result += fingerprint("t", token);
      previous = token;
      i += token.length;
    }
  }
  return result;
}
