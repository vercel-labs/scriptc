// Compressed zlib bytes over the vendored zlib, the copy Node bundles: deflate,
// raw deflate and gzip output match Node's for every level, strategy, memLevel,
// windowBits and dictionary, for text, binary and a 1 MiB input that slides the
// window, and for streams that flush and change parameters between writes.
import { createHash } from "node:crypto";
import {
  constants,
  createDeflate,
  createGzip,
  deflateRawSync,
  deflateSync,
  gunzipSync,
  gzipSync,
  inflateRawSync,
  inflateSync,
  type Deflate,
  type Gzip,
  type ZlibOptions,
} from "node:zlib";

const digest = (bytes: Buffer): string =>
  `${bytes.length} ${createHash("sha256").update(bytes).digest("hex").slice(0, 16)}`;

const words = ["stream", "pipeline", "émetteur", "π", "buffer", "deflate", "\u0000", "window"];
const parts: string[] = [];
for (let i = 0; i < 3000; i++) parts.push(`${words[i % words.length]}-${(i * 7919) % 1000}`);
const text = Buffer.from(parts.join(" "), "utf8");

let seed = 0x2545f491;
const binary = Buffer.alloc(20000);
for (let i = 0; i < binary.length; i++) {
  seed = (seed * 1103515245 + 12345) >>> 0;
  binary[i] = i % 3 === 0 ? seed >>> 24 : (i >> 4) & 0xff;
}

const large = Buffer.alloc(1 << 20);
for (let i = 0; i < large.length; i++) large[i] = text[(i * 31) % text.length]! ^ ((i >> 12) & 7);

for (const level of [-1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9]) {
  const deflated = deflateSync(text, { level });
  console.log("deflate", level, digest(deflated), inflateSync(deflated).equals(text));
  console.log("raw", level, digest(deflateRawSync(binary, { level })));
  console.log("gzip", level, digest(gzipSync(text, { level })));
}

const variants: [string, ZlibOptions][] = [
  ["filtered", { strategy: constants.Z_FILTERED }],
  ["huffman only", { strategy: constants.Z_HUFFMAN_ONLY }],
  ["rle", { strategy: constants.Z_RLE }],
  ["fixed", { strategy: constants.Z_FIXED }],
  ["memLevel 1", { memLevel: 1 }],
  ["memLevel 9", { memLevel: 9 }],
  ["windowBits 9", { windowBits: 9 }],
  ["windowBits 12", { windowBits: 12 }],
  ["level 9 memLevel 9", { level: 9, memLevel: 9 }],
  ["dictionary", { dictionary: Buffer.from("stream pipeline buffer deflate window") }],
];
for (const [label, options] of variants) {
  const deflated = deflateSync(text, options);
  console.log(label, digest(deflated), digest(deflateRawSync(binary, options)));
  console.log(label, "inflates", inflateSync(deflated, options).equals(text));
}

for (const level of [1, 6, 9]) {
  const gz = gzipSync(large, { level });
  console.log("1 MiB gzip", level, digest(gz), gunzipSync(gz).equals(large));
  const raw = deflateRawSync(large, { level, windowBits: 10 });
  console.log("1 MiB raw windowBits 10", level, digest(raw), inflateRawSync(raw, { windowBits: 10 }).equals(large));
}

function collect(stream: Deflate | Gzip, label: string, done: () => void): void {
  const chunks: Buffer[] = [];
  stream.on("data", (chunk: Buffer) => chunks.push(chunk));
  stream.on("end", () => {
    console.log(label, digest(Buffer.concat(chunks)));
    done();
  });
}

const flushed = createDeflate({ level: 6 });
collect(flushed, "stream sync flush", () => {
  const changed = createGzip({ level: 1 });
  collect(changed, "stream params", () => console.log("done"));
  changed.write(text.subarray(0, 8000));
  changed.flush(constants.Z_FULL_FLUSH, () => {
    changed.params(9, constants.Z_DEFAULT_STRATEGY, () => {
      changed.write(text.subarray(8000));
      changed.end(binary);
    });
  });
});
flushed.write(text.subarray(0, 5000));
flushed.flush(constants.Z_SYNC_FLUSH, () => {
  flushed.write(binary);
  flushed.end(text.subarray(5000));
});
