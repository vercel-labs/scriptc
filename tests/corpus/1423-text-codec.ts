// The WHATWG encoder pair, composed and same-scope const store-then-call:
// utf-8 round trips, BOM stripping, and maximal-subpart replacement,
// byte-compared against Node.
const enc = new TextEncoder().encode("héllo😀");
console.log(enc.length, enc[0], enc[1], enc[2], enc[6]);
console.log(new TextDecoder().decode(enc));

// A leading BOM strips (Buffer.toString("utf8") keeps it — the one
// behavioral difference between the two decodes).
console.log(new TextDecoder().decode(new Uint8Array([0xef, 0xbb, 0xbf, 0x41, 0x42])));
console.log(new TextDecoder().decode(new Uint8Array([0xef, 0xbb, 0xbf])).length);
console.log(Buffer.from([0xef, 0xbb, 0xbf, 0x41]).toString("utf8").length);

// Invalid sequences replace per maximal subpart, exactly like Node.
console.log(JSON.stringify(new TextDecoder().decode(new Uint8Array([0x41, 0xff, 0x42]))));
console.log(JSON.stringify(new TextDecoder().decode(new Uint8Array([0xf0, 0x9f, 0x98]))));

// Zero-argument decode is "" per spec; the explicit utf-8 label works.
console.log(new TextDecoder().decode().length);
console.log(new TextDecoder("utf-8").decode(Buffer.from("hi", "utf8")));

// Round trip through both, Buffer input included.
const rt = new TextDecoder().decode(new TextEncoder().encode("round ✓ trip"));
console.log(rt === "round ✓ trip", rt);
console.log(new TextEncoder().encode("").length);

// The ordinary stored-instance idiom is compile-time alias plumbing: the
// default constructors have no effects, and supported calls resolve back
// through a stable const without materializing the codec object.
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const stored = encoder.encode("stored héllo 😀");
console.log(stored.length, decoder.decode(stored));
console.log(encoder.encode("again").length, decoder.decode(Buffer.from("twice", "utf8")));

// An explicit literal utf-8 label is equally effect-free. Function-local
// bindings take the same rewrite within their own execution scope.
function localRoundTrip(s: string): string {
  const labelledDecoder = new TextDecoder("utf-8");
  const localEncoder = new TextEncoder();
  return labelledDecoder.decode(localEncoder.encode(s));
}
console.log(localRoundTrip("local ✓"));

// Every WHATWG legacy family lowers when the label is static. The generated
// single-byte tables are each touched here; JSON escaping keeps C0/C1 and
// undefined-byte replacements visible in the differential output.
const singleByteSamples = [
  new TextDecoder("ibm866").decode(new Uint8Array([0x80])),
  new TextDecoder("iso-8859-2").decode(new Uint8Array([0xa1])),
  new TextDecoder("iso-8859-3").decode(new Uint8Array([0xa1])),
  new TextDecoder("iso-8859-4").decode(new Uint8Array([0xa1])),
  new TextDecoder("iso-8859-5").decode(new Uint8Array([0xa1])),
  new TextDecoder("iso-8859-6").decode(new Uint8Array([0xac])),
  new TextDecoder("iso-8859-7").decode(new Uint8Array([0xa1])),
  new TextDecoder("iso-8859-8").decode(new Uint8Array([0xe0])),
  new TextDecoder("iso-8859-8-i").decode(new Uint8Array([0xe1])),
  new TextDecoder("iso-8859-10").decode(new Uint8Array([0xa1])),
  new TextDecoder("iso-8859-13").decode(new Uint8Array([0xa1])),
  new TextDecoder("iso-8859-14").decode(new Uint8Array([0xa1])),
  new TextDecoder("iso-8859-15").decode(new Uint8Array([0xa4])),
  new TextDecoder("iso-8859-16").decode(new Uint8Array([0xa1])),
  new TextDecoder("koi8-r").decode(new Uint8Array([0xe1])),
  new TextDecoder("koi8-u").decode(new Uint8Array([0xa4])),
  new TextDecoder("macintosh").decode(new Uint8Array([0xdb])),
  new TextDecoder("windows-874").decode(new Uint8Array([0xa1])),
  new TextDecoder("windows-1250").decode(new Uint8Array([0x8a])),
  new TextDecoder("windows-1251").decode(new Uint8Array([0xc0])),
  new TextDecoder("windows-1252").decode(new Uint8Array([0x80])),
  new TextDecoder("windows-1253").decode(new Uint8Array([0xc1])),
  new TextDecoder("windows-1254").decode(new Uint8Array([0xd0])),
  new TextDecoder("windows-1255").decode(new Uint8Array([0xe0])),
  new TextDecoder("windows-1256").decode(new Uint8Array([0xc7])),
  new TextDecoder("windows-1257").decode(new Uint8Array([0xc0])),
  new TextDecoder("windows-1258").decode(new Uint8Array([0xd5])),
  new TextDecoder("x-mac-cyrillic").decode(new Uint8Array([0x80])),
];
console.log(JSON.stringify(singleByteSamples));

// Labels trim ASCII whitespace and fold ASCII case; latin1/ascii are the
// Encoding Standard's windows-1252 aliases, not Buffer's byte-for-byte forms.
const latinDecoder = new TextDecoder(" \tLaTiN1\r\n");
console.log(latinDecoder.decode(new Uint8Array([0x41, 0x80, 0x92, 0x42])));
console.log(new TextDecoder("ASCII").decode(new Uint8Array([0x80])));
console.log(JSON.stringify(new TextDecoder("x-user-defined").decode(new Uint8Array([0x41, 0x80, 0xff]))));

// UTF-16 has TextDecoder-specific BOM stripping and replacement for lone
// surrogates / odd trailing bytes (Buffer.toString("utf16le") differs).
console.log(new TextDecoder("utf-16le").decode(new Uint8Array([0xff, 0xfe, 0x61, 0x00, 0x3d, 0xd8, 0x00, 0xde])));
console.log(new TextDecoder("unicodefffe").decode(new Uint8Array([0xfe, 0xff, 0x00, 0x61, 0xd8, 0x3d, 0xde, 0x00])));
console.log(JSON.stringify(new TextDecoder("utf-16le").decode(new Uint8Array([0x00, 0xd8, 0x61, 0x00, 0xff]))));
console.log(JSON.stringify(new TextDecoder("utf-16le").decode(new Uint8Array([0x00, 0xd8, 0x12]))));
console.log(JSON.stringify(new TextDecoder("utf-16be").decode(new Uint8Array([0xd8, 0x00, 0x12]))));

// The multibyte families: two- and four-byte GB, traditional Chinese,
// Japanese stateful/stateless forms, and Korean.
console.log(new TextDecoder("GBK").decode(new Uint8Array([0xd6, 0xd0, 0xce, 0xc4])));
console.log(new TextDecoder("gb18030").decode(new Uint8Array([0x90, 0x30, 0x81, 0x30])));
console.log(new TextDecoder("big5").decode(new Uint8Array([0xa4, 0xa4, 0xa4, 0xe5])));
console.log(new TextDecoder("euc-jp").decode(new Uint8Array([0xc6, 0xfc, 0xcb, 0xdc, 0xb8, 0xec])));
console.log(new TextDecoder("iso-2022-jp").decode(new Uint8Array([0x1b, 0x24, 0x42, 0x46, 0x7c, 0x4b, 0x5c, 0x38, 0x6c, 0x1b, 0x28, 0x42])));
console.log(new TextDecoder("shift_jis").decode(new Uint8Array([0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea])));
console.log(new TextDecoder("euc-kr").decode(new Uint8Array([0xc7, 0xd1, 0xb1, 0xdb, 0xbe, 0xee])));

// Invalid/truncated sequences pin replacement and byte reprocessing.
console.log(JSON.stringify(new TextDecoder("gb18030").decode(new Uint8Array([0x81, 0x30, 0x41]))));
console.log(JSON.stringify(new TextDecoder("big5").decode(new Uint8Array([0x81, 0x20, 0xff]))));
console.log(JSON.stringify(new TextDecoder("euc-jp").decode(new Uint8Array([0xa1, 0x20, 0x8f]))));
console.log(JSON.stringify(new TextDecoder("shift_jis").decode(new Uint8Array([0x81, 0x20, 0x81]))));
console.log(JSON.stringify(new TextDecoder("euc-kr").decode(new Uint8Array([0xa1, 0x20, 0xa1]))));

// Recovery rules vary by converter: some invalid bytes are consumed, some
// return to the input queue, and ICU recognizes a few historical extensions.
const recoverySamples = [
  new TextDecoder("gb18030").decode(new Uint8Array([0x81, 0xff])),
  new TextDecoder("gb18030").decode(new Uint8Array([0x84, 0x31, 0xa4, 0x37])),
  new TextDecoder("big5").decode(new Uint8Array([0x81, 0xff])),
  new TextDecoder("euc-jp").decode(new Uint8Array([0xa1, 0xff])),
  new TextDecoder("euc-jp").decode(new Uint8Array([0x8e, 0xe0])),
  new TextDecoder("euc-jp").decode(new Uint8Array([0x8f, 0xea, 0x00])),
  new TextDecoder("euc-kr").decode(new Uint8Array([0xa1, 0xff])),
  new TextDecoder("euc-kr").decode(new Uint8Array([0x8e, 0xa1])),
  new TextDecoder("iso-2022-jp").decode(new Uint8Array([0x1b, 0x24])),
  new TextDecoder("iso-2022-jp").decode(new Uint8Array([0x1b, 0x24, 0x41])),
  new TextDecoder("iso-2022-jp").decode(new Uint8Array([0x1b, 0x4f])),
  new TextDecoder("iso-2022-jp").decode(new Uint8Array([0x1b, 0x28, 0x48, 0x5c, 0x7e])),
  // In JIS mode ICU groups adjacent invalid payload bytes, but SO/SI begin
  // standalone errors; a grouped CR/LF does not perform the line reset.
  new TextDecoder("iso-2022-jp").decode(new Uint8Array([0x1b, 0x24, 0x42, 0x00, 0x00])),
  new TextDecoder("iso-2022-jp").decode(new Uint8Array([0x1b, 0x24, 0x42, 0x21, 0x0e])),
  new TextDecoder("iso-2022-jp").decode(new Uint8Array([0x1b, 0x24, 0x42, 0x00, 0x0a, 0x41])),
  // Malformed escapes restore their payload in the active JIS state;
  // consecutive designations toggle ICU's replacement flag.
  new TextDecoder("iso-2022-jp").decode(new Uint8Array([0x1b, 0x24, 0x42, 0x1b, 0x24, 0x21])),
  new TextDecoder("iso-2022-jp").decode(new Uint8Array([0x1b, 0x24, 0x42, 0x1b, 0x24, 0x42, 0x1b, 0x24, 0x42])),
  new TextDecoder("iso-2022-jp").decode(new Uint8Array([0x1b, 0x26, 0x40, 0x1b, 0x24, 0x42, 0x46, 0x7c])),
  // Four-byte designation prefixes stay pending until their final byte;
  // unknown finals restore the payload while known finals are one error.
  new TextDecoder("iso-2022-jp").decode(new Uint8Array([0x1b, 0x24, 0x28, 0x00])),
  new TextDecoder("iso-2022-jp").decode(new Uint8Array([0x1b, 0x24, 0x28, 0x41])),
  new TextDecoder("iso-2022-jp").decode(new Uint8Array([0x1b, 0x25, 0x2f, 0x42])),
  // ICU's JIS-1990 announcer enters lead state even without a following
  // designation; the next two payload bytes therefore form a JIS pair.
  new TextDecoder("iso-2022-jp").decode(new Uint8Array([0x1b, 0x26, 0x40, 0x21, 0x5a])),
  // ICU emits line separators in JIS/Katakana states and resumes in ASCII.
  new TextDecoder("iso-2022-jp").decode(new Uint8Array([0x1b, 0x24, 0x42, 0x46, 0x7c, 0x0a, 0x41])),
  new TextDecoder("iso-2022-jp").decode(new Uint8Array([0x1b, 0x28, 0x49, 0x21, 0x0d, 0x41])),
];
console.log(JSON.stringify(recoverySamples));

// A compact deterministic byte sweep exercises malformed-sequence recovery,
// truncated leads, state resets between decode() calls, and sparse table
// holes. JSON is the byte-for-byte oracle artifact.
const decoderVectors: number[][] = [];
let decoderSeed = 0x6d2b79f5;
for (let i = 0; i < 96; i++) {
  const vector: number[] = [];
  for (let j = 0; j < i % 7; j++) {
    decoderSeed ^= decoderSeed << 13;
    decoderSeed ^= decoderSeed >>> 17;
    decoderSeed ^= decoderSeed << 5;
    decoderSeed >>>= 0;
    vector.push(decoderSeed >>> 24);
  }
  decoderVectors.push(vector);
}

const gbSweepDecoder = new TextDecoder("gb18030");
const gbSweep: string[] = [];
for (const vector of decoderVectors) gbSweep.push(gbSweepDecoder.decode(new Uint8Array(vector)));
console.log(JSON.stringify(gbSweep));

const big5SweepDecoder = new TextDecoder("big5");
const big5Sweep: string[] = [];
for (const vector of decoderVectors) big5Sweep.push(big5SweepDecoder.decode(new Uint8Array(vector)));
console.log(JSON.stringify(big5Sweep));

const eucJpSweepDecoder = new TextDecoder("euc-jp");
const eucJpSweep: string[] = [];
for (const vector of decoderVectors) eucJpSweep.push(eucJpSweepDecoder.decode(new Uint8Array(vector)));
console.log(JSON.stringify(eucJpSweep));

const isoJpSweepDecoder = new TextDecoder("iso-2022-jp");
const isoJpSweep: string[] = [];
for (const vector of decoderVectors) isoJpSweep.push(isoJpSweepDecoder.decode(new Uint8Array(vector)));
console.log(JSON.stringify(isoJpSweep));

const shiftJisSweepDecoder = new TextDecoder("shift_jis");
const shiftJisSweep: string[] = [];
for (const vector of decoderVectors) shiftJisSweep.push(shiftJisSweepDecoder.decode(new Uint8Array(vector)));
console.log(JSON.stringify(shiftJisSweep));

const eucKrSweepDecoder = new TextDecoder("euc-kr");
const eucKrSweep: string[] = [];
for (const vector of decoderVectors) eucKrSweep.push(eucKrSweepDecoder.decode(new Uint8Array(vector)));
console.log(JSON.stringify(eucKrSweep));

// A switch clause is still one straight-line execution region: the
// declaration dominates the call when both live in that clause.
const codecCase = 1;
switch (codecCase) {
  case 1:
    const caseEncoder = new TextEncoder();
    console.log(caseEncoder.encode("same clause").length);
    break;
}
