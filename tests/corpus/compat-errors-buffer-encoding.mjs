// Buffer.swap*'s ERR_INVALID_BUFFER_SIZE, TextDecoder's
// ERR_ENCODING_INVALID_ENCODED_DATA and the legacy URI decoding errors.
// Node's URI decoders are V8's: they throw a URIError without a `code`
// (the ERR_INVALID_URI code the errors chapter used to list is no longer
// observable from JavaScript), so that absence is printed too.
import { fileURLToPath } from "node:url";

const kind = (e) => (e instanceof TypeError ? "TypeError" : e instanceof RangeError ? "RangeError" : e instanceof URIError ? "URIError" : e instanceof Error ? "Error" : typeof e);
function shape(label, fn) {
  try {
    console.log(label, "ok", String(fn()));
  } catch (e) {
    console.log(label, kind(e), e.name, e.code, JSON.stringify(e.message));
  }
}

for (const width of [16, 32, 64]) {
  shape(`swap${width} short`, () => {
    const bytes = Buffer.alloc(width / 8 + 1);
    if (width === 16) bytes.swap16();
    else if (width === 32) bytes.swap32();
    else bytes.swap64();
  });
}
shape("swap16 even", () => Buffer.from([1, 2]).swap16().length);

const decoders = [
  ["utf-8", Uint8Array.of(0xff)],
  ["utf-8", Uint8Array.of(0xe0, 0xa4)],
  ["utf-16le", Uint8Array.of(0x00)],
  ["utf-16be", Uint8Array.of(0x00)],
];
for (const [encoding, bytes] of decoders) {
  shape(`decode ${encoding} ${bytes.length}`, () => new TextDecoder(encoding, { fatal: true }).decode(bytes));
}
shape("decode stream", () => {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  decoder.decode(Uint8Array.of(0xe0, 0xa4), { stream: true });
  return decoder.decode();
});
shape("decode latin1", () => new TextDecoder("latin1", { fatal: true }).decode(Uint8Array.of(0xff)));
// Without fatal the replacement character is returned, not an error.
console.log("replacement", new TextDecoder("utf-8").decode(Uint8Array.of(0xff)) === "�");

for (const [label, run] of [
  ["decodeURI", () => decodeURI("%E0%A4%A")],
  ["decodeURIComponent", () => decodeURIComponent("%")],
  ["encodeURI", () => encodeURI("\uD800")],
  ["encodeURIComponent", () => encodeURIComponent("\uDC00")],
  ["fileURLToPath", () => fileURLToPath("file:///%E0%A4%A")],
]) {
  shape(label, run);
}
