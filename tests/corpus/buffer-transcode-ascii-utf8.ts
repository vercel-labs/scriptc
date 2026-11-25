// buffer.transcode, buffer.isAscii and buffer.isUtf8 over their full
// argument surface: every from/to encoding pair over ASCII, Latin-1, UTF-8
// (a BOM included), UTF-16LE (a BOM included), empty, NUL-only and astral
// inputs, with Node's ERR_INVALID_ARG_VALUE / ERR_INVALID_ARG_TYPE /
// ERR_INVALID_UTF8 / ERR_INVALID_ARG_TYPE ladders; and the three input
// kinds the predicates accept (Uint8Array, Buffer, ArrayBuffer, DataView,
// wider typed arrays) with the UTF-8 validity edges overlong sequences,
// surrogate halves, truncated runes and code points above U+10FFFF cross.
import { Buffer, isAscii, isUtf8, transcode } from "node:buffer";

function shape(fn: () => unknown): string {
  try {
    const value = fn();
    if (Buffer.isBuffer(value)) return "ok " + value.toString("hex") + " len=" + value.length;
    return "ok " + String(value);
  } catch (e) {
    const err = e as Error & { code?: string };
    return "ERR " + err.name + " " + String(err.code) + " " + err.message;
  }
}

const encodings = ["utf8", "utf16le", "latin1", "ascii", "hex", "base64", "base64url", "binary", "ucs2", "utf-8"] as const;
const samples: [string, Buffer][] = [
  ["ascii", Buffer.from("hello")],
  ["latin1", Buffer.from("héllo", "latin1")],
  ["utf8", Buffer.from("héllo 世", "utf8")],
  ["utf8bom", Buffer.from("﻿hi", "utf8")],
  ["utf16bom", Buffer.from("﻿hi", "utf16le")],
  ["empty", Buffer.alloc(0)],
  ["nul", Buffer.from([0])],
  ["astral", Buffer.from("\u{1F600}", "utf8")],
];
for (const [name, sample] of samples) {
  for (const from of encodings) {
    for (const to of encodings) {
      console.log("transcode", name, from, to, shape(() => transcode(sample, from, to)));
    }
  }
}
console.log("transcode bad source", shape(() => transcode(5 as unknown as Buffer, "utf8", "utf16le")));

const byteSamples: [string, Uint8Array][] = [
  ["bytes", new Uint8Array([104, 105])],
  ["nul", new Uint8Array([0])],
  ["empty", new Uint8Array(0)],
  ["controls", new Uint8Array([10, 13, 9, 32])],
  ["del", new Uint8Array([0x7f])],
  ["high", new Uint8Array([0x80])],
  ["truncated", new Uint8Array([0xe4, 0xb8])],
  ["overlong", new Uint8Array([0xc0, 0x80])],
  ["surrogate", new Uint8Array([0xed, 0xa0, 0x80])],
  ["above-max", new Uint8Array([0xf5, 0x80, 0x80, 0x80])],
  ["ff", new Uint8Array([0xff])],
];
for (const [name, input] of byteSamples) {
  console.log("predicates", name, shape(() => isAscii(input)), shape(() => isUtf8(input)));
}
const arrayBuffers: [string, ArrayBuffer][] = [
  ["bytes", new Uint8Array([104, 105]).buffer],
  ["empty", new ArrayBuffer(0)],
  ["high", new Uint8Array([0x80]).buffer],
];
for (const [name, input] of arrayBuffers) {
  console.log("predicates arraybuffer", name, shape(() => isAscii(input)), shape(() => isUtf8(input)));
}
const dataViews: [string, DataView][] = [
  ["bytes", new DataView(new Uint8Array([104, 105]).buffer)],
  ["high", new DataView(new Uint8Array([0x80]).buffer)],
];
for (const [name, input] of dataViews) {
  console.log("predicates dataview", name, shape(() => isAscii(input)), shape(() => isUtf8(input)));
}
const wider = new Uint16Array([0x6968]);
console.log("predicates wider", shape(() => isAscii(wider)), shape(() => isUtf8(wider)));
console.log("predicates buffer", shape(() => isAscii(Buffer.from("hi"))), shape(() => isUtf8(Buffer.from("hi"))));
