// RSA padding failures, each with Node's exact error: the length limit
// every padding imposes, the digests the provider resolves for OAEP, the
// decrypt-side padding checks, and RSA-PSS padding on the wrong operation.
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
    console.log(label, "| ok", value.length);
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

const message = Buffer.from("rsa padding exercise");

// OAEP takes k - 2h - 2 bytes (86 with SHA-1, 62 with SHA-256 at k = 128);
// PKCS#1 v1.5 takes k - 11 and no padding takes k at most.
attempt("oaep 86", () => crypto.publicEncrypt(pub, Buffer.alloc(86, 0x41)));
attempt("oaep 87", () => crypto.publicEncrypt(pub, Buffer.alloc(87, 0x41)));
attempt("oaep sha256 62", () =>
  crypto.publicEncrypt({ key: pub, oaepHash: "sha256" }, Buffer.alloc(62, 0x41)),
);
attempt("oaep sha256 63", () =>
  crypto.publicEncrypt({ key: pub, oaepHash: "sha256" }, Buffer.alloc(63, 0x41)),
);
attempt("pkcs1 117", () => crypto.publicEncrypt({ key: pub, padding: 1 }, Buffer.alloc(117, 0x41)));
attempt("pkcs1 118", () => crypto.publicEncrypt({ key: pub, padding: 1 }, Buffer.alloc(118, 0x41)));
attempt("none 127", () => crypto.publicEncrypt({ key: pub, padding: 3 }, Buffer.alloc(127)));
attempt("none 128", () => crypto.publicEncrypt({ key: pub, padding: 3 }, block([0])));
attempt("none 129", () => crypto.publicEncrypt({ key: pub, padding: 3 }, Buffer.alloc(129)));
attempt("pad 2", () => crypto.publicEncrypt({ key: pub, padding: 2 }, message));
attempt("pad 6", () => crypto.publicEncrypt({ key: pub, padding: 6 }, message));

// The decrypt side: the input size checks come first, then the padding
// check for the padding the caller named.
attempt("decrypt long", () => crypto.privateDecrypt(priv, Buffer.alloc(129)));
attempt("decrypt empty", () => crypto.privateDecrypt(priv, Buffer.alloc(0)));
attempt("decrypt ge n", () => crypto.privateDecrypt(priv, Buffer.alloc(128, 0xff)));
attempt("decrypt oaep garbage", () => crypto.privateDecrypt(priv, block([0x07])));
attempt("decrypt pad 7", () => crypto.privateDecrypt({ key: priv, padding: 7 }, block([0x07])));
attempt("decrypt pad 2", () => crypto.privateDecrypt({ key: priv, padding: 2 }, block([0x07])));
attempt("decrypt none", () => crypto.privateDecrypt({ key: priv, padding: 3 }, block([0])));
attempt("decrypt none long", () =>
  crypto.privateDecrypt({ key: priv, padding: 3 }, Buffer.alloc(129)),
);

// Type 1 padding for the signing pair.
attempt("sign 117", () => crypto.privateEncrypt(priv, Buffer.alloc(117, 0x41)));
attempt("sign 118", () => crypto.privateEncrypt(priv, Buffer.alloc(118, 0x41)));
attempt("sign pad 3 short", () => crypto.privateEncrypt({ key: priv, padding: 3 }, Buffer.alloc(127)));
attempt("sign pad 3", () => crypto.privateEncrypt({ key: priv, padding: 3 }, block([0])));
attempt("sign pad 5", () => crypto.privateEncrypt({ key: priv, padding: 5 }, message));
attempt("sign pad 2", () => crypto.privateEncrypt({ key: priv, padding: 2 }, message));

// OAEP digest resolution: the SHA-3 names work, SHAKE has no fixed output
// size, MD4 is not a provider digest, and an unknown name reports both.
attempt("digest sha3", () => {
  const cipher = crypto.publicEncrypt({ key: pub, oaepHash: "sha3-256" }, Buffer.alloc(30, 0x42));
  return crypto.privateDecrypt({ key: priv, oaepHash: "sha3-256" }, cipher);
});
attempt("digest unknown", () => crypto.publicEncrypt({ key: pub, oaepHash: "nope" }, message));
attempt("digest shake", () => crypto.publicEncrypt({ key: pub, oaepHash: "shake128" }, message));
attempt("digest md4", () => crypto.publicEncrypt({ key: pub, oaepHash: "md4" }, message));
