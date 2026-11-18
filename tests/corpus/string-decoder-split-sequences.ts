// StringDecoder over every encoding it accepts, fed one byte at a time:
// multi-byte UTF-8 sequences, surrogate pairs and their lone halves,
// UTF-16LE units split across writes, the hex/base64/base64url partial
// states (an odd hex digit and a one- or two-byte base64 tail carry to the
// next write), Latin-1 and ASCII pass-through, invalid and overlong
// sequences (U+FFFD replacement), the end() flush of a pending partial, an
// end() with a final buffer, a second end(), and a write after end().
// Also the constructor ladder: a missing, undefined, aliased or invalid
// encoding, and a non-Buffer write argument.
import { Buffer } from "node:buffer";
import { StringDecoder } from "node:string_decoder";

function shape(fn: () => unknown): string {
  try {
    return "ok " + JSON.stringify(fn());
  } catch (e) {
    const err = e as Error & { code?: string };
    return "ERR " + err.name + " " + String(err.code) + " " + err.message;
  }
}

const encodings = ["utf8", "utf16le", "ucs2", "latin1", "ascii", "hex", "base64", "base64url", "utf-8", "binary"] as const;
const samples: [string, Buffer][] = [
  ["ascii", Buffer.from("hello")],
  ["latin1", Buffer.from("héllo", "latin1")],
  ["utf8", Buffer.from("世界", "utf8")],
  ["astral", Buffer.from("a😀b", "utf8")],
  ["invalid", Buffer.from([0xff, 0xfe, 0x41])],
  ["overlong", Buffer.from([0xc0, 0x80, 0x41])],
  ["truncated", Buffer.from([0xe4, 0xb8])],
  ["lone-surrogate", Buffer.from([0xed, 0xa0, 0x80])],
  ["utf16", Buffer.from("ab😀", "utf16le")],
  ["utf16-half", Buffer.from("\ud83d", "utf16le")],
  ["digits", Buffer.from([0x31, 0x32, 0x33, 0x34, 0x35])],
  ["empty", Buffer.alloc(0)],
  ["one", Buffer.from([0x41])],
];
for (const encoding of encodings) {
  for (const [name, sample] of samples) {
    console.log(
      "split",
      encoding,
      name,
      shape(() => {
        const decoder = new StringDecoder(encoding);
        const out: string[] = [];
        for (let i = 0; i < sample.length; i++) out.push(decoder.write(sample.subarray(i, i + 1)));
        out.push(decoder.end());
        return out;
      }),
      shape(() => {
        const decoder = new StringDecoder(encoding);
        return [decoder.write(sample), decoder.end()];
      }),
      shape(() => new StringDecoder(encoding).end(sample)),
    );
  }
}

// Large input split at an awkward boundary, and repeated empty writes.
console.log("large", shape(() => {
  const decoder = new StringDecoder("utf8");
  const big = Buffer.from("世".repeat(200), "utf8");
  let length = 0;
  for (let i = 0; i < big.length; i += 7) length += decoder.write(big.subarray(i, i + 7)).length;
  return [length, decoder.end().length, decoder.write(Buffer.alloc(0)), decoder.end().length];
}));

// The constructor's encoding ladder.
console.log("ctor", shape(() => new StringDecoder().write(Buffer.from("hé"))));
console.log("ctor", shape(() => new StringDecoder(undefined).write(Buffer.from("hé"))));
console.log("ctor", shape(() => new StringDecoder("ucs-2").write(Buffer.from("ab", "utf16le"))));
console.log("ctor", shape(() => new StringDecoder("bogus" as unknown as BufferEncoding)));
console.log("ctor", shape(() => new StringDecoder("UTF8" as unknown as BufferEncoding).encoding));
console.log("ctor property", new StringDecoder("utf16le").encoding, new StringDecoder().encoding, new StringDecoder("latin1").encoding);

// Write/end argument ladder.
console.log("args", shape(() => new StringDecoder("utf8").write("hi" as unknown as Buffer)));
console.log("args", shape(() => new StringDecoder("utf8").write(null as unknown as Buffer)));
console.log("args", shape(() => new StringDecoder("utf8").end(undefined)));
console.log("args", shape(() => new StringDecoder("utf8").end(null as unknown as Buffer)));
console.log("lifecycle", shape(() => {
  const decoder = new StringDecoder("utf16le");
  decoder.write(Buffer.from([0x61]));
  return [decoder.end(), decoder.end(), decoder.write(Buffer.from("ok", "utf16le"))];
}));

// Other ArrayBuffer views are valid write arguments too.
console.log("views", shape(() => new StringDecoder("utf8").write(new DataView(new Uint8Array([104, 105]).buffer) as unknown as Buffer)));
console.log("views", shape(() => new StringDecoder("utf8").write(new Uint16Array([0x6968]) as unknown as Buffer)));
