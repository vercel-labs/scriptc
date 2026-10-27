// @exit: 1
// @no-node-shims
// node:punycode's conversions (punycode.js 2.1.0): encode/decode of bare
// labels, toASCII/toUnicode over domains and email addresses (only the part
// after '@' maps; every RFC 3490 separator splits labels), ucs2 code point
// arrays with astral pairs and lone surrogates, and the RangeErrors of
// malformed input. A static import links the module before anything runs,
// so its DEP0040 report precedes the program and no 'warning' listener the
// program registers sees it (the Node side runs without the preload shim,
// which would delay that report past the program's first turn). The report
// carries the process id, so the @exit directive keeps stderr out of the
// comparison.
import * as punycode from "node:punycode";

process.on("warning", (w) => console.log("listener", w.name));

const show = (label: string, f: () => unknown): void => {
  try {
    console.log(label, JSON.stringify(f()));
  } catch (e) {
    const err = e as Error;
    console.log(label, "threw", err instanceof RangeError, err.name, err.message);
  }
};

console.log(punycode.version);
for (const s of ["mañana", "bücher", "ü", "abc", "", "-> $1.00 <-", "ليهمابتكلموشعربي؟", "他们为什么不说中文", "😀x", "MaJiでKoiする5秒前"]) {
  show(`encode ${s}`, () => punycode.encode(s));
  show(`roundtrip ${s}`, () => punycode.decode(punycode.encode(s)));
}
for (const s of ["maana-pta", "bcher-kva", "tda", "abc-", "-abc", "ABC-kva", "a-b-c-kva", "ü-kva", "kva-ü", "99999999999", "zzzzzzzzzzzzz", "a-", "-"]) {
  show(`decode ${s}`, () => punycode.decode(s));
}
for (const d of ["mañana.com", "bücher.de", "example.com", "", "a..b", "ex@mple@bücher.de", "user@bücher.de", "日本。jp", "a．b｡c", "ÄÖÜ.test", "a.b."]) {
  show(`toASCII ${d}`, () => punycode.toASCII(d));
}
for (const d of ["xn--maana-pta.com", "xn--bcher-kva.de", "XN--bcher-kva.de", "xn--BCHER-KVA.de", "example.com", "user@xn--bcher-kva.de", "xn--.x", "xn--ü.x", "xn--zzzzzzzzzzzzz.x", "xn--a-Kva.x"]) {
  show(`toUnicode ${d}`, () => punycode.toUnicode(d));
}
show("ucs2.decode", () => punycode.ucs2.decode("aé😀\ud800b\udc00"));
show("ucs2.encode", () => punycode.ucs2.encode([97, 0xe9, 0x1f600, 0xd800, 0xdc00, 98]));
show("ucs2.encode join", () => punycode.ucs2.encode([0xd83d, 0xde00]).length);
show("ucs2.encode range", () => punycode.ucs2.encode([0x110000]));
show("ucs2 roundtrip", () => punycode.ucs2.encode(punycode.ucs2.decode("x😀\udfffy")) === "x😀\udfffy");
process.exitCode = 1;
