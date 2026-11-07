import { expect, test } from "vitest";
import type { SourceTextReads } from "./input-tracker.js";
import {
  equivalentSourceEdit,
  sourceEditDifference,
  tokenEquivalentSource,
  tokenPositionEquivalentSource,
} from "./token-equivalence.js";

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

/* Reads of the raw text beside the tokens (SourceTextReads). Offsets in a
 * range are doubled, plus one at the start of a token. */
const atStart = (offset: number) => offset * 2 + 1;
const atEnd = (offset: number) => offset * 2;
const sameReads = (
  previous: string,
  current: string,
  reads: Partial<SourceTextReads>,
  path = "/src/a.ts",
) =>
  tokenEquivalentSource(path, previous, current, {
    ranges: [],
    positions: [],
    facts: [],
    ...reads,
  });

test("a node's text that was read must be spelled the same", () => {
  const previous = "const a = f(x, y);\n";
  // `f(x, y)`, from the start of `f` to the end of `)`.
  const reads = { ranges: [atStart(10), atEnd(17)] };
  expect(sameReads(previous, "// lead\nconst a = f(x, y); // trail\n", reads)).toBe(true);
  expect(sameReads(previous, "const  a  =  f(x, y)  ;\n", reads)).toBe(true);
  expect(sameReads(previous, "const a = f(x,  y);\n", reads)).toBe(false);
  expect(sameReads(previous, "const a = f(x, /* second */ y);\n", reads)).toBe(false);
  // Without the read, both are plain trivia edits.
  expect(equivalent(previous, "const a = f(x, /* second */ y);\n")).toBe(true);
});

test("leading comments that were read must stay, and others may change", () => {
  const previous = "// note\nfunction f() {}\n// after\nf();\n";
  // From the start of the text (where the token before `function` ended) to
  // the start of `function`.
  const reads = { ranges: [atEnd(0), atStart(8)] };
  expect(sameReads(previous, "// note\nfunction f() {}\n// later\nf();\n", reads)).toBe(true);
  expect(sameReads(previous, "// remark\nfunction f() {}\n// after\nf();\n", reads)).toBe(false);
  expect(sameReads(previous, "// top\n// note\nfunction f() {}\n// after\nf();\n", reads)).toBe(
    false,
  );
});

test("an offset at the start of the text is the first token's start or the text's own", () => {
  const previous = "export const a = 1;\n";
  const current = "// header\nexport const a = 1;\n";
  // The statement's own text starts at its first token: a header moves it.
  expect(sameReads(previous, current, { ranges: [atStart(0), atEnd(19)] })).toBe(true);
  // The statement with its leading trivia starts where the text does.
  expect(sameReads(previous, current, { ranges: [atEnd(0), atEnd(19)] })).toBe(false);
  // The whole text: its end is the end of the text in both versions.
  expect(sameReads(previous, previous + "// end\n", { ranges: [atEnd(0), atEnd(20)] })).toBe(false);
  expect(sameReads(previous, "export  const a = 1;\n", { ranges: [atEnd(20), atEnd(20)] })).toBe(
    true,
  );
});

test("a line and character that were read must stay", () => {
  const previous = "const a = 1;\nconst b = 2;\n";
  // The start of the second `const`.
  const reads = { positions: [13] };
  expect(sameReads(previous, "const a = 1; // one\nconst b = 2;\n// end\n", reads)).toBe(true);
  expect(sameReads(previous, "const a = 1;\nconst b = 2; /* two */\n", reads)).toBe(true);
  expect(sameReads(previous, "// top\nconst a = 1;\nconst b = 2;\n", reads)).toBe(false);
  expect(sameReads(previous, "const a = 1;\n  const b = 2;\n", reads)).toBe(false);
  // Lines end as the syntax tree counts them: CR LF is one line break.
  expect(sameReads("a;\r\nb;\r\n", "a; // one\r\nb;\r\n", { positions: [4] })).toBe(true);
});

test("a position where two tokens touch must still be one place", () => {
  const previous = "f(x);\n";
  // Offset 1 ends `f` and starts `(`.
  expect(sameReads(previous, "f(x); // call\n", { positions: [1] })).toBe(true);
  expect(sameReads(previous, "f (x);\n", { positions: [1] })).toBe(false);
  // An anchored offset says which token it belongs to.
  expect(sameReads(previous, "f (x);\n", { ranges: [atStart(0), atEnd(1)] })).toBe(true);
  expect(sameReads(previous, "f (x);\n", { ranges: [atStart(1), atEnd(4)] })).toBe(true);
});

test("an offset inside a token keeps its place in the token", () => {
  const previous = "const value = 1;\n";
  // `val`, within the identifier.
  const reads = { ranges: [atStart(6), atEnd(9)], positions: [8] };
  expect(sameReads(previous, "const  value = 1; // one\n", reads)).toBe(false);
  expect(sameReads(previous, "const value  =  1; // one\n", reads)).toBe(true);
});

test("an offset between tokens has no counterpart", () => {
  const previous = "a;  b;\n";
  // Offset 3 is inside the two spaces.
  expect(sameReads(previous, "a;  b; // end\n", { positions: [3] })).toBe(false);
  expect(sameReads(previous, "a;  b; // end\n", { ranges: [atStart(0), atEnd(3)] })).toBe(false);
  // An anchor that names no token: offset 2 ends `;` and starts nothing.
  expect(sameReads(previous, "a;  b; // end\n", { ranges: [atStart(2), atEnd(5)] })).toBe(false);
  expect(sameReads(previous, "a;  b; // end\n", { ranges: [atEnd(2), atStart(4)] })).toBe(true);
});

test("a predicate over the whole text must give the answer it gave", () => {
  const previous = "await value;\n";
  const reads = (whole: boolean): Partial<SourceTextReads> => ({
    facts: [
      {
        predicate: { kind: "matches", source: "\\bthen\\s*:", flags: "m" },
        whole,
        yes: [],
        no: [],
      },
    ],
  });
  expect(sameReads(previous, "await value; // settled\n", reads(false))).toBe(true);
  // A comment a text scan matches.
  expect(sameReads(previous, "await value; // then: settled\n", reads(false))).toBe(false);
  expect(equivalent(previous, "await value; // then: settled\n")).toBe(true);
  // An answer the previous text does not give cannot be replayed.
  expect(sameReads(previous, "await value; // settled\n", reads(true))).toBe(false);
  const includes = (whole: boolean): Partial<SourceTextReads> => ({
    facts: [{ predicate: { kind: "includes", needle: "spawn" }, whole, yes: [], no: [] }],
  });
  expect(sameReads("spawn();\n", "spawn(); // start\n", includes(true))).toBe(true);
  expect(sameReads("run();\n", "run(); // not spawn\n", includes(false))).toBe(false);
});

test("a predicate over a range depends on that range only", () => {
  const previous = "// note\nconst a = 1;\n// tail\n";
  // The trivia that leads up to `const`.
  const reads = (needle: string, result: boolean): Partial<SourceTextReads> => ({
    facts: [
      {
        predicate: { kind: "includes", needle },
        yes: result ? [atEnd(0), atStart(8)] : [],
        no: result ? [] : [atEnd(0), atStart(8)],
      },
    ],
  });
  expect(sameReads(previous, "// remark\nconst a = 1;\n// tail\n", reads("TODO", false))).toBe(
    true,
  );
  expect(sameReads(previous, "// TODO\nconst a = 1;\n// tail\n", reads("TODO", false))).toBe(false);
  expect(sameReads(previous, "// note\nconst a = 1;\n// TODO\n", reads("TODO", false))).toBe(true);
  expect(sameReads(previous, "// remark\nconst a = 1;\n// tail\n", reads("note", true))).toBe(
    false,
  );
});

test("position equivalence checks the reads too", () => {
  const previous = "f(a);\n";
  const current = "f(a); // call\n";
  expect(tokenPositionEquivalentSource("/src/a.ts", previous, current)).toBe(true);
  expect(
    tokenPositionEquivalentSource("/src/a.ts", previous, current, {
      ranges: [atEnd(0), atEnd(6)],
      positions: [],
      facts: [],
    }),
  ).toBe(false);
});

test("an equivalent edit carries the reads over to the edited text", () => {
  const previous = "// one\nconst a = f(x, y);\n";
  const reads: SourceTextReads = {
    // `f(x, y)`.
    ranges: [atStart(17), atEnd(24)],
    // The start of `a`.
    positions: [13],
    facts: [
      { predicate: { kind: "includes", needle: "then" }, whole: false, yes: [], no: [] },
      // The trivia that leads up to `const`.
      { predicate: { kind: "includes", needle: "@type" }, yes: [], no: [atEnd(0), atStart(7)] },
    ],
  };
  const current = "// one longer\nconst a = f(x, y); // trail\n";
  const edit = equivalentSourceEdit("/src/a.ts", previous, current, false, reads);
  expect(edit).toEqual({
    reads: {
      ranges: [atStart(24), atEnd(31)],
      positions: [20],
      facts: [
        { predicate: { kind: "includes", needle: "then" }, whole: false, yes: [], no: [] },
        { predicate: { kind: "includes", needle: "@type" }, yes: [], no: [atEnd(0), atStart(14)] },
      ],
    },
  });
  // The carried reads describe the edited text: a later edit inside the
  // call is compared at the call's place in it.
  const inside = "// one longer\nconst a = f(x,  y); // trail\n";
  expect(equivalentSourceEdit("/src/a.ts", current, inside, false, edit!.reads)).toBeNull();
  expect(sourceEditDifference("/src/a.ts", current, inside, false, edit!.reads)).toBe(
    "the frontend read the text at offset 24",
  );
  const outside = "// one\nconst a = f(x, y);\n// end\n";
  expect(equivalentSourceEdit("/src/a.ts", current, outside, false, edit!.reads)).toEqual({
    reads,
  });
  // No reads recorded, none carried; equal texts keep theirs.
  expect(equivalentSourceEdit("/src/a.ts", previous, current, false)).toEqual({ reads: undefined });
  expect(equivalentSourceEdit("/src/a.ts", previous, previous, false, reads)).toEqual({ reads });
});

test("an edit that is not equivalent says why", () => {
  const difference = (previous: string, current: string, positions = false) =>
    sourceEditDifference("/src/a.ts", previous, current, positions);
  expect(difference("a;\n", "a; // one\n")).toBeNull();
  expect(difference("a;\n", "b;\n")).toBe("its tokens changed");
  expect(difference("return a;\n", "return\na;\n")).toBe("a line break between two tokens changed");
  expect(difference("a\u00a0;\n", "a\u00a0; // one\n")).toBe(
    "its text cannot be compared token by token",
  );
  expect(difference("a;\n", "// one\na;\n", true)).toBe(
    "a token moved, and the build records source positions",
  );
});
