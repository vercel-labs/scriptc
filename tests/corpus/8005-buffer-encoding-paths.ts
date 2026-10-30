// Buffer latin1, ascii, hex and base64 conversions in both directions:
// ASCII, binary and mixed contents at sizes around eight-byte words and the
// pool threshold, strings with code points past U+00FF, invalid hex and
// base64 text, and the lengths and characters of the strings produced.

let seed = 12345;
function next(): number {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed >>> 8;
}

function fill(size: number, kind: string): Buffer {
  const buf = Buffer.alloc(size);
  for (let i = 0; i < size; i++) {
    const r = next();
    if (kind === "ascii") buf[i] = 32 + (r % 95);
    else if (kind === "binary") buf[i] = r & 255;
    else if (kind === "high") buf[i] = 128 + (r % 128);
    else buf[i] = r % 23 === 0 ? 160 + (r % 96) : 97 + (r % 26);
  }
  return buf;
}

function digest(text: string): number {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) >>> 0;
  return h;
}

const sizes = [0, 1, 7, 8, 9, 15, 16, 17, 63, 64, 65, 4095, 4096, 4097, 70001];
for (const kind of ["ascii", "binary", "high", "sparse"]) {
  const rows: string[] = [];
  for (const size of sizes) {
    const buf = fill(size, kind);
    const latin1 = buf.toString("latin1");
    const back = Buffer.from(latin1, "latin1");
    const ascii = Buffer.from(latin1, "ascii");
    const binary = Buffer.from(buf.toString("binary"), "binary");
    const hex = buf.toString("hex");
    const b64 = buf.toString("base64");
    const url = buf.toString("base64url");
    rows.push(
      [
        size,
        latin1.length,
        digest(latin1),
        back.equals(buf),
        ascii.equals(buf),
        binary.equals(buf),
        Buffer.from(hex, "hex").equals(buf),
        Buffer.from(b64, "base64").equals(buf),
        Buffer.from(url, "base64url").equals(buf),
        hex.length,
        b64.length,
        Buffer.byteLength(latin1, "latin1"),
        size > 2 ? latin1.charCodeAt(size - 2) : -1,
        size > 4 ? latin1.slice(1, 4).length : -1,
      ].join(","),
    );
  }
  console.log(kind, rows.join(" "));
}

// Strings with code points past U+00FF keep the low byte of each UTF-16
// unit, and an astral code point gives its two surrogates' low bytes.
const wide = [
  "abcéÿ",
  "ĀŁ߿",
  "xࠀ€￿y",
  "\u{1F600}a\u{10FFFF}",
  "é".repeat(9) + "€" + "è".repeat(9),
  "aaaaaaaébbbbbbbb中cccccccc\u{1F600}",
  "ÀÁÂÃÄÅÆÇࠀÈ",
];
for (const text of wide) {
  console.log(
    Buffer.from(text, "latin1").toString("hex"),
    Buffer.from(text, "ascii").toString("hex"),
    Buffer.byteLength(text, "latin1"),
  );
}
const mixed = "é".repeat(5000) + "中" + "z".repeat(5000) + "ÿ".repeat(3000);
const mixedBytes = Buffer.from(mixed, "latin1");
console.log(mixedBytes.length, mixedBytes[0], mixedBytes[5000], mixedBytes[5001], mixedBytes[13000]);

// Hex stops at the first invalid pair and drops an odd last digit.
for (const text of ["0aFf", "0aF", "0a1g22", "zz00", "", "ABCDEF0123456789", "0aİ0b", "00a"]) {
  console.log(JSON.stringify(text), Buffer.from(text, "hex").toString("hex"), Buffer.byteLength(text, "hex"));
}
const longHex = "0123456789abcdef".repeat(600) + "0x" + "ff".repeat(10);
console.log(Buffer.from(longHex, "hex").length);

// base64 skips characters outside both alphabets and stops at padding.
for (const text of ["aGVsbG8=", "aGVsbG8", "aGV sbG8=", "aGV\nsbG8", "-_-_", "+/+/", "aGVsbG8=d29ybGQ=", "a", "ab", "abc", "aébc", "====", "YQ"]) {
  console.log(JSON.stringify(text), Buffer.from(text, "base64").toString("hex"), Buffer.from(text, "base64url").toString("hex"));
}

// Strings produced by hex and base64 behave as ASCII text afterwards.
const produced = fill(5000, "binary");
const producedHex = produced.toString("hex");
const joined = producedHex + "é" + produced.toString("base64");
console.log(joined.length, joined.indexOf("é"), digest(joined.slice(9990, 10020)));
const latinText = fill(9000, "high").toString("latin1");
const appended = latinText + "€";
console.log(latinText.length, appended.length, appended.charCodeAt(8999), appended.charCodeAt(9000), appended.slice(8998).length);
