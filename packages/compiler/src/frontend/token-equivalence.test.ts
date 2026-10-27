import { expect, test } from "vitest";
import { tokenEquivalentSource, tokenPositionEquivalentSource } from "./token-equivalence.js";

const equivalent = (previous: string, current: string, path = "/src/a.ts") =>
  tokenEquivalentSource(path, previous, current);
const positionEquivalent = (previous: string, current: string, path = "/src/a.ts") =>
  tokenPositionEquivalentSource(path, previous, current);

test("whitespace and plain comments are trivia", () => {
  expect(equivalent("const a = 1;\n", "const a = 1; // one\n")).toBe(true);
  expect(equivalent("f(a,b);\n", "f( a, /* first */ b );\n")).toBe(true);
  expect(equivalent("const s = `x${a}y`;\n", "const s = `x${ a /* the value */ }y`;\n")).toBe(true);
});

test("tokens, literals and line breaks that change semicolon insertion are not", () => {
  expect(equivalent("const a = 1;\n", "const a = 2;\n")).toBe(false);
  expect(equivalent('const s = "a // b";\n', 'const s = "a // c";\n')).toBe(false);
  expect(equivalent("const s = `a // ${b} /* c */`;\n", "const s = `a // ${b} /* d */`;\n")).toBe(
    false,
  );
  // `return` followed by a line break returns undefined.
  expect(equivalent("return a;\n", "return\na;\n")).toBe(false);
  expect(equivalent("return a;\n", "return /*\n*/ a;\n")).toBe(false);
});

test("comment-like text inside regular expressions is code", () => {
  expect(equivalent("const r = /[//]/; x = 1;\n", "const r = /[//]/; x = 2;\n")).toBe(false);
  expect(equivalent("if (a) /\\/*/.test(b); c = 1;\n", "if (a) /\\/*/.test(b); c = 2;\n")).toBe(
    false,
  );
  expect(equivalent("const q = a / b; // ratio\n", "const q = a / b; // the ratio\n")).toBe(true);
  expect(equivalent("return /a/; // one\n", "return /a/; // two\n")).toBe(true);
  // A `for await` header closes like a `for` header.
  expect(
    equivalent(
      "for await (const x of xs) /[//]/.test(x); c = 1;\n",
      "for await (const x of xs) /[//]/.test(x); c = 2;\n",
    ),
  ).toBe(false);
});

test("a / after a line break is never equivalent", () => {
  const loop = (body: string) => `a: for (;;) {\n${body}\n}\n`;
  // Automatic semicolon insertion decides whether these start a regular
  // expression.
  expect(
    equivalent(loop("break\n/[//]/.test(x); c = 1;"), loop("break\n/[//]/.test(x); c = 2;")),
  ).toBe(false);
  expect(
    equivalent(loop("break a\n/[//]/.test(x); c = 1;"), loop("break a\n/[//]/.test(x); c = 2;")),
  ).toBe(false);
  expect(
    equivalent("type A = B\n/[//]/.test(x); c = 1;\n", "type A = B\n/[//]/.test(x); c = 2;\n"),
  ).toBe(false);
  // A comment spanning lines separates them too; JavaScript keeps its comments as tokens.
  expect(
    equivalent(
      "x\n/* a\n */ /[//]/.test(y); c = 1;\n",
      "x\n/* a\n */ /[//]/.test(y); c = 2;\n",
      "/src/a.js",
    ),
  ).toBe(false);
  // A / on the line of the token before it still divides.
  expect(equivalent(loop("continue\nx / 2; // one"), loop("continue\nx / 2; // two"))).toBe(true);
});

test("code units outside ASCII are equivalent only inside strings, templates and comments", () => {
  expect(equivalent('const s = "é"; // one\n', 'const s = "é"; // two\n')).toBe(true);
  expect(equivalent("const s = `é${a}`; // one\n", "const s = `é${a}`; // two\n")).toBe(true);
  expect(equivalent("const a = 1; // é\n", "const a = 1; // è\n")).toBe(true);
  expect(equivalent("const café = 1; // one\n", "const café = 1; // two\n")).toBe(false);
  expect(
    equivalent(
      "ä: for (;;) { break ä\n/[//]/.test(x); c = 1; }\n",
      "ä: for (;;) { break ä\n/[//]/.test(x); c = 2; }\n",
    ),
  ).toBe(false);
  expect(equivalent("const r = /é/; // one\n", "const r = /é/; // two\n")).toBe(false);
});

test("whitespace outside ASCII is never equivalent", () => {
  expect(
    equivalent("return\u3000/[//]/.test(x); c = 1;\n", "return\u3000/[//]/.test(x); c = 2;\n"),
  ).toBe(false);
  expect(equivalent("const a = 1;\u00a0// one\n", "const a = 1;\u00a0// two\n")).toBe(false);
});

test("U+2028 and U+2029 end a line comment, so their files are never equivalent", () => {
  expect(equivalent("// a\u2028c = 1;\n", "// a\u2028c = 2;\n")).toBe(false);
  expect(equivalent("/* a\u2029*/ c = 1;\n", "/* b\u2029*/ c = 1;\n")).toBe(false);
});

test("comments that can affect compilation are kept", () => {
  expect(equivalent("/** @type {number} */ let a;\n", "/** @type {string} */ let a;\n")).toBe(
    false,
  );
  expect(equivalent("// @ts-ignore\nf();\n", "f();\n")).toBe(false);
  expect(equivalent('/// <reference path="a.d.ts" />\n', "\n")).toBe(false);
  // Every comment is kept in JavaScript, whose types come from JSDoc.
  expect(equivalent("let a; // one\n", "let a; // two\n", "/src/a.js")).toBe(false);
});

test("text the scanner cannot classify is never equivalent", () => {
  expect(equivalent("x = {} / 2; // a\n", "x = {} / 2; // b\n")).toBe(false);
  expect(equivalent("++/a/.lastIndex; // a\n", "++/a/.lastIndex; // b\n")).toBe(false);
  expect(equivalent("const \\u0061 = 1; // a\n", "const \\u0061 = 1; // b\n")).toBe(false);
  expect(equivalent("const a = <b/>; // a\n", "const a = <b/>; // b\n", "/src/a.tsx")).toBe(false);
  expect(equivalent('const s = "open\n', 'const s = "open // \n')).toBe(false);
});

test("a / after a non-null assertion divides", () => {
  expect(
    equivalent("const q = data[i]! / 7; // ratio\n", "const q = data[i]! / 7; // the ratio\n"),
  ).toBe(true);
  expect(
    equivalent("const q = value! / 7; // ratio\n", "const q = value! / 7; // the ratio\n"),
  ).toBe(true);
  expect(equivalent("const q = this! / 7; // ratio\n", "const q = this! / 7; // the ratio\n")).toBe(
    true,
  );
  // A prefix `!` negates a regular expression, whose `//` is code.
  expect(
    equivalent("const t = !/[//]/.test(s); c = 1;\n", "const t = !/[//]/.test(s); c = 2;\n"),
  ).toBe(false);
  expect(equivalent("return !/[//]/.test(s); // one\n", "return !/[//]/.test(s); // two\n")).toBe(
    true,
  );
  // After a line break, `!` starts a new expression.
  expect(equivalent("a\n!/[//]/.test(s); c = 1;\n", "a\n!/[//]/.test(s); c = 2;\n")).toBe(false);
  // `f()!` and `if (a) !` read the same up to the `/`.
  expect(equivalent("const q = f()! / 2; // one\n", "const q = f()! / 2; // two\n")).toBe(false);
});

test("position equivalence also keeps every token's line and column", () => {
  const source = "const a = 1; // one\nconst b = a; /* two */ f(b);\n";
  // A comment's text within its line, after the line's last token.
  expect(
    positionEquivalent(source, "const a = 1; // the first\nconst b = a; /* two */ f(b);\n"),
  ).toBe(true);
  // Comments and whitespace after the last token, and trailing whitespace.
  expect(positionEquivalent(source, source + "// appended\n\n")).toBe(true);
  expect(
    positionEquivalent(source, "const a = 1;   // one\nconst b = a; /* two */ f(b);  \n"),
  ).toBe(true);
  expect(positionEquivalent(source, source.replaceAll("\n", "\r\n"))).toBe(true);
  // A longer comment before a token moves its column; a new line moves the
  // lines below it. Both stay token-equivalent.
  const column = "const a = 1; // one\nconst b = a; /* the second */ f(b);\n";
  const line = "// header\nconst a = 1; // one\nconst b = a; /* two */ f(b);\n";
  expect(positionEquivalent(source, column)).toBe(false);
  expect(positionEquivalent(source, line)).toBe(false);
  expect(equivalent(source, column)).toBe(true);
  expect(equivalent(source, line)).toBe(true);
  // A token edit is never equivalent.
  expect(positionEquivalent(source, source.replace("1", "2"))).toBe(false);
});
