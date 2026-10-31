import { describe, expect, test } from "vitest";
import {
  canReplaceWith,
  compileRegexMatcher,
  regexLiteralBailReason,
  regexLiteralCaptures,
  regexLiteralCompiles,
} from "./regex-matchers.js";

function body(pattern: string, flags = "", vector = true): string {
  const code = compileRegexMatcher("m", pattern, flags, "i64", vector);
  if (code === null) throw new Error(`/${pattern}/${flags} did not compile`);
  return code.lines.join("\n");
}

describe("regex literal captures", () => {
  test("counts captures with the whole match and marks the ones every match sets", () => {
    expect(regexLiteralCaptures("[&<>]", "g")).toEqual({ count: 1, always: [true] });
    expect(regexLiteralCaptures("(\\w+)=(\\d)+", "")).toEqual({
      count: 3,
      always: [true, true, true],
    });
    expect(regexLiteralCaptures("(?<k>a)(b)?|(c)", "")).toEqual({
      count: 4,
      always: [true, false, false, false],
    });
    expect(regexLiteralCaptures("x(?:(a)|(b))y(c)*(d){0,2}(e){1,3}", "")).toEqual({
      count: 6,
      always: [true, false, false, false, false, true],
    });
  });

  test("answers null outside the parsed subset", () => {
    expect(regexLiteralCaptures("(?=a)(b)", "")).toBeNull();
    expect(regexLiteralCaptures("(a)\\1", "")).toBeNull();
    expect(regexLiteralCaptures("a", "v")).toBeNull();
  });
});

describe("regex literal matcher subset", () => {
  test.each([
    ['^(\\d+\\.\\d+\\.\\d+\\.\\d+) - - \\[([^\\]]+)\\] "(\\w+) ([^ ?"]+)(?:\\?([^ "]*))?$', ""],
    ["curl|bot|spider", "i"],
    ["\\d+", "g"],
    ["(?<year>\\d{4})-(?<month>\\d\\d)", ""],
    ["[\\b\\-\\]\\\\.]+", ""],
    ["\\x41\\u0042\\0\\t\\/\\-", ""],
    ["a{2,}?b{0,3}c*?", "y"],
    ["^\\s*$", "m"],
    ["\\bfoo\\B", "su"],
    ["[^]", ""],
  ])("/%s/%s compiles", (pattern, flags) => {
    expect(regexLiteralBailReason(pattern, flags)).toBe("");
  });

  test.each([
    ["(a)\\1", ""],
    ["a(?=b)", ""],
    ["a(?!b)", ""],
    ["(?<=a)b", ""],
    ["\\k<n>(?<n>a)", ""],
    ["\\p{L}", "u"],
    ["é", ""],
    ["\\u00e9", ""],
    ["[é]", "i"],
    ["\\cA", ""],
    ["\\01", ""],
    ["a{", ""],
    ["]", ""],
    ["\\a", ""],
    ["(?i:a)", ""],
    ["a{1,200000}", ""],
    ["^*", ""],
  ])("/%s/%s keeps the interpreter", (pattern, flags) => {
    expect(regexLiteralCompiles(pattern, flags)).toBe(false);
  });

  test("large patterns keep the interpreter", () => {
    expect(regexLiteralCompiles("(?:ab|cd)".repeat(20), "")).toBe(true);
    expect(regexLiteralCompiles("(?:ab|cd)".repeat(200), "")).toBe(false);
  });
});

describe("regex literal matcher code", () => {
  test("reports its capture count for a negative length", () => {
    expect(body("(a)(?:b)(?<c>c)")).toContain("ret i32 3");
  });

  test("a single possible first byte searches with memchr", () => {
    const code = compileRegexMatcher("m", "x\\d+", "g", "i64", true);
    expect(code?.decls).toContain("declare ptr @memchr(ptr, i32, i64)");
    expect(code?.lines.join("\n")).toContain("call ptr @memchr(ptr %from, i32 120, i64 %rest.w)");
  });

  test("a sticky pattern makes one attempt", () => {
    const text = body("\\d+", "y");
    expect(text).not.toContain("@memchr");
    expect(text).toMatch(/attempt_fail:\n {2}br label %nomatch/);
  });

  test("a non-multiline ^ attempts only position 0", () => {
    expect(body("^ab")).toContain("br i1 %a0, label %attempt, label %nomatch");
  });

  test("first-character sets and long runs use 16-byte scans", () => {
    const text = body("\\d+");
    expect(text).toContain("load <16 x i8>");
    expect(text).toContain("@llvm.cttz.i16");
    expect(body("\\d+", "", false)).not.toContain("<16 x i8>");
    // A bounded count below 32 stays scalar.
    expect(body("a\\d{1,3}")).not.toContain("<16 x i8>");
  });

  test("fixed leading characters filter 16 start positions at once", () => {
    // Both alternatives' first characters are tested at every offset and
    // combined, and the reads reach seven characters past the block.
    const text = body("agggtaaa|tttaccct", "gi");
    expect(text.match(/load <16 x i8>/g)!.length).toBeGreaterThanOrEqual(16);
    expect(text).toMatch(/and i16 /);
    expect(text).toMatch(/or i16 /);
    expect(text).toMatch(/add i32 %t\d+, 7\n/);
    // A class sequence with a fixed count extends the filter.
    expect(body("[cg]x{3}y")).toMatch(/and i16 /);
    // An optional first character, a single first character and a
    // variable-length start keep the first-character search.
    expect(body("[ab]?cd")).not.toMatch(/and i16 /);
    expect(body("[ab]*cd")).not.toMatch(/and i16 /);
    expect(body("xy|zw")).toMatch(/and i16 /);
    expect(body("[ab]|cd")).not.toMatch(/and i16 /);
    expect(body("agggtaaa|tttaccct", "gi", false)).not.toContain("<16 x i8>");
  });

  test("loops no continuation can share push no backtrack entries", () => {
    // \d+ then a dot; [^\]]+ then ]; the run at the end of the pattern.
    expect(body("\\d+\\.\\d+")).not.toContain("@scr_regex_stack_grow");
    expect(body("\\[[^\\]]+\\]")).not.toContain("@scr_regex_stack_grow");
    expect(body("a.*")).not.toContain("@scr_regex_stack_grow");
    // .* followed by b can give characters back.
    expect(body("a.*b")).toContain("@scr_regex_stack_grow");
    // $ is zero-width: \d+ may still give back before it.
    expect(body("\\d+$")).toContain("@scr_regex_stack_grow");
  });

  test("class tests use compares for few ranges and a table otherwise", () => {
    expect(body("[a-c]x")).not.toContain("constant [128 x i8]");
    expect(body("[aceg]x")).toContain("private unnamed_addr constant [128 x i8]");
  });

  test("case folding closes ASCII letters only", () => {
    // [^a]/i excludes both cases: compares 0-64, 66-96, 98-127 as ranges.
    const text = body("x[^a]", "i");
    expect(text).toContain("icmp ule i32");
    expect(text).not.toContain("constant [128 x i8]");
  });
});

describe("regex literal replacers", () => {
  test("take global, non-sticky, non-plain-text patterns and ASCII replacements without $", () => {
    expect(canReplaceWith("a[bc]", "g", "<2>")).toBe(true);
    expect(canReplaceWith("a[bc]", "gi", "")).toBe(true);
    expect(canReplaceWith("a[bc]", "", "x")).toBe(false);
    expect(canReplaceWith("a[bc]", "gy", "x")).toBe(false);
    expect(canReplaceWith("a[bc]", "g", "$1")).toBe(false);
    expect(canReplaceWith("a[bc]", "g", "é")).toBe(false);
    // Plain text is a string search at run time.
    expect(canReplaceWith("&", "g", "&amp;")).toBe(false);
    expect(canReplaceWith("a\\.b", "g", "x")).toBe(false);
    // Letters under i are not plain text.
    expect(canReplaceWith("ab", "gi", "x")).toBe(true);
  });

  test("append the gap and the replacement and continue the search", () => {
    const code = compileRegexMatcher("r", "<[^>]*>", "g", "i64", true, "|");
    const text = code!.lines.join("\n");
    expect(text).toContain('@r.rep = private unnamed_addr constant [1 x i8] c"|"');
    expect(text).toContain("call void @scr_re_replace_out_reserve(ptr %out, i64 %m.need)");
    expect(text).toContain("load <16 x i8>, ptr %m.src, align 1");
    expect(text).toMatch(/br i1 %m\.past, label %nomatch, label %scan/);
    expect(text).not.toContain("m.ret:");
    expect(text).toContain("ret i32 %n.found");
    // The search after a match is a 16-byte scan, not a memchr call.
    expect(text).not.toContain("@memchr");
    expect(code!.decls).toContain("declare void @scr_re_replace_out_reserve(ptr, i64)");
    // Without vectors the gap is a memcpy.
    const scalar = compileRegexMatcher("r", "<[^>]*>", "g", "i64", false, "|")!.lines.join("\n");
    expect(scalar).not.toContain("<16 x i8>");
    expect(scalar).toContain(
      "call void @llvm.memcpy.p0.p0.i64(ptr %m.dst, ptr %m.src, i64 %m.gapw, i1 false)",
    );
  });

  test("escape the replacement bytes and skip the copy of an empty one", () => {
    const quoted = compileRegexMatcher("r", "a[bc]", "g", "i64", true, '"\\\n')!.lines.join("\n");
    expect(quoted).toContain('c"\\22\\5C\\0A"');
    const empty = compileRegexMatcher("r", "a[bc]", "g", "i64", true, "")!.lines.join("\n");
    expect(empty).not.toContain("@r.rep");
  });
});
