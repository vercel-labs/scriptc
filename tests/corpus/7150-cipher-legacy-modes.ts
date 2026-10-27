// createCipheriv and createDecipheriv in the legacy modes: AES in ECB,
// CFB, CFB8, CFB1 and OFB, triple DES (three- and two-key) in CBC, ECB,
// CFB, CFB8, CFB1 and OFB, and bare chacha20. Fixed keys, IVs and inputs
// give Node's exact ciphertexts; chunked updates, string encodings,
// disabled padding and chacha20's 64-bit counter carry round-trip.
import { createCipheriv, createDecipheriv } from "node:crypto";

function bytes(length: number, seed: number): Buffer {
  const out = Buffer.alloc(length);
  for (let i = 0; i < length; i++) out[i] = (i * 29 + seed) & 0xff;
  return out;
}

const plaintext = Buffer.from("The five boxing wizards jump quickly; sphinx of black quartz, judge my vow.");

function encrypt(name: string, key: Buffer, iv: Buffer | null, data: Buffer, chunk: number): Buffer {
  const cipher = createCipheriv(name, key, iv);
  const parts: Buffer[] = [];
  for (let off = 0; off < data.length; off += chunk) parts.push(cipher.update(data.subarray(off, off + chunk)));
  parts.push(cipher.final());
  return Buffer.concat(parts);
}

function decrypt(name: string, key: Buffer, iv: Buffer | null, data: Buffer, chunk: number): Buffer {
  const decipher = createDecipheriv(name, key, iv);
  const parts: Buffer[] = [];
  for (let off = 0; off < data.length; off += chunk) parts.push(decipher.update(data.subarray(off, off + chunk)));
  parts.push(decipher.final());
  return Buffer.concat(parts);
}

const cases: [string, number, number][] = [];
for (const bits of [128, 192, 256])
  for (const mode of ["ecb", "cfb", "cfb8", "cfb1", "ofb"]) cases.push([`aes-${bits}-${mode}`, bits / 8, mode === "ecb" ? 0 : 16]);
for (const name of ["des-ede3-cbc", "des3", "des-ede3", "des-ede3-ecb", "des-ede3-cfb", "des-ede3-cfb8", "des-ede3-cfb1", "des-ede3-ofb"])
  cases.push([name, 24, name === "des-ede3" || name === "des-ede3-ecb" ? 0 : 8]);
for (const name of ["des-ede-cbc", "des-ede", "des-ede-ecb", "des-ede-cfb", "des-ede-ofb"])
  cases.push([name, 16, name === "des-ede" || name === "des-ede-ecb" ? 0 : 8]);
cases.push(["chacha20", 32, 16]);

for (const [name, keyLength, ivLength] of cases) {
  const key = bytes(keyLength, keyLength + 3);
  const iv = ivLength ? bytes(ivLength, 11) : null;
  const sealed = encrypt(name, key, iv, plaintext, plaintext.length);
  const chunked = encrypt(name, key, iv, plaintext, 7);
  const opened = decrypt(name, key, iv, sealed, 5);
  console.log(name.padEnd(14), sealed.length, sealed.toString("hex").slice(0, 48), chunked.equals(sealed), opened.equals(plaintext));
}

// String input and output encodings through a stream mode.
const ofb = createCipheriv("aes-128-ofb", bytes(16, 1), bytes(16, 2));
const encoded = ofb.update("68656c6c6f20776f726c64", "hex", "base64") + ofb.final("base64");
const unofb = createDecipheriv("aes-128-ofb", bytes(16, 1), bytes(16, 2));
console.log(encoded, unofb.update(encoded, "base64", "utf8") + unofb.final("utf8"));

// ECB and triple-DES CBC without padding over whole blocks.
for (const [name, keyLength, ivLength, block] of [["aes-256-ecb", 32, 0, 16], ["des-ede3-cbc", 24, 8, 8]] as const) {
  const cipher = createCipheriv(name, bytes(keyLength, 5), ivLength ? bytes(ivLength, 6) : null);
  cipher.setAutoPadding(false);
  const sealed = Buffer.concat([cipher.update(bytes(block * 3, 7)), cipher.final()]);
  const decipher = createDecipheriv(name, bytes(keyLength, 5), ivLength ? bytes(ivLength, 6) : null);
  decipher.setAutoPadding(false);
  const opened = Buffer.concat([decipher.update(sealed), decipher.final()]);
  console.log(name, "unpadded", sealed.length, sealed.toString("hex").slice(0, 32), opened.equals(bytes(block * 3, 7)));
}

// chacha20's counter is the IV's first 8 bytes, little-endian: the low
// word carries into the high word, which wraps.
const chachaKey = bytes(32, 9);
for (const counter of ["ffffffff00000000", "ffffffffffffffff", "fffffffe01000000"]) {
  const iv = Buffer.from(counter + "0102030405060708", "hex");
  const stream = encrypt("chacha20", chachaKey, iv, Buffer.alloc(200), 50);
  console.log("chacha20", counter, stream.toString("hex").slice(120, 152), stream.subarray(64, 96).toString("hex"));
}
