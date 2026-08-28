// The full Buffer encoding-name surface: latin1/binary/ascii, utf16le and
// its ucs2 aliases, base64url both directions, Buffer.byteLength per
// encoding (padding trims included), and Buffer.isEncoding over runtime
// strings. Alias spellings normalize at the call site.

// from(string, latin1/binary/ascii): each UTF-16 unit's low byte — the
// astral char contributes its two surrogates' low bytes.
const s = "hé€\u{1f600}x";
console.log(Buffer.from(s, "latin1").toString("hex"));
console.log(Buffer.from(s, "binary").toString("hex"));
console.log(Buffer.from(s, "ascii").toString("hex"));

// utf16le round trips, surrogate pairs included; every alias spelling.
console.log(Buffer.from(s, "utf16le").toString("hex"));
console.log(Buffer.from("abc", "ucs2").toString("hex"));
console.log(Buffer.from("abc", "ucs-2").toString("hex"));
console.log(Buffer.from("abc", "utf-16le").toString("hex"));
console.log(Buffer.from(s, "utf16le").toString("utf16le"));
console.log(Buffer.from("a\u{10437}b", "utf16le").toString("utf16le"));

// utf-8 alias spelling.
console.log(Buffer.from("hé", "utf-8").toString("hex"), Buffer.from("hé").toString("utf-8"));

// toString(latin1/binary): bytes are U+00XX; ascii masks the high bit.
const raw = Buffer.from("68e9807fff", "hex");
console.log(JSON.stringify(raw.toString("latin1")));
console.log(JSON.stringify(raw.toString("binary")));
console.log(JSON.stringify(raw.toString("ascii")));

// utf16le decode: LE pairs, odd tail byte drops.
console.log(JSON.stringify(Buffer.from("610062006300", "hex").toString("utf16le")));
console.log(JSON.stringify(Buffer.from("610062", "hex").toString("ucs2")));
console.log(Buffer.from("610062", "hex").toString("utf16le").length);

// base64url: unpadded, -_ alphabet, decode accepts either alphabet.
console.log(Buffer.from([251, 255, 254]).toString("base64url"));
console.log(Buffer.from([251, 255, 254]).toString("base64"));
console.log(Buffer.from([1]).toString("base64url"), Buffer.from([1, 2]).toString("base64url"));
console.log(Buffer.from("-_-_", "base64url").toString("hex"));
console.log(Buffer.from("+/+/", "base64url").toString("hex"));
console.log(Buffer.from("SGVsbG8", "base64url").toString("utf8"));

// Range forms of the new decoders (slice-then-decode).
const r = Buffer.from("d83dde00d83dde00", "hex");
console.log(JSON.stringify(r.toString("latin1", 1, 3)));
console.log(JSON.stringify(r.toString("ascii", 0, 2)));
console.log(Buffer.from("6100620063006400", "hex").toString("utf16le", 2, 6));

// byteLength: utf8 counts UTF-8 bytes, latin1/ascii UTF-16 units, utf16le
// doubles them, hex halves, base64 trims padding.
const bl = "hé\u{1f600}";
console.log(Buffer.byteLength(bl), Buffer.byteLength(bl, "utf8"), Buffer.byteLength(bl, "utf-8"));
console.log(Buffer.byteLength(bl, "latin1"), Buffer.byteLength(bl, "binary"), Buffer.byteLength(bl, "ascii"));
console.log(Buffer.byteLength(bl, "utf16le"), Buffer.byteLength(bl, "ucs2"));
console.log(Buffer.byteLength("abcd", "hex"), Buffer.byteLength("abc", "hex"), Buffer.byteLength("", "hex"));
console.log(Buffer.byteLength("SGVsbG8=", "base64"), Buffer.byteLength("SGVsbG8==", "base64"), Buffer.byteLength("SGVsbG8", "base64url"), Buffer.byteLength("", "base64"));
console.log(Buffer.byteLength(Buffer.alloc(5)), Buffer.byteLength(new Uint8Array(3)));

// isEncoding over runtime strings: the case-insensitive alias set.
const names = ["utf8", "UTF8", "utf-8", "ascii", "latin1", "binary", "base64", "base64url", "BASE64URL", "hex", "ucs2", "ucs-2", "utf16le", "utf-16le", "nope", "utf16", "latin-1", "", "hexx"];
for (const n of names) {
  console.log(n, Buffer.isEncoding(n));
}

// A BufferEncoding variable dispatches at runtime (including aliases and
// range forms); casts can expose Node's case-insensitive spellings and its
// catchable ERR_UNKNOWN_ENCODING path.
const variableEncodings: BufferEncoding[] = ["hex", "base64url", "binary", "ucs-2", "utf-8"];
for (const encoding of variableEncodings) {
  console.log("variable", encoding, raw.toString(encoding));
}
function variableTail(encoding: BufferEncoding): string {
  return raw.toString(encoding, 2);
}
function variableRange(encoding: BufferEncoding): string {
  return raw.toString(encoding, 1, 4);
}
console.log("variable tail", variableTail("hex"));
console.log("variable range", variableRange("hex"));
console.log("variable upper", raw.toString("BASE64" as BufferEncoding));
try {
  raw.toString("wat" as BufferEncoding);
  console.log("variable bad did not throw");
} catch (e) {
  if (e instanceof TypeError) {
    console.log("variable bad", (e as NodeJS.ErrnoException).code, e.message);
  }
}
try {
  variableRange("wat-range" as BufferEncoding);
  console.log("variable bad range did not throw");
} catch (e) {
  if (e instanceof TypeError) {
    console.log("variable bad range", (e as NodeJS.ErrnoException).code, e.message);
  }
}

// Forwarding an optional encoding preserves Buffer.toString(undefined)'s
// utf8 default instead of treating the absent arm as a failed string cast.
function optionalEncoding(encoding?: BufferEncoding): string {
  return raw.toString(encoding);
}
console.log("variable optional present", optionalEncoding("hex"));
console.log("variable optional absent", optionalEncoding());
console.log("variable explicit undefined", raw.toString(undefined));

// Unknown-encoding messages preserve the complete runtime string,
// including long values and embedded NULs.
const unusualBadEncodings: BufferEncoding[] = [
  "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" as BufferEncoding,
  "\u0000wat" as BufferEncoding,
];
for (const encoding of unusualBadEncodings) {
  try {
    raw.toString(encoding);
  } catch (e) {
    if (e instanceof TypeError) {
      console.log("variable bad exact", (e as NodeJS.ErrnoException).code, JSON.stringify(e.message), e.message.length);
    }
  }
}

// Node selects the byte window before resolving a runtime encoding. An
// empty buffer or a range that clamps to empty therefore returns "" even
// when the encoding name is unknown.
const emptyBadEncoding = "wat-empty" as BufferEncoding;
console.log("variable bad empty buffer", JSON.stringify(Buffer.alloc(0).toString(emptyBadEncoding)));
console.log("variable bad empty tail", JSON.stringify(raw.toString(emptyBadEncoding, raw.length)));
console.log("variable bad empty range", JSON.stringify(raw.toString(emptyBadEncoding, 2, 2)));
