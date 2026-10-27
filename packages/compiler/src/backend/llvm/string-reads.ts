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
 *
 * With `scan`, a string that is not proven ASCII is first compared with
 * the runtime's published scan receiver (ScrStrScan, scr_runtime.h): the
 * string an indexed scan converted to UTF-16 units, whose length and units
 * then read inline. Where the runtime keeps it per thread, the declaration
 * is thread-local.
 */

import type { LlvmEmitterContext } from "./expr-context.js";
import { exactIndexLines, sizeToDouble } from "./common.js";
import { wtf8Bytes } from "../literals.js";
import { literalCapWord, literalCapWord32 } from "./string-key-hash.js";

export const STRING_UTF16_LEN_DECL = "declare double @scr_str_utf16_len(ptr)";
export const STRING_CHAR_CODE_AT_DECL = "declare double @scr_str_char_code_at(ptr, double)";
/** Converts a string to UTF-16 units and publishes it as the scan receiver
 * when the loop about to read it can read enough of it (the other two
 * operands are the range of indexes it reads; bytes-loop-versions.ts).
 * Like the fallbacks below, it can evict an index entry, so it carries no
 * memory restriction. */
export const STRING_SCAN_UNITS_DECL = "declare void @scr_str_scan_units_for(ptr, double, double)";
/** The runtime fallbacks are cold: both common cases read inline. They
 * carry no
 * memory restriction: a fallback can evict an index entry, which resets
 * the published scan receiver (@scr_str_scan, read inline below) and frees
 * its unit array, so every scan read after the call must reload. */
const LENGTH_CALL_ATTRS = "cold nocallback nounwind willreturn";
const READ_CALL_ATTRS = "cold nocallback nounwind willreturn";
/** Requests the integer-index helper below; an LLVM comment line among the
 * declarations, so it never declares anything itself. */
export const STRING_CHAR_CODE_AT_INT_MARKER = "; uses @sc_str_char_code_at_int";
export const STRING_CHAR_AT_DECL = "declare ptr @scr_str_char_at(ptr, double)";
/** Requests the integer-index charAt helper, as the marker above does. */
export const STRING_CHAR_AT_INT_MARKER = "; uses @sc_str_char_at_int";
/** The code-point character starting at a byte offset (the string
 * iterator's step). Requested together with STRING_CHAR_AT_DECL, which
 * defines the ASCII table. */
export const STRING_CP_AT_BYTE_DECL = "declare ptr @scr_str_cp_at_byte(ptr, i64)";

/** The proven-ASCII flag of string `s`, as an i1. */
export function emitStringAsciiFlag(host: LlvmEmitterContext, s: string): string {
  const B = host.B;
  const wordPointer = B.tmp(),
    word = B.tmp(),
    ascii = B.tmp();
  B.line(`${wordPointer} = getelementptr inbounds %ScrStr, ptr ${s}, i32 0, i32 2`);
  B.line(`${word} = load i32, ptr ${wordPointer}`);
  B.line(`${ascii} = icmp slt i32 ${word}, 0`);
  return ascii;
}

/** The byte length of string `s`, as the target's size type. */
export function emitStringByteLength(host: LlvmEmitterContext, s: string): string {
  const B = host.B;
  const lengthPointer = B.tmp(),
    length = B.tmp();
  B.line(`${lengthPointer} = getelementptr inbounds %ScrStr, ptr ${s}, i32 0, i32 1`);
  B.line(`${length} = load ${host.sizeType}, ptr ${lengthPointer}`);
  return length;
}

/** Unit `index` (an i64) of a proven-ASCII string `s` whose length covers
 * it: one byte load, as a double. */
export function emitAsciiCharCode(host: LlvmEmitterContext, s: string, index: string): string {
  const B = host.B;
  const data = B.tmp(),
    pointer = B.tmp(),
    byte = B.tmp(),
    code = B.tmp();
  B.line(`${data} = getelementptr inbounds %ScrStr, ptr ${s}, i32 1`);
  B.line(`${pointer} = getelementptr inbounds i8, ptr ${data}, i64 ${index}`);
  B.line(`${byte} = load i8, ptr ${pointer}`);
  B.line(`${code} = uitofp i8 ${byte} to double`);
  return code;
}

/** Unit `index` (an i64, below their count) of a string's UTF-16 `units`
 * (ScrStrScan): one 16-bit load, as a double. */
export function emitUnitCharCode(host: LlvmEmitterContext, units: string, index: string): string {
  const B = host.B;
  const pointer = B.tmp(),
    unit = B.tmp(),
    code = B.tmp();
  B.line(`${pointer} = getelementptr inbounds i16, ptr ${units}, i64 ${index}`);
  B.line(`${unit} = load i16, ptr ${pointer}`);
  B.line(`${code} = uitofp i16 ${unit} to double`);
  return code;
}

/** The one-character string of unit `index` (an i64) of a proven-ASCII
 * string `s` whose length covers it: the immortal `@sc_ascii_chars` entry
 * for its byte, as the inline charAt helpers answer. */
export function emitAsciiChar(host: LlvmEmitterContext, s: string, index: string): string {
  // The table is defined with sc_str_char_at.
  host.declare(STRING_CHAR_AT_DECL);
  const B = host.B;
  const sz = host.sizeType;
  const data = B.tmp(),
    pointer = B.tmp(),
    byte = B.tmp(),
    code = B.tmp(),
    entry = B.tmp();
  B.line(`${data} = getelementptr inbounds %ScrStr, ptr ${s}, i32 1`);
  B.line(`${pointer} = getelementptr inbounds i8, ptr ${data}, i64 ${index}`);
  B.line(`${byte} = load i8, ptr ${pointer}`);
  B.line(`${code} = zext i8 ${byte} to i64`);
  B.line(
    `${entry} = getelementptr inbounds [128 x { ${sz}, ${sz}, ${sz}, [2 x i8] }], ptr @sc_ascii_chars, i64 0, i64 ${code}`,
  );
  return entry;
}

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

/** Whether emitted reads use the runtime's scan receiver: from ordinary
 * global storage, or, in worker executables, from the thread's static TLS
 * block (executableTls). */
export function stringScanInline(host: LlvmEmitterContext): boolean {
  return (
    host.executableTls || (host.mod.workers !== true && host.mod.lib?.threadInstances !== true)
  );
}

/** The runtime's ScrStrScan record and the declaration naming it. */
export function stringScanType(sz: string): string {
  return `{ ptr, ptr, ${sz} }`;
}

export function stringScanDecl(sz: string, threadLocal: boolean): string {
  return `@scr_str_scan = external ${threadLocal ? "thread_local " : ""}global ${stringScanType(sz)}`;
}

/** The scan receiver test of `%s`: branches to `hit` with `%scan.n` (its
 * unit count, as i64) and `%scan.units` loaded, else to `miss`. */
function scanTest(sz: string, hit: string, miss: string): string[] {
  const type = stringScanType(sz);
  return [
    `  %scan.s = load ptr, ptr @scr_str_scan`,
    `  %scan.same = icmp eq ptr %scan.s, %s`,
    `  br i1 %scan.same, label %scan.load, label %${miss}`,
    `scan.load:`,
    `  %scan.up = getelementptr inbounds ${type}, ptr @scr_str_scan, i32 0, i32 1`,
    `  %scan.units = load ptr, ptr %scan.up`,
    `  %scan.np = getelementptr inbounds ${type}, ptr @scr_str_scan, i32 0, i32 2`,
    `  %scan.nw = load ${sz}, ptr %scan.np`,
    sz === "i64" ? `  %scan.n = add i64 %scan.nw, 0` : `  %scan.n = zext ${sz} %scan.nw to i64`,
    `  br label %${hit}`,
  ];
}

/** Read unit `%k` (i64, below %scan.n) of the scan receiver. */
function scanRead(): string[] {
  return [
    `  %scan.p = getelementptr inbounds i16, ptr %scan.units, i64 %scan.k`,
    `  %scan.unit = load i16, ptr %scan.p`,
    `  %scan.d = uitofp i16 %scan.unit to double`,
    `  ret double %scan.d`,
  ];
}

/** The one-character strings of the ASCII range as immortal literals
 * ({ rc = SIZE_MAX, len = 1, capacity word, char, NUL }), indexed by
 * character code: the inline charAt result. Their bytes, capacity words
 * and key hashes equal those of the runtime's single-character statics, so
 * they are interchangeable with the strings the runtime returns. */
function asciiCharTable(sz: string): string[] {
  const type = `{ ${sz}, ${sz}, ${sz}, [2 x i8] }`;
  const entries: string[] = [];
  for (let c = 0; c < 128; c++) {
    const bytes = wtf8Bytes(String.fromCharCode(c));
    const word = sz === "i64" ? literalCapWord(bytes) : literalCapWord32(bytes);
    entries.push(`${type} { ${sz} -1, ${sz} 1, ${sz} ${word}, [2 x i8] [i8 ${c}, i8 0] }`);
  }
  return [`@sc_ascii_chars = internal constant [128 x ${type}] [${entries.join(", ")}]`];
}

/** The table entry for byte `%byte` of a proven-ASCII string. */
function asciiCharRead(sz: string): string[] {
  return [
    `  %data = getelementptr inbounds %ScrStr, ptr %s, i32 1`,
    `  %p = getelementptr inbounds i8, ptr %data, i64 %k`,
    `  %byte = load i8, ptr %p`,
    `  %code = zext i8 %byte to i64`,
    `  %char = getelementptr inbounds [128 x { ${sz}, ${sz}, ${sz}, [2 x i8] }], ptr @sc_ascii_chars, i64 0, i64 %code`,
    `  ret ptr %char`,
  ];
}

export interface StringReadHelper {
  decl: string;
  define(sz: string, attrs: string, scan: boolean): string[];
}

export const STRING_READ_HELPERS: readonly StringReadHelper[] = [
  {
    decl: STRING_UTF16_LEN_DECL,
    define: (sz, attrs, scan) => [
      `define internal double @sc_str_utf16_len(ptr %s) ${attrs} {`,
      `entry:`,
      ...asciiTest(),
      `  br i1 %ascii, label %fast, label %${scan ? "wide" : "slow"}`,
      `fast:`,
      ...loadLength(sz),
      `  %n = ${sizeToDouble(sz)} ${sz} %len to double`,
      `  ret double %n`,
      ...(scan
        ? [
            `wide:`,
            ...scanTest(sz, "scan.len", "slow"),
            `scan.len:`,
            `  %scan.dn = sitofp i64 %scan.n to double`,
            `  ret double %scan.dn`,
          ]
        : []),
      `slow:`,
      `  %r = call double @scr_str_utf16_len(ptr %s) ${LENGTH_CALL_ATTRS}`,
      `  ret double %r`,
      `}`,
    ],
  },
  {
    decl: STRING_CHAR_CODE_AT_DECL,
    define: (sz, attrs, scan) => {
      let n = 0;
      const exactIndex = exactIndexLines("%i", "%len", sz, () => `%ix${n++}`);
      const scanIndex = exactIndexLines("%i", "%scan.n", "i64", () => `%sx${n++}`);
      return [
        `define internal double @sc_str_char_code_at(ptr %s, double %i) ${attrs} {`,
        `entry:`,
        ...asciiTest(),
        `  br i1 %ascii, label %bounds, label %${scan ? "wide" : "slow"}`,
        ...(scan
          ? [
              `wide:`,
              ...scanTest(sz, "scan.bounds", "slow"),
              `scan.bounds:`,
              ...scanIndex.lines.map((line) => `  ${line}`),
              `  br i1 ${scanIndex.ok}, label %scan.read, label %slow`,
              `scan.read:`,
              `  %scan.k = add i64 ${scanIndex.wide}, 0`,
              ...scanRead(),
            ]
          : []),
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
        `  %r = call double @scr_str_char_code_at(ptr %s, double %i) ${READ_CALL_ATTRS}`,
        `  ret double %r`,
        `}`,
      ];
    },
  },
  {
    // An index the compiler proved to be an exact integer (a counted-loop
    // counter, an int32 slot or local) needs no double round trip: one
    // unsigned compare rejects negative and out-of-range indices alike.
    decl: STRING_CHAR_CODE_AT_INT_MARKER,
    define: (sz, attrs, scan) => [
      `define internal double @sc_str_char_code_at_int(ptr %s, i64 %i) ${attrs} {`,
      `entry:`,
      ...asciiTest(),
      `  br i1 %ascii, label %bounds, label %${scan ? "wide" : "slow"}`,
      ...(scan
        ? [
            `wide:`,
            ...scanTest(sz, "scan.bounds", "slow"),
            `scan.bounds:`,
            `  %scan.ok = icmp ult i64 %i, %scan.n`,
            `  br i1 %scan.ok, label %scan.read, label %slow`,
            `scan.read:`,
            `  %scan.k = add i64 %i, 0`,
            ...scanRead(),
          ]
        : []),
      `bounds:`,
      ...loadLength(sz),
      ...(sz === "i64" ? [] : [`  %len64 = zext ${sz} %len to i64`]),
      `  %ok = icmp ult i64 %i, ${sz === "i64" ? "%len" : "%len64"}`,
      `  br i1 %ok, label %read, label %slow`,
      `read:`,
      `  %data = getelementptr inbounds %ScrStr, ptr %s, i32 1`,
      `  %p = getelementptr inbounds i8, ptr %data, i64 %i`,
      `  %byte = load i8, ptr %p`,
      `  %unit = uitofp i8 %byte to double`,
      `  ret double %unit`,
      `slow:`,
      `  %d = sitofp i64 %i to double`,
      `  %r = call double @scr_str_char_code_at(ptr %s, double %d) ${READ_CALL_ATTRS}`,
      `  ret double %r`,
      `}`,
    ],
  },
  {
    // charAt of a proven-ASCII string at an exact in-range index is the
    // table entry for its byte; every other case calls the runtime, which
    // keeps the complete semantics. The table is defined with the helper.
    decl: STRING_CHAR_AT_DECL,
    define: (sz, attrs) => {
      let n = 0;
      const exactIndex = exactIndexLines("%i", "%len", sz, () => `%ix${n++}`);
      return [
        ...asciiCharTable(sz),
        ``,
        `define internal ptr @sc_str_char_at(ptr %s, double %i) ${attrs} {`,
        `entry:`,
        ...asciiTest(),
        `  br i1 %ascii, label %bounds, label %slow`,
        `bounds:`,
        ...loadLength(sz),
        ...exactIndex.lines.map((line) => `  ${line}`),
        `  br i1 ${exactIndex.ok}, label %read, label %slow`,
        `read:`,
        `  %k = add i64 ${exactIndex.wide}, 0`,
        ...asciiCharRead(sz),
        `slow:`,
        `  %r = call ptr @scr_str_char_at(ptr %s, double %i) ${READ_CALL_ATTRS}`,
        `  ret ptr %r`,
        `}`,
      ];
    },
  },
  {
    // The string iterator's step at byte `%b`, a character start below the
    // byte count: an ASCII byte is the table entry for it; any other lead
    // byte takes the runtime, which copies the character's bytes.
    decl: STRING_CP_AT_BYTE_DECL,
    define: (sz, attrs) => [
      `define internal ptr @sc_str_cp_at_byte(ptr %s, i64 %b) ${attrs} {`,
      `entry:`,
      `  %data = getelementptr inbounds %ScrStr, ptr %s, i32 1`,
      `  %p = getelementptr inbounds i8, ptr %data, i64 %b`,
      `  %byte = load i8, ptr %p`,
      `  %ascii = icmp sge i8 %byte, 0`,
      `  br i1 %ascii, label %read, label %slow`,
      `read:`,
      `  %code = zext i8 %byte to i64`,
      `  %char = getelementptr inbounds [128 x { ${sz}, ${sz}, ${sz}, [2 x i8] }], ptr @sc_ascii_chars, i64 0, i64 %code`,
      `  ret ptr %char`,
      `slow:`,
      `  %r = call ptr @scr_str_cp_at_byte(ptr %s, i64 %b) nounwind willreturn`,
      `  ret ptr %r`,
      `}`,
    ],
  },
  {
    // An exact integer index, as for sc_str_char_code_at_int. Requested
    // together with STRING_CHAR_AT_DECL, which defines the table.
    decl: STRING_CHAR_AT_INT_MARKER,
    define: (sz, attrs) => [
      `define internal ptr @sc_str_char_at_int(ptr %s, i64 %i) ${attrs} {`,
      `entry:`,
      ...asciiTest(),
      `  br i1 %ascii, label %bounds, label %slow`,
      `bounds:`,
      ...loadLength(sz),
      ...(sz === "i64" ? [] : [`  %len64 = zext ${sz} %len to i64`]),
      `  %ok = icmp ult i64 %i, ${sz === "i64" ? "%len" : "%len64"}`,
      `  br i1 %ok, label %read, label %slow`,
      `read:`,
      `  %k = add i64 %i, 0`,
      ...asciiCharRead(sz),
      `slow:`,
      `  %d = sitofp i64 %i to double`,
      `  %r = call ptr @scr_str_char_at(ptr %s, double %d) ${READ_CALL_ATTRS}`,
      `  ret ptr %r`,
      `}`,
    ],
  },
];
