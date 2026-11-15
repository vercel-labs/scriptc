// OAEP's decode over crafted blocks: a valid encoding built here decrypts to
// its message (empty and not), and each check the decode makes — the leading
// zero byte, the label hash, the 0x01 separator and its place after the hash,
// and a label that does not match — answers the provider's one decoding error.
import * as crypto from "node:crypto";

const priv = `-----BEGIN PRIVATE KEY-----
MIICdQIBADANBgkqhkiG9w0BAQEFAASCAl8wggJbAgEAAoGBAJgQZH+E+Mi8xd6a
nEj6H62j/kx79QohEvY3+zyil/428iSnYDDFSJvj2yyGtvNfdaqTMIzG+F5uEAB/
j6l2LSoJ37EAGj/PZDo+9f2VfwAcEbqEo9doU2J4l2cySMrSeFhy7HGE7SomA8aq
o31fCNXhOwyrE1Mzs9CXFjlR+n2RAgMBAAECgYATFiunHeekOp2TfVCUkGCdiPII
Y560MMaShSBR0g7F59uo4iFevcSJXKZMBnS8Q4Ufbe4wHWFbaPE1Ps2ndZ/hb2Yv
fYz/e3q/4CU3/ECcGZH9PvIRIYugFtYgmBffGamN3s6+QT+hVdsV+QKOVDj6ZAhH
WUWswx4Ivk+tp0i8gQJBAMi3OS9rf7Pf5rnkbwNwEYw1Xyl17LZ3Qs0iv9PSFLYT
RapLu+SMIwA8MJdgzXAo3kAeOyJmCIfjQ3LhCHQNr8kCQQDB8qndnRqXjq2uHTEp
iTnOeR5Em2XCNLR5p9WLov2EQXxVlgh4bGZksV8M9SeZgDh0Jztrw9J1NDRfwor2
f5OJAkBwEiYi/SIL3Hvm1c7Km5ugrvhYnRiz9TlecwWrD0UzOOWQJcNe5IRykCkN
jSaIdrlKEdcw6Mngnhu+HDptGmtJAkBgXyki8q7FAmOw8dZ88jAkNbDhnGoK/09y
aABHe30Hm9ahXITm+c5DWJOHh8Xek4T5yojPOqW4EXG4551PcQMpAkA6a/7YzMor
LqjY5jLcv8HP8gHsxzI575e2pgq8ItyQBQeNU7Vpo8QZfXXkl5NvawJwNCSToZus
HVJSB0FQ+2sQ
-----END PRIVATE KEY-----`;

const key = crypto.createPrivateKey(priv);
const pub = crypto.createPublicKey(key);
const k = 128;
const h = 20; // SHA-1's digest, OAEP's default
const dbLen = k - h - 1;

function xor(a: Buffer, b: Buffer): Buffer {
  const out = Buffer.alloc(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] ^ b[i];
  return out;
}

function mgf1(seed: Buffer, length: number): Buffer {
  const out: Buffer[] = [];
  let produced = 0;
  for (let counter = 0; produced < length; counter++) {
    const count = Buffer.alloc(4);
    count.writeUInt32BE(counter);
    const block = crypto.createHash("sha1").update(seed).update(count).digest();
    out.push(block);
    produced += block.length;
  }
  return Buffer.concat(out).subarray(0, length);
}

// DB = lHash || PS || 0x01 || M, masked with a fixed seed so the program is
// deterministic; `separator` moves the 0x01, or removes it at -1, and `pad`
// puts one byte that is neither zero nor the separator in the padding.
function encode(
  message: Buffer,
  label = Buffer.alloc(0),
  separator = dbLen - message.length - 1,
  pad = 0,
): Buffer {
  const db = Buffer.alloc(dbLen);
  crypto.createHash("sha1").update(label).digest().copy(db);
  if (separator >= 0) {
    db[separator] = 0x01;
    message.copy(db, separator + 1);
  }
  if (pad !== 0) db[h] = pad;
  const seed = Buffer.alloc(h, 0x5a);
  const maskedDb = xor(db, mgf1(seed, dbLen));
  const maskedSeed = xor(seed, mgf1(maskedDb, h));
  return Buffer.concat([Buffer.from([0]), maskedSeed, maskedDb]);
}

// The ciphertext whose private operation answers `em`: the raw public
// operation over the private key's public half.
function ciphertext(em: Buffer): Buffer {
  return crypto.publicEncrypt({ key: pub, padding: crypto.constants.RSA_NO_PADDING }, em);
}

function report(label: string, error: Error): void {
  const coded = error as Error & { code?: string; library?: string; reason?: string };
  console.log(label, "|", coded.name, "|", coded.code, "|", coded.library, "|", coded.reason, "|", coded.message);
}

function attempt(label: string, run: () => Buffer): void {
  try {
    const value = run();
    console.log(label, "| ok", value.length, JSON.stringify(value.toString()));
  } catch (e) {
    report(label, e as Error);
  }
}

function decrypt(label: string, em: Buffer, options: { oaepLabel?: Buffer } = {}): void {
  attempt(label, () => crypto.privateDecrypt({ key, ...options }, ciphertext(em)));
}

decrypt("message", encode(Buffer.from("oaep decode")));
decrypt("empty", encode(Buffer.alloc(0)));
decrypt("label", encode(Buffer.from("tagged"), Buffer.from("context")));
decrypt("label ok", encode(Buffer.from("tagged"), Buffer.from("context")), { oaepLabel: Buffer.from("context") });
decrypt("label wrong", encode(Buffer.from("tagged"), Buffer.from("context")), { oaepLabel: Buffer.from("other") });
decrypt("label absent", encode(Buffer.from("tagged"), Buffer.from("context")));

const mangled = encode(Buffer.from("oaep decode"));
mangled[0] = 1;
decrypt("leading nonzero", mangled);

const seedBit = encode(Buffer.from("oaep decode"));
seedBit[1] ^= 1;
decrypt("seed bit", seedBit);

const truncated = encode(Buffer.from("oaep decode"));
truncated[1 + h + 5] ^= 1;
decrypt("db bit", truncated);

decrypt("no separator", encode(Buffer.from("oaep decode"), Buffer.alloc(0), -1));
decrypt("separator at hash", encode(Buffer.from("tight"), Buffer.alloc(0), h));
decrypt("nonzero pad", encode(Buffer.from("padding"), Buffer.alloc(0), h + 4, 0x02));
