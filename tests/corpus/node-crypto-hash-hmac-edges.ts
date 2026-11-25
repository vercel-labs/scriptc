// Hash, Hmac and the one-shot crypto.hash match Node: every digest name in
// Node's table (including the OpenSSL composite md5-sha1 and the BLAKE2,
// RIPEMD-160, SM3 and SHAKE families), streaming updates with mixed input
// types and encodings, Hash.copy() snapshots and their outputLength,
// digest encodings (unknown ones answer the bytes), the finalized-state
// errors of Hash.update/digest/copy against Hmac.digest's empty answer,
// and Node's argument errors for data, encodings, algorithms, keys and
// options.
import { createHash, createHmac, createSecretKey, hash, pbkdf2 } from "node:crypto";

function text(value: string | Buffer): string {
  return typeof value === "string" ? `str:${value}` : `buf:${value.toString("hex")}`;
}

function attempt(label: string, run: () => string | Buffer): void {
  try {
    console.log(label, "ok", text(run()));
  } catch (e) {
    const err = e as { code?: string; message: string };
    console.log(label, "threw", err.code ?? "nocode", "|", err.message);
  }
}

const ALGORITHMS = [
  "md5",
  "sha1",
  "sha224",
  "sha256",
  "sha384",
  "sha512",
  "sha512-224",
  "sha512-256",
  "sha3-224",
  "sha3-256",
  "sha3-384",
  "sha3-512",
  "shake128",
  "shake256",
  "ripemd160",
  "sm3",
  "md5-sha1",
  "blake2b512",
  "blake2s256",
];
for (const algorithm of ALGORITHMS) {
  console.log("alg", algorithm, createHash(algorithm).update("abc").digest("hex"));
}

// Streaming: mixed input types, encodings and an empty update.
const streamed = createHash("sha256");
streamed.update("héllo");
streamed.update("68656c6c6f", "hex");
streamed.update(Buffer.from("hello"));
streamed.update(new Uint8Array([104, 105]));
streamed.update(new DataView(new Uint8Array([33]).buffer));
streamed.update("");
console.log("streamed", streamed.digest("base64url"));

// update() returns the receiver and accepts every Buffer encoding name.
for (const encoding of [
  "utf8",
  "utf-8",
  "UTF8",
  "latin1",
  "binary",
  "ascii",
  "utf16le",
  "ucs2",
  "base64",
  "base64url",
  "hex",
  "",
]) {
  const data = encoding === "hex" || encoding === "base64" || encoding === "base64url" ? "68c3a9" : "héllo";
  attempt(`encoding ${encoding}`, () => createHash("sha256").update(data, encoding as "base64").digest("hex"));
}
attempt("encoding unknown", () => createHash("sha256").update("hello", "bogus" as "hex").digest("hex"));

// digest(): every encoding answers its string; the bytes of a falsy or
// unknown encoding are the .cjs program's argument matrix.
for (const encoding of ["hex", "base64", "base64url", "latin1", "utf8", "utf16le", "ascii"]) {
  attempt(`digest ${encoding}`, () => createHash("sha256").update("x").digest(encoding as "hex"));
}
attempt("digest twice", () => {
  const h = createHash("sha256").update("x");
  h.digest("hex");
  return h.digest("hex");
});
attempt("update after digest", () => {
  const h = createHash("sha256").update("x");
  h.digest("hex");
  return h.update("y").digest("hex");
});
attempt("copy after digest", () => {
  const h = createHash("sha256").update("x");
  h.digest("hex");
  return h.copy().digest("hex");
});
attempt("copy branches", () => {
  const h = createHash("sha256").update("ab");
  const c = h.copy();
  h.update("c");
  c.update("d");
  return `${h.digest("hex")} ${c.digest("hex")}`;
});
attempt("copy chain", () => {
  const h = createHash("sha256");
  const c = h.copy();
  h.update("x");
  c.update("x");
  return `${h.copy().digest("hex")} ${c.digest("hex")}`;
});

// createHash options: SHAKE output lengths, the copy override, and the
// checks Node applies to both.
attempt("shake128 8", () => createHash("shake128", { outputLength: 8 }).update("x").digest("hex"));
attempt("shake256 32", () => createHash("shake256", { outputLength: 32 }).update("x").digest("hex"));
attempt("shake128 default", () => `${createHash("shake128").update("x").digest("hex").length}`);
attempt("sha256 outputLength 32", () => createHash("sha256", { outputLength: 32 }).update("x").digest("hex"));
attempt("sha256 outputLength 16", () => createHash("sha256", { outputLength: 16 }).update("x").digest("hex"));
attempt("shake128 copy 4", () =>
  createHash("shake128", { outputLength: 4 })
    .update("x")
    .copy({ outputLength: 8 })
    .digest("hex"),
);
attempt("copy outputLength 16", () => createHash("shake128").update("x").copy({ outputLength: 16 }).digest("hex"));
attempt("outputLength negative", () => createHash("shake128", { outputLength: -1 }).update("x").digest("hex"));
attempt("outputLength big", () => createHash("shake128", { outputLength: 4294967296 }).update("x").digest("hex"));
attempt("options null", () => createHash("sha256", null as never).update("x").digest("hex"));
attempt("options number", () => createHash("sha256", 5 as never).update("x").digest("hex"));
attempt("options encoding", () => createHash("sha256", { encoding: "hex" } as never).update("x").digest("hex"));
attempt("unknown algorithm", () => createHash("bogus").update("x").digest("hex"));

// The one-shot form: default hex, encodings, options and data types.
attempt("hash default", () => hash("sha256", "x"));
attempt("hash base64", () => hash("sha256", "x", "base64"));
attempt("hash options", () => hash("sha256", "x", { outputEncoding: "base64url" }));
attempt("hash empty options", () => hash("sha256", "x", {}));
attempt("hash shake options", () => hash("shake256", "x", { outputLength: 16, outputEncoding: "hex" }));
attempt("hash shake buffer", () => hash("shake128", "x", { outputLength: 16 }));
attempt("hash buffer", () => hash("sha256", Buffer.from("x"), "hex"));
attempt("hash typed", () => hash("sha256", new Uint8Array([120]), "hex"));
attempt("hash dataview", () => hash("sha256", new DataView(new Uint8Array([120]).buffer), "hex"));
attempt("hash number data", () => hash("sha256", 5 as never, "hex"));
attempt("hash unknown algorithm", () => hash("bogus" as "sha256", "x", "hex"));

// HMAC: keys of every kind, encodings and KeyObjects.
for (const algorithm of ["sha256", "sha512", "sha1", "md5", "sha3-256", "blake2b512", "ripemd160"]) {
  console.log("hmac alg", algorithm, createHmac(algorithm, "key").update("abc").digest("hex"));
}
attempt("hmac key Buffer", () => createHmac("sha256", Buffer.from("key")).update("x").digest("hex"));
attempt("hmac key typed", () => createHmac("sha256", new Uint8Array([107, 101, 121])).update("x").digest("hex"));
attempt("hmac key dataview", () =>
  createHmac("sha256", new DataView(new Uint8Array([107]).buffer)).update("x").digest("hex"),
);
attempt("hmac key empty", () => createHmac("sha256", "").update("x").digest("hex"));
attempt("hmac key hex", () => createHmac("sha256", "6b6579", { encoding: "hex" } as never).update("x").digest("hex"));
attempt("hmac key base64", () =>
  createHmac("sha256", "a2V5", { encoding: "base64" } as never).update("x").digest("hex"),
);
attempt("hmac key object", () => createHmac("sha256", createSecretKey(Buffer.from("key"))).update("x").digest("hex"));
attempt("hmac key object hex", () =>
  createHmac("sha256", createSecretKey(Buffer.from("key"))).update("x").digest("hex"),
);
attempt("hmac key number", () => createHmac("sha256", 5 as never).update("x").digest("hex"));
attempt("hmac key object literal", () => createHmac("sha256", { key: "k" } as never).update("x").digest("hex"));
attempt("hmac unknown digest", () => createHmac("bogus", "k").update("x").digest("hex"));
attempt("hmac shake digest", () => createHmac("shake128", "k").update("x").digest("hex"));
attempt("hmac digest twice", () => {
  const h = createHmac("sha256", "k").update("x");
  h.digest("hex");
  return h.digest("hex");
});
attempt("hmac digest twice buffer", () => {
  const h = createHmac("sha256", "k").update("x");
  h.digest();
  return h.digest();
});
attempt("hmac update after digest", () => {
  const h = createHmac("sha256", "k").update("x");
  h.digest("hex");
  return h.update("y").digest("hex");
});
attempt("hmac update encodings", () => createHmac("sha256", "k").update("6869", "hex").update("aGk=", "base64").digest("hex"));
attempt("hmac update number", () => createHmac("sha256", "k").update(5 as never).digest("hex"));

// The stream members of Hash and Hmac answer the same values.
attempt("hash stream", () => {
  const h = createHash("sha256");
  return `${h.readableLength === 0} ${h.writableLength === 0} ${h.digest("hex")}`;
});

// Asynchronous pbkdf2 delivers (null, key) on success and the error alone
// when the derivation fails, so the key reads as undefined on that path.
pbkdf2("p", "s", 1, 16, "sha256", (error: Error | null, key: Buffer) => {
  console.log("pbkdf2 ok", error === null, key.toString("hex"));
  pbkdf2("p", "s", 1, 0, "sha256", (inner: Error | null, innerKey: Buffer) => {
    console.log("pbkdf2 failed", inner === null, inner !== null ? inner.message : "-", innerKey === undefined);
  });
});
