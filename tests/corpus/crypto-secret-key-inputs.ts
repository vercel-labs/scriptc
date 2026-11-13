// createSecretKey decodes a string as Buffer.from does: the encoding is
// read only when it is a known name, so an empty one, "buffer" and a
// non-string read as UTF-8, while an unknown name throws. equals() compares
// secret keys of the same bytes and rejects everything that is not a
// KeyObject.
import * as crypto from "node:crypto";

function attempt(label: string, run: () => unknown): void {
  try {
    const value = run();
    console.log(label, "ok", Buffer.isBuffer(value) ? value.toString("hex") : String(value));
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    console.log(label, "throws", err.name, err.code, err.message);
  }
}

const text = "secret key bytes";
const utf8 = crypto.createSecretKey(text);
attempt("utf8", () => utf8.export().toString("hex"));
for (const encoding of ["utf8", "utf-8", "hex", "base64", "base64url", "latin1", "binary", "ascii", "utf16le", "ucs2"] as const) {
  const bytes = Buffer.from(text, encoding);
  attempt(`encoding ${encoding}`, () => crypto.createSecretKey(text, encoding).export().equals(bytes));
}
attempt("empty encoding", () => crypto.createSecretKey(text, "" as "utf8").export().equals(Buffer.from(text)));
attempt("buffer encoding", () => crypto.createSecretKey(text, "buffer" as "utf8").export().equals(Buffer.from(text)));
attempt("number encoding", () => crypto.createSecretKey(text, 5 as unknown as "utf8").export().equals(Buffer.from(text)));
attempt("unknown encoding", () => crypto.createSecretKey(text, "nope" as "utf8"));

// The key argument itself: bytes in any view, or a string; nothing else.
attempt("no key", () => crypto.createSecretKey(undefined as unknown as string));
attempt("null key", () => crypto.createSecretKey(null as unknown as string));
attempt("number key", () => crypto.createSecretKey(5 as unknown as string));
attempt("array key", () => crypto.createSecretKey([1, 2, 3] as unknown as string));
attempt("buffer key", () => crypto.createSecretKey(Buffer.from([104, 105])).export().toString("hex"));
attempt("uint8 key", () => crypto.createSecretKey(new Uint8Array([104, 105])).export().toString("hex"));
attempt("dataview key", () => crypto.createSecretKey(new DataView(new Uint8Array([104, 105]).buffer)).export().toString("hex"));
attempt("arraybuffer key", () => crypto.createSecretKey(new Uint8Array([104, 105]).buffer).export().toString("hex"));

// equals: the same bytes, or another kind of KeyObject.
attempt("type", () => utf8.type);
attempt("symmetricKeySize", () => utf8.symmetricKeySize);
attempt("equals same", () => utf8.equals(crypto.createSecretKey(text)));
attempt("equals other bytes", () => utf8.equals(crypto.createSecretKey("other")));
attempt("equals empty", () => utf8.equals(crypto.createSecretKey("")));
const pair = crypto.generateKeyPairSync("rsa", { modulusLength: 1024 });
attempt("equals private", () => utf8.equals(pair.privateKey));
attempt("equals public", () => utf8.equals(pair.publicKey));
attempt("equals null", () => utf8.equals(null as unknown as crypto.KeyObject));
attempt("equals undefined", () => utf8.equals(undefined as unknown as crypto.KeyObject));
attempt("equals string", () => utf8.equals(text as unknown as crypto.KeyObject));
attempt("equals number", () => utf8.equals(5 as unknown as crypto.KeyObject));
attempt("equals object", () => utf8.equals({} as unknown as crypto.KeyObject));
attempt("equals array", () => utf8.equals([1] as unknown as crypto.KeyObject));
