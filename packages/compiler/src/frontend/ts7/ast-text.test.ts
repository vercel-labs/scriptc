import { expect, test } from "vitest";
import { computeLineStarts, skipTrivia } from "typescript/ast";
import { astLineOfPosition, astLineStarts, astSkipTrivia } from "./ast-text.js";

test("token trivia matches the pinned scanner for every UTF-16 code unit", () => {
  for (let code = 0; code <= 0xffff; code++) {
    const text = String.fromCharCode(code) + "token";
    expect(astSkipTrivia(text, 0, false, false), `U+${code.toString(16)}`).toBe(
      skipTrivia(text, 0),
    );
  }
});

test.each([
  "#!/usr/bin/env node\r\n/* comment */ token",
  " // one\u2028 // two\u2029token",
  " /* \u2028 \r\n */ token",
  " /* unterminated",
  " /expression/ ",
  "\n * first\n ** second",
  "<<<<<<< ours\r\nfirst\r\n=======\r\nsecond\r\n>>>>>>> theirs\r\nlast",
  "||||||| ancestor\nold\n=======\nnew\n>>>>>>> branch\nlast",
  "<<<<<<<wrong\n=======\n>>>>>>>wrong\nlast",
  " \u200b\u0085\ufeff token",
])("comments, JSDoc stars, shebangs and conflict markers match: %j", (text) => {
  for (let pos = -1; pos <= text.length; pos++) {
    for (const stopAtComments of [false, true]) {
      for (const inJSDoc of [false, true]) {
        expect(astSkipTrivia(text, pos, stopAtComments, inJSDoc)).toBe(
          skipTrivia(text, pos, false, stopAtComments, inJSDoc),
        );
      }
    }
  }
});

test.each(["", "hello", "\r\n", "a\rb\nc\r\nd\u2028e\u2029", "😀\r\n\ud800\ufeff\nlast"])(
  "line positions use UTF-16 offsets: %j",
  (text) => {
    const starts = astLineStarts(text);
    expect(starts).toEqual(computeLineStarts(text));
    for (let pos = 0; pos <= text.length; pos++) {
      const line = starts.findLastIndex((start) => start <= pos);
      expect(astLineOfPosition(starts, pos)).toBe(line);
    }
  },
);
