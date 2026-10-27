// new StringDecoder(encoding) with an encoding known only at run time
// normalizes it as Node does: any ASCII case of a Buffer encoding name
// selects that decoder and `.encoding` answers the canonical name
// (ucs2 and utf-16le are utf16le, binary is latin1), undefined and ""
// mean utf8, and an unknown name throws a TypeError with code
// ERR_UNKNOWN_ENCODING. Literal names keep their compile-time form.
import { StringDecoder } from "node:string_decoder";

const bytes = Buffer.from([0xe2, 0x82, 0xac, 0x41, 0xc3, 0xa9, 0xff, 0x00]);

function decodeAll(encoding: string | undefined): string {
  const decoder = new StringDecoder(encoding as BufferEncoding | undefined);
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += 3) parts.push(decoder.write(bytes.subarray(i, i + 3)));
  parts.push(decoder.end());
  return `${decoder.encoding} ${JSON.stringify(parts)}`;
}

const names = [
  "utf8", "UTF-8", "Utf8", "hex", "HEX", "base64", "Base64Url", "latin1", "BINARY",
  "ascii", "utf16le", "UTF-16LE", "ucs2", "Ucs-2", "", undefined,
];
for (const name of names) console.log(JSON.stringify(name), decodeAll(name));

for (const bad of ["utf-16", "buffer", "utf 8", "latin-1"]) {
  try {
    new StringDecoder(bad as BufferEncoding);
    console.log("no throw", bad);
  } catch (error) {
    const e = error as Error & { code?: string };
    console.log(e.name, e.code, e.message);
  }
}

const fromOptions: { encoding?: BufferEncoding } = { encoding: "hex" };
const viaOption = new StringDecoder(fromOptions.encoding);
console.log(viaOption.encoding, viaOption.write(Buffer.from("hi")), viaOption.end(Buffer.from("!")));
const literal = new StringDecoder("ucs2");
console.log(literal.encoding, JSON.stringify(literal.write(Buffer.from([0x3d, 0xd8, 0x00, 0xde]))));
