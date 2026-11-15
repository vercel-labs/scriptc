// The RSA calls read padding, oaepHash, mgf1Hash, oaepLabel and encoding
// off the options object before they convert `padding`, and the conversion
// runs a caller-supplied valueOf. A hook that deletes the other members
// must leave each value the operation already read in place, exactly as
// Node's destructuring does, and must not disturb the resolved key.
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

const message = Buffer.from("option coercion");

function report(label: string, run: () => string): void {
  try {
    console.log(label, "ok", run());
  } catch (e) {
    const coded = e as Error & { code?: string };
    console.log(label, "err", coded.name, coded.code, coded.message);
  }
}

// OAEP: the hook deletes the hash, label and padding members while the
// conversion runs; the operation still uses the values it read first.
{
  const options: any = {};
  options.key = pub;
  options.oaepHash = "sha256";
  options.mgf1Hash = "sha256";
  options.oaepLabel = Buffer.from("coercion label");
  options.padding = {
    valueOf(): number {
      delete options.oaepHash;
      delete options.mgf1Hash;
      delete options.oaepLabel;
      delete options.padding;
      return crypto.constants.RSA_PKCS1_OAEP_PADDING;
    },
  };
  report("roundtrip", () => {
    const ciphertext = crypto.publicEncrypt(options, message);
    const plaintext = crypto.privateDecrypt(
      { key: priv, oaepHash: "sha256", oaepLabel: Buffer.from("coercion label") },
      ciphertext,
    );
    return plaintext.toString();
  });
}

// A bad oaepHash is still the value that was read before the hook ran, so
// its type error names the member, not a missing one.
{
  const options: any = {};
  options.key = pub;
  options.oaepHash = 42;
  options.padding = {
    valueOf(): number {
      delete options.oaepHash;
      return crypto.constants.RSA_PKCS1_OAEP_PADDING;
    },
  };
  report("bad-hash", () => String(crypto.publicEncrypt(options, message).length));
}

// Deleting the key member after the key was resolved leaves the operation
// with the key it decoded.
{
  const options: any = {};
  options.key = pub;
  options.padding = {
    valueOf(): number {
      delete options.key;
      return crypto.constants.RSA_PKCS1_PADDING;
    },
  };
  report("deleted-key", () => String(crypto.publicEncrypt(options, message).length));
}

// The message's encoding is likewise the one from before the hook.
{
  const options: any = {};
  options.key = pub;
  options.encoding = "utf8";
  options.padding = {
    valueOf(): number {
      delete options.encoding;
      return crypto.constants.RSA_PKCS1_PADDING;
    },
  };
  report("deleted-encoding", () => String(crypto.publicEncrypt(options, "string message").length));
}
