// MD5 and md5-sha1 over every length from 0 to 520 bytes, fed whole and
// in 1-, 7-, 64- and 100-byte updates, then over 1 MiB, and HMAC-MD5
// over a few lengths. Each length's digests are folded into one running
// SHA-512 so the output stays short.
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

for (const algorithm of ["md5", "md5-sha1"]) {
  for (const chunk of [0, 1, 7, 64, 100]) {
    const fold = createHash("sha512");
    for (let length = 0; length <= 520; length++) fold.update(digest(algorithm, data.subarray(0, length), chunk));
    console.log(algorithm, "chunk", chunk, fold.digest("hex").slice(0, 32));
  }
  console.log(algorithm, "1 MiB", digest(algorithm, data, 0).toString("hex").slice(0, 32), digest(algorithm, data, 4096).toString("hex").slice(0, 32));
}
console.log("abc", createHash("md5").update("abc").digest("hex"));
for (const length of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000]) {
  console.log("hmac", length, createHmac("md5", "key").update(data.subarray(0, length)).digest("hex").slice(0, 32));
}
