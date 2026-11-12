// zlib one-shot byte inputs that are not a Uint8Array: another TypedArray,
// a DataView with an offset/length, or an ArrayBuffer. Node reads the view's
// bytes (never its elements), so scriptc's static lowering does the same:
// the decompressed bytes and crc32 values print, never compressed bytes
// (zlib builds differ). crc32 takes the views but not an ArrayBuffer, which
// its Node signature rejects at compile time, and the async forms convert
// the same inputs.
import * as zlib from "node:zlib";
import { promisify } from "node:util";

const words = new Uint16Array([0x6968, 0x2121]); // "hi!!"
const ints = new Int32Array([0x64636261, 0x21212121]); // "abcd!!!!"
const floats = new Float32Array([1, 2]);
const view = new DataView(words.buffer, 2, 2); // "!!"
const bytes = new Uint8Array([104, 105, 33, 33]);

function show(label: string, value: Buffer): void {
  console.log(label, value.length, value.toString("latin1"), value.toString("hex"));
}

show("u16", zlib.inflateSync(zlib.deflateSync(words)));
show("u16 subarray", zlib.inflateSync(zlib.deflateSync(words.subarray(1))));
show("i32", zlib.inflateSync(zlib.deflateSync(ints)));
show("f32", zlib.inflateSync(zlib.deflateSync(floats)));
show("dataview", zlib.inflateSync(zlib.deflateSync(view)));
show("arraybuffer", zlib.inflateSync(zlib.deflateSync(bytes.buffer)));
show("gzip u16", zlib.gunzipSync(zlib.gzipSync(words)));
show("gzip dataview", zlib.gunzipSync(zlib.gzipSync(view)));
show("raw i32", zlib.inflateRawSync(zlib.deflateRawSync(ints)));

console.log("crc32 u16", zlib.crc32(words));
console.log("crc32 subarray", zlib.crc32(words.subarray(1)));
console.log("crc32 i32", zlib.crc32(ints));
console.log("crc32 dataview", zlib.crc32(view));
console.log("crc32 seed", zlib.crc32(view, 12345));

for (const seed of [-1, 1.5, 4294967296]) {
  try {
    console.log("crc32 seed", seed, zlib.crc32(view, seed));
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    console.log("crc32 seed", seed, err.name, err.code, err.message);
  }
}

console.log("brotli", zlib.brotliDecompressSync(zlib.brotliCompressSync(ints)).toString());
console.log("zstd", zlib.zstdDecompressSync(zlib.zstdCompressSync(view)).toString());

const gzip = promisify(zlib.gzip);
const deflate = promisify(zlib.deflate);

async function main(): Promise<void> {
  show("promise arraybuffer", zlib.gunzipSync(await gzip(bytes.buffer)));
  show("promise dataview", zlib.inflateSync(await deflate(view)));
  show("promise f32", zlib.inflateSync(await deflate(floats)));

  zlib.gzip(ints, (error, packed) => {
    console.log("callback i32", error, zlib.gunzipSync(packed).toString());
    zlib.inflate(zlib.deflateSync(view), { chunkSize: 64 }, (error2, plain) => {
      console.log("callback dataview", error2, plain.toString());
      stream();
    });
  });
}

// The stream writable side takes the same views; an ArrayBuffer is the one
// value it rejects, with Node's "chunk" message.
function stream(): void {
  const gzipStream = zlib.createGzip();
  const parts: Buffer[] = [];
  gzipStream.on("data", (chunk: Buffer) => parts.push(chunk));
  gzipStream.on("end", () => {
    console.log("stream views", zlib.gunzipSync(Buffer.concat(parts)).toString());
  });
  gzipStream.write(ints);
  gzipStream.write(view);
  try {
    gzipStream.write(bytes.buffer);
    console.log("stream arraybuffer accepted");
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    console.log("stream arraybuffer", err.name, err.code, err.message);
  }
  gzipStream.end();
}

main();
