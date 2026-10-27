import { expect, test } from "vitest";
import { helperTokens } from "./helper-tokens.js";

test("matches complete helper spellings across comments, spaces and quote styles", () => {
  expect(helperTokens('var x = Object.defineProperty(o, "default", {value: m});')).toBe(
    helperTokens("var /*name*/ x=Object . defineProperty (o,'default',{value:m}); // end"),
  );
  expect(helperTokens('"default"')).toBe(helperTokens("'de\\x66ault'"));
  expect(helperTokens('"default"')).toBe(helperTokens("'de\\u0066ault'"));
  expect(helperTokens('"default"')).toBe(helperTokens("'de\\u{66}ault'"));
  expect(helperTokens('"default"')).toBe(helperTokens("'de\\\nfault'"));
  expect(helperTokens('"default"')).toBe(helperTokens("'de\\\r\nfault'"));
});

test.each([
  ["mod != null", "mod !== null"],
  ["a ??= b", "a ||= b"],
  ["return to;", "return other;"],
  ["return to;", "return; to;"],
  ["return to;", "return\nto;"],
  ["return to;", "return/*\n*/to;"],
  ["return to;", "return//comment\nto;"],
  ["return to;", "return\u2028to;"],
  ["return to;", "return\u2029to;"],
  ["(mod) => mod", "(mod)\n=> mod"],
  ["target.default", "target?.default"],
  ['"default"', '"default;s3:foo;"'],
  ['"default"', '"default\\0"'],
  ["mod", "mod other"],
  ["cb[0]", "cb[1]"],
  ["cb[1]", "cb[10]"],
])("retains a semantic difference between %s and %s", (a, b) => {
  expect(helperTokens(a)).not.toBe(helperTokens(b));
});

test.each([
  "/* unfinished",
  '"unfinished',
  '"line\nbreak"',
  "'\\xzz'",
  "'\\u0'",
  "'\\u{}'",
  "'\\u{110000}'",
  "'\\01'",
  "'\\1'",
  "'\\8'",
  "`template`",
  "/regexp/",
  "0x10",
  "07",
  "1.5",
  "1e3",
  "1n",
  "1_000",
  "a / b",
  "\\u0061",
  "café",
  "#name",
])("refuses unsupported or malformed helper tokens: %s", (source) => {
  expect(helperTokens(source)).toBeNull();
});
