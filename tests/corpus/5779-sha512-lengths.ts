// SHA-384 and SHA-512 over every length from 0 to 520 bytes, fed whole and
// in 1-, 7-, 100- and 128-byte updates, then over 1 MiB, and HMAC-SHA512
// over a few lengths. Each length's digests are folded into one running
// SHA-512 so the output stays short. The CPU's SHA-512 kernel (vector or
// SHA-512 instructions) and the portable blocks give the same digests.
import { createHash, createHmac } from "node:crypto";

const data = Buffer.alloc(1 << 20);
let x = 0x9e3779b9;
for (let i = 0; i < data.length; i++) {
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  data[i] = x & 0xff;
}

function digest(algorithm: string, input: Buffer, chunk: number): Buffer {
  const hash = createHash(algorithm);
  if (chunk === 0) hash.update(input);
  else for (let at = 0; at < input.length; at += chunk) hash.update(input.subarray(at, at + chunk));
  return hash.digest();
}

for (const algorithm of ["sha384", "sha512"]) {
  for (const chunk of [0, 1, 7, 100, 128]) {
    const fold = createHash("sha512");
    for (let length = 0; length <= 520; length++) fold.update(digest(algorithm, data.subarray(0, length), chunk));
    console.log(algorithm, "chunk", chunk, fold.digest("hex").slice(0, 32));
  }
  console.log(algorithm, "1 MiB", digest(algorithm, data, 0).toString("hex").slice(0, 32), digest(algorithm, data, 4096).toString("hex").slice(0, 32));
}
console.log("abc", createHash("sha512").update("abc").digest("hex"));
for (const length of [0, 1, 111, 112, 127, 128, 129, 255, 256, 1000]) {
  console.log("hmac", length, createHmac("sha512", "key").update(data.subarray(0, length)).digest("hex").slice(0, 32));
}
