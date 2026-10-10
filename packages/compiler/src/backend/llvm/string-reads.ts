/* Inline UTF-16 reads of proven-ASCII strings.
 *
 * Strings are UTF-8, so `length` and `charCodeAt` need a UTF-16 mapping in
 * general. Bit 31 of a string's capacity word (SCR_STR_ASCII_BIT in
 * scr_runtime.h) proves every byte is ASCII, where units are bytes. Sites
 * call the internal sc_str_* helpers below, which LLVM inlines: the proven
 * case is a header load and, for charCodeAt, one byte load; every other
 * string or index defers to the runtime function, which keeps the complete
 * semantics (surrogate halves, out-of-range NaN, fractional, negative and
 * NaN indices). On little-endian targets the bit is the sign bit of the
 * capacity word's low 32 bits on both i64 and i32 layouts.
 */

import { exactIndexLines } from "./common.js";

export const STRING_UTF16_LEN_DECL = "declare double @scr_str_utf16_len(ptr)";
export const STRING_CHAR_CODE_AT_DECL = "declare double @scr_str_char_code_at(ptr, double)";

/** Load the proven-ASCII flag of `%s` into `%ascii`. */
function asciiTest(): string[] {
  return [
    `  %cw.p = getelementptr inbounds %ScrStr, ptr %s, i32 0, i32 2`,
    `  %cw = load i32, ptr %cw.p`,
    `  %ascii = icmp slt i32 %cw, 0`,
  ];
}

function loadLength(sz: string): string[] {
  return [
    `  %len.p = getelementptr inbounds %ScrStr, ptr %s, i32 0, i32 1`,
    `  %len = load ${sz}, ptr %len.p`,
  ];
}

export interface StringReadHelper {
  decl: string;
  define(sz: string, attrs: string): string[];
}

export const STRING_READ_HELPERS: readonly StringReadHelper[] = [
  {
    decl: STRING_UTF16_LEN_DECL,
    define: (sz, attrs) => [
      `define internal double @sc_str_utf16_len(ptr %s) ${attrs} {`,
      `entry:`,
      ...asciiTest(),
      `  br i1 %ascii, label %fast, label %slow`,
      `fast:`,
      ...loadLength(sz),
      `  %n = uitofp ${sz} %len to double`,
      `  ret double %n`,
      `slow:`,
      `  %r = call double @scr_str_utf16_len(ptr %s)`,
      `  ret double %r`,
      `}`,
    ],
  },
  {
    decl: STRING_CHAR_CODE_AT_DECL,
    define: (sz, attrs) => {
      let n = 0;
      const exactIndex = exactIndexLines("%i", "%len", sz, () => `%ix${n++}`);
      return [
        `define internal double @sc_str_char_code_at(ptr %s, double %i) ${attrs} {`,
        `entry:`,
        ...asciiTest(),
        `  br i1 %ascii, label %bounds, label %slow`,
        `bounds:`,
        ...loadLength(sz),
        ...exactIndex.lines.map((line) => `  ${line}`),
        `  br i1 ${exactIndex.ok}, label %read, label %slow`,
        `read:`,
        sz === "i64"
          ? `  %k = add i64 ${exactIndex.wide}, 0`
          : `  %k = trunc i64 ${exactIndex.wide} to ${sz}`,
        `  %data = getelementptr inbounds %ScrStr, ptr %s, i32 1`,
        `  %p = getelementptr inbounds i8, ptr %data, ${sz} %k`,
        `  %byte = load i8, ptr %p`,
        `  %unit = uitofp i8 %byte to double`,
        `  ret double %unit`,
        `slow:`,
        `  %r = call double @scr_str_char_code_at(ptr %s, double %i)`,
        `  ret double %r`,
        `}`,
      ];
    },
  },
];
