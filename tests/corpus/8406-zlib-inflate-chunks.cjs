// Inflation over the vendored zlib's chunked inflate: inputs fed in pieces of
// 1 to 4096 bytes, output chunks of 64 bytes to 64 KiB, raw windowBits 9 to 15,
// concatenated gzip members, back-references across a 1 MiB window, and a
// truncated input. The output and the error match Node's.
const zlib = require("node:zlib");
const { createHash } = require("node:crypto");

const digest = (bytes) => `${bytes.length} ${createHash("sha256").update(bytes).digest("hex").slice(0, 16)}`;

const parts = [];
for (let i = 0; i < 20000; i++) parts.push(`row ${i % 977} ${"abcdefgh".slice(i % 8)} ${(i * 2654435761) % 4093}`);
const text = Buffer.from(parts.join("\n"));
const large = Buffer.alloc(1 << 20);
for (let i = 0; i < large.length; i++) large[i] = text[(i * 13) % text.length] ^ ((i >> 15) & 3);

const gz = zlib.gzipSync(large, { level: 6 });
for (const chunkSize of [64, 1024, 16384, 65536]) {
  console.log("gunzip chunkSize", chunkSize, digest(zlib.gunzipSync(gz, { chunkSize })));
}
for (const windowBits of [9, 10, 12, 15]) {
  const raw = zlib.deflateRawSync(text, { windowBits, level: 9 });
  console.log("raw windowBits", windowBits, digest(zlib.inflateRawSync(raw, { windowBits })));
}
const members = Buffer.concat([zlib.gzipSync(text.subarray(0, 1000)), zlib.gzipSync(text.subarray(1000, 5000))]);
console.log("members", digest(zlib.gunzipSync(members)));
try {
  zlib.inflateSync(zlib.deflateSync(text).subarray(0, 2000));
} catch (e) {
  console.log("truncated", e.code, e.errno, e.message);
}

function feed(input, pieceSize, outSize, next) {
  const inflate = zlib.createGunzip({ chunkSize: outSize });
  const hash = createHash("sha256");
  let length = 0;
  inflate.on("data", (chunk) => {
    hash.update(chunk);
    length += chunk.length;
  });
  inflate.on("end", () => {
    console.log("stream piece", pieceSize, "chunk", outSize, length, hash.digest("hex").slice(0, 16));
    next();
  });
  let offset = 0;
  const pump = () => {
    while (offset < input.length) {
      const piece = input.subarray(offset, offset + pieceSize);
      offset += pieceSize;
      if (!inflate.write(piece)) {
        inflate.once("drain", pump);
        return;
      }
    }
    inflate.end();
  };
  pump();
}

const head = zlib.gzipSync(large.subarray(0, 1 << 16), { level: 6 });
const runs = [
  [head, 1, 64],
  [gz, 7, 1024],
  [gz, 333, 4096],
  [gz, 4096, 65536],
];
const step = (i) => {
  if (i < runs.length) feed(runs[i][0], runs[i][1], runs[i][2], () => step(i + 1));
};
step(0);
