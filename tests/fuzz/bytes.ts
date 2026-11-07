// Buffer and text decoding: base64, base64url, hex, UTF-8, UTF-16 and Latin-1 in both directions, StringDecoder
// over split input, TextDecoder and TextEncoder, and Buffer reads, writes, copies and searches at arbitrary
// offsets. Case fields: text, encoding, second encoding, raw bytes as hex, two offsets.
import { StringDecoder } from "node:string_decoder";
import { type Case, field, mutate, note, noteStr, ri, rnd, seedField } from "./fz.ts";

const ENC: BufferEncoding[] = ["utf8", "utf16le", "latin1", "ascii", "base64", "base64url", "hex", "ucs2", "binary"];
const DICT: string[] = [
  "=", "==", "-", "_", "+", "/", "\n", " ", "0", "f", "g", "\ud800", "\udc00", "\u0080", "߿", "ࠀ", "￿",
  "%",
];
const HEX = "0123456789abcdef";

function encoding(name: string): BufferEncoding {
  for (const e of ENC) if (e === name) return e;
  return "utf8";
}

export function generate(seeds: Case[]): Case {
  const text = mutate(seedField(seeds, 2), DICT, ri(5) + 1).slice(0, 300);
  const n = ri(40);
  let raw = "";
  for (let k = 0; k < n; k++) {
    const b = ri(4) === 0 ? 0x80 + ri(0x80) : ri(256);
    raw += HEX.charAt(b >> 4) + HEX.charAt(b & 15);
  }
  return [
    String(ri(10)), String(rnd()), text, ENC[ri(ENC.length)] ?? "utf8", ENC[ri(ENC.length)] ?? "utf8", raw,
    String(ri(n + 4) - 2), String(ri(n + 4) - 2),
  ];
}

export function execute(c: Case): void {
  const mode = Number(field(c, 0));
  const text = field(c, 2);
  const enc = encoding(field(c, 3));
  const enc2 = encoding(field(c, 4));
  const raw = Buffer.from(field(c, 5), "hex");
  const n = raw.length;
  const o1 = Number(field(c, 6));
  const o2 = Number(field(c, 7));
  try {
    if (mode === 0) {
      const b = Buffer.from(text, enc);
      note(b.length);
      noteStr(b.toString(enc2));
      note(Buffer.byteLength(text, enc));
    } else if (mode === 1) {
      noteStr(raw.toString(enc, o1, o2));
      noteStr(raw.toString(enc2));
    } else if (mode === 2) {
      const d = new StringDecoder(enc);
      let out = "";
      let p = 0;
      while (p < n) {
        const step = ri(4) + 1;
        out += d.write(raw.subarray(p, p + step));
        p += step;
      }
      out += d.end();
      noteStr(out);
      note(out.length);
    } else if (mode === 3) {
      const td = new TextDecoder(ri(2) === 0 ? "utf-8" : "utf-16le", { fatal: ri(2) === 0, ignoreBOM: ri(2) === 0 });
      noteStr(td.decode(raw));
      const te = new TextEncoder();
      note(te.encode(text).length);
      const r = te.encodeInto(text, new Uint8Array(ri(20)));
      note(r.read);
      note(r.written);
    } else if (mode === 4) {
      const b = Buffer.alloc(ri(24));
      note(b.write(text, o1 < 0 ? 0 : o1, enc));
      noteStr(b.toString("hex"));
      b.fill(text, o1 < 0 ? 0 : o1, undefined, enc2);
      noteStr(b.toString("hex"));
    } else if (mode === 5) {
      note(raw.indexOf(text, o1, enc));
      note(raw.lastIndexOf(raw.subarray(0, 2), o2));
      note(raw.includes(text) ? 1 : 0);
      note(raw.compare(Buffer.from(text, enc2), 0, undefined, o1 < 0 ? 0 : o1));
      note(raw.equals(raw.subarray(0)) ? 1 : 0);
    } else if (mode === 6) {
      const w = ri(6) + 1;
      note(raw.readUIntLE(o1, w));
      note(raw.readIntBE(o2, w));
      raw.writeUIntBE(rnd() % 256, o1, w);
      note(raw.readUInt16LE(o2));
      note(raw.readInt32BE(o1));
      note(raw.readDoubleLE(o2) | 0);
      note(raw.readFloatBE(o1) | 0);
    } else if (mode === 7) {
      const t = Buffer.alloc(ri(24), 1);
      note(raw.copy(t, o1 < 0 ? 0 : o1, o2 < 0 ? 0 : o2));
      noteStr(t.toString("hex"));
      note(Buffer.concat([raw, t, raw.subarray(o1 < 0 ? 0 : o1)], ri(80)).length);
    } else if (mode === 8) noteStr(atob(text));
    else {
      noteStr(btoa(text));
      noteStr(raw.toString("base64url"));
      noteStr(Buffer.from(raw.toString("base64"), "base64").toString("hex"));
      noteStr(text.normalize(ri(2) === 0 ? "NFC" : "NFKD"));
      noteStr(text.toLowerCase());
      noteStr(text.toUpperCase());
      note(text.localeCompare(field(c, 3)));
    }
    note(1);
  } catch (e) {
    note(2);
  }
}
