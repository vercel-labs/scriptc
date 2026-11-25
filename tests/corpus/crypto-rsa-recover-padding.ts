// publicDecrypt's type 1 padding checks, each reported at the first check
// the block fails, and privateDecrypt's implicit rejection: a PKCS#1 block
// that does not check out answers a deterministic synthetic message
// instead of an error, so a fixed ciphertext pins those bytes.
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

const pub = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQCYEGR/hPjIvMXempxI+h+to/5M
e/UKIRL2N/s8opf+NvIkp2AwxUib49sshrbzX3WqkzCMxvhebhAAf4+pdi0qCd+x
ABo/z2Q6PvX9lX8AHBG6hKPXaFNieJdnMkjK0nhYcuxxhO0qJgPGqqN9XwjV4TsM
qxNTM7PQlxY5Ufp9kQIDAQAB
-----END PUBLIC KEY-----`;

function report(label: string, error: Error): void {
  const coded = error as Error & { code?: string; library?: string; reason?: string };
  console.log(
    label,
    "|",
    coded.name,
    "|",
    coded.code,
    "|",
    coded.library,
    "|",
    coded.reason,
    "|",
    coded.message,
  );
}

function attempt(label: string, run: () => Buffer): void {
  try {
    const value = run();
    console.log(label, "| ok", value.length, value.toString("hex").slice(0, 32));
  } catch (e) {
    report(label, e as Error);
  }
}

function block(start: number[]): Buffer {
  const bytes = Buffer.alloc(128);
  for (let i = 0; i < start.length; i++) bytes[i] = start[i];
  for (let i = start.length; i < 128; i++) bytes[i] = 0xaa;
  return bytes;
}

// A block signed with no padding and recovered as type 1: each failure is
// the first check the padding does not pass.
function recovered(label: string, start: number[]): void {
  attempt(label, () => {
    const cipher = crypto.privateEncrypt({ key: priv, padding: 3 }, block(start));
    return crypto.publicDecrypt({ key: pub, padding: 1 }, cipher);
  });
}
recovered("recover valid", [0x00, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x00, 0x68, 0x69]);
recovered("recover type 2", [0x00, 0x02, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x00, 0x68, 0x69]);
recovered("recover no zero", [0x01, 0x01]);
recovered("recover short pad", [0x00, 0x01, 0xff, 0xff, 0x00, 0x68]);
recovered("recover ff none", [0x00, 0x01]);
recovered("recover bad byte", [0x00, 0x01, 0xff, 0x12, 0x00]);

// Wrong lengths and padding names on the recovery side.
attempt("recover none short", () => {
  const cipher = crypto.privateEncrypt({ key: priv, padding: 3 }, block([0]));
  return crypto.publicDecrypt({ key: pub, padding: 3 }, cipher.subarray(4));
});
attempt("recover long", () => crypto.publicDecrypt({ key: pub, padding: 3 }, Buffer.alloc(129)));
attempt("recover pad 5", () => crypto.publicDecrypt({ key: pub, padding: 5 }, block([0])));
attempt("recover pad 4", () => crypto.publicDecrypt({ key: pub, padding: 4 }, block([0])));

// Implicit rejection: the same private decryption twice answers the same
// synthetic message for a block privateEncrypt built without padding.
attempt("reject twice", () => {
  const cipher = crypto.privateEncrypt({ key: priv, padding: 3 }, block([0, 0, 0x30, 0x00]));
  const first = crypto.privateDecrypt({ key: priv, padding: 1 }, cipher);
  const second = crypto.privateDecrypt({ key: priv, padding: 1 }, cipher);
  return first.equals(second) ? first : Buffer.alloc(0);
});

// Raw private exponentiation is deterministic, so the synthetic message is
// pinned in full: it comes from the ciphertext and the key alone.
const rawBlock = crypto.privateEncrypt({ key: priv, padding: 3 }, block([0, 0, 0x30, 0x00]));
console.log("reject full", crypto.privateDecrypt({ key: priv, padding: 1 }, rawBlock).toString("hex"));
