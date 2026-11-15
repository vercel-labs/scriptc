// Cipheriv/Decipheriv setAAD: Node's state machine and encoding rules. An
// empty setAAD is a no-op at any point before final(), including after the
// data; a non-empty one after data and any setAAD after final() throw
// ERR_CRYPTO_INVALID_STATE, and a refused setAAD leaves the cipher usable.
// The AAD bytes feed the authentication tag: strings encode as UTF-8
// without an options.encoding and through Buffer.from's rules with one, and
// every view kind contributes the same bytes as its Buffer.
const crypto = require("node:crypto");

function attempt(label, run) {
  try {
    const result = run();
    console.log(label, "ok", typeof result === "string" ? result : String(result));
  } catch (e) {
    console.log(label, "threw", e.name, e.code, "|", e.message);
  }
}

const key16 = Buffer.alloc(16, 1);
const key32 = Buffer.alloc(32, 2);
const nonce = Buffer.alloc(12, 3);
const plaintext = Buffer.from("the quick brown fox");

/* Each step is an AAD value (a setAAD call) or "data" (an update call). */
function sealGcm(steps) {
  const cipher = crypto.createCipheriv("aes-128-gcm", key16, nonce);
  const parts = [];
  for (const step of steps) {
    if (step === "data") parts.push(cipher.update(plaintext));
    else cipher.setAAD(step);
  }
  parts.push(cipher.final());
  return `${Buffer.concat(parts).toString("hex")}:${cipher.getAuthTag().toString("hex")}`;
}

function sealChacha(steps) {
  const cipher = crypto.createCipheriv("chacha20-poly1305", key32, nonce);
  const parts = [];
  for (const step of steps) {
    if (step === "data") parts.push(cipher.update(plaintext));
    else cipher.setAAD(step);
  }
  parts.push(cipher.final());
  return `${Buffer.concat(parts).toString("hex")}:${cipher.getAuthTag().toString("hex")}`;
}

const empty = Buffer.alloc(0);
const aad = Buffer.from("header");

const plainGcm = sealGcm(["data"]);
console.log("gcm plain", plainGcm);
console.log("gcm empty before", sealGcm([empty, "data"]) === plainGcm);
console.log("gcm empty after", sealGcm(["data", empty]) === plainGcm);
console.log("gcm empty both", sealGcm([empty, "data", empty, empty]) === plainGcm);
const aadGcm = sealGcm([aad, "data"]);
console.log("gcm aad", aadGcm);
console.log("gcm empty around aad", sealGcm([empty, aad, empty, "data", empty]) === aadGcm);

const plainChacha = sealChacha(["data"]);
console.log("chacha plain", plainChacha);
console.log("chacha empty before", sealChacha([empty, "data"]) === plainChacha);
console.log("chacha empty after", sealChacha(["data", empty]) === plainChacha);
console.log("chacha aad", sealChacha([aad, "data"]));

attempt("gcm aad after data", () => sealGcm([aad, "data", aad]));
attempt("gcm empty aad after final", () => {
  const cipher = crypto.createCipheriv("aes-128-gcm", key16, nonce);
  cipher.update(plaintext);
  cipher.final();
  return cipher.setAAD(empty) === cipher;
});
attempt("gcm aad after final", () => {
  const cipher = crypto.createCipheriv("aes-128-gcm", key16, nonce);
  cipher.update(plaintext);
  cipher.final();
  return cipher.setAAD(aad) === cipher;
});
attempt("gcm refused setAAD keeps the cipher", () => {
  const cipher = crypto.createCipheriv("aes-128-gcm", key16, nonce);
  const parts = [cipher.update(plaintext)];
  try {
    cipher.setAAD(aad);
  } catch (e) {
    console.log("gcm refusal", e.code);
  }
  parts.push(cipher.update(plaintext), cipher.final());
  return `${Buffer.concat(parts).toString("hex")}:${cipher.getAuthTag().toString("hex")}`;
});
attempt("chacha aad after data", () => sealChacha([aad, "data", aad]));
attempt("chacha aad after empty data", () => {
  const cipher = crypto.createCipheriv("chacha20-poly1305", key32, nonce);
  cipher.update(empty);
  return cipher.setAAD(aad) === cipher;
});
attempt("chacha empty aad after final", () => {
  const cipher = crypto.createCipheriv("chacha20-poly1305", key32, nonce);
  cipher.update(plaintext);
  cipher.final();
  return cipher.setAAD(empty) === cipher;
});
attempt("cbc empty aad", () => {
  const cipher = crypto.createCipheriv("aes-128-cbc", key16, Buffer.alloc(16));
  return cipher.setAAD(empty) === cipher;
});
attempt("cbc string aad", () => crypto.createCipheriv("aes-128-cbc", key16, Buffer.alloc(16)).setAAD("header"));
attempt("ctr aad", () => crypto.createCipheriv("aes-128-ctr", key16, Buffer.alloc(16)).setAAD(aad));

/* A decipher takes an empty setAAD after its data and still authenticates. */
const sealed = sealGcm([aad, "data"]);
const sealedBody = Buffer.from(sealed.split(":")[0], "hex");
const sealedTag = Buffer.from(sealed.split(":")[1], "hex");
console.log("gcm body", sealedBody.toString("hex"));
console.log("gcm tag", sealedTag.toString("hex"));

function openGcm(steps) {
  const decipher = crypto.createDecipheriv("aes-128-gcm", key16, nonce);
  const parts = [];
  for (const step of steps) {
    if (step === "data") parts.push(decipher.update(sealedBody));
    else if (step === "tag") decipher.setAuthTag(sealedTag);
    else decipher.setAAD(step);
  }
  parts.push(decipher.final());
  return Buffer.concat(parts).toString();
}

console.log("gcm open", openGcm([aad, "tag", "data"]));
console.log("gcm open empty after data", openGcm([aad, "tag", "data", empty, empty]));
attempt("gcm open aad after data", () => openGcm([aad, "tag", "data", aad]));
attempt("gcm open empty aad after final", () => {
  const decipher = crypto.createDecipheriv("aes-128-gcm", key16, nonce);
  decipher.setAAD(aad);
  decipher.setAuthTag(sealedTag);
  decipher.update(sealedBody);
  decipher.final();
  return decipher.setAAD(empty) === decipher;
});

/* String AAD and every view kind feed the same bytes. */
function gcmTagOf(aadValue, options) {
  const cipher = crypto.createCipheriv("aes-128-gcm", key16, nonce);
  cipher.setAAD(aadValue, options);
  cipher.update(plaintext);
  cipher.final();
  return cipher.getAuthTag().toString("hex");
}

const bufferTag = gcmTagOf(aad);
console.log("aad buffer", bufferTag);
console.log("aad utf8 string", gcmTagOf("header") === bufferTag);
console.log("aad hex string", gcmTagOf("686561646572", { encoding: "hex" }) === bufferTag);
console.log("aad base64 string", gcmTagOf("aGVhZGVy", { encoding: "base64" }) === bufferTag);
console.log("aad base64url string", gcmTagOf("aGVhZGVy", { encoding: "base64url" }) === bufferTag);
console.log("aad latin1 string", gcmTagOf("header", { encoding: "latin1" }) === bufferTag);
console.log("aad ascii string", gcmTagOf("header", { encoding: "ascii" }) === bufferTag);
console.log("aad buffer encoding", gcmTagOf("header", { encoding: "buffer" }) === bufferTag);
console.log("aad uppercase encoding", gcmTagOf("686561646572", { encoding: "HEX" }) === bufferTag);
const wide = new Uint16Array([0x68, 0xe9]);
console.log("aad utf16le", gcmTagOf("hé", { encoding: "utf16le" }) === gcmTagOf(wide));
console.log("aad uint16 array", gcmTagOf(wide) === gcmTagOf(Buffer.from(wide.buffer)));
const view = new Uint16Array([0x1111, 0x6568, 0x6461, 0x7265, 0x2222]);
console.log("aad dataview", gcmTagOf(new DataView(view.buffer, 2, 6)) === bufferTag);
const headerBytes = new Uint8Array(6);
headerBytes.set(Buffer.from("header"));
console.log("aad arraybuffer", gcmTagOf(headerBytes.buffer) === bufferTag);
console.log("aad encoding null", gcmTagOf("header", { encoding: null }) === bufferTag);
console.log("aad options number", gcmTagOf("header", 5) === bufferTag);
console.log("aad options null", gcmTagOf("header", null) === bufferTag);
console.log("aad plaintextLength zero", gcmTagOf("header", { plaintextLength: 0 }) === bufferTag);
console.log("aad plaintextLength null", gcmTagOf("header", { plaintextLength: null }) === bufferTag);
console.log("aad plaintextLength two", gcmTagOf("header", { plaintextLength: 2 }) === bufferTag);
attempt("aad plaintextLength negative", () => gcmTagOf("header", { plaintextLength: -1 }));
attempt("aad plaintextLength fraction", () => gcmTagOf("header", { plaintextLength: 1.5 }));
attempt("aad plaintextLength NaN", () => gcmTagOf("header", { plaintextLength: NaN }));
attempt("aad plaintextLength Infinity", () => gcmTagOf("header", { plaintextLength: Infinity }));
attempt("aad plaintextLength string", () => gcmTagOf("header", { plaintextLength: "2" }));
attempt("aad plaintextLength boolean", () => gcmTagOf("header", { plaintextLength: true }));
attempt("aad encoding number", () => gcmTagOf("header", { encoding: 5 }));
attempt("aad unknown encoding", () => gcmTagOf("header", { encoding: "nope" }));

attempt("aad number", () => gcmTagOf(5));
attempt("aad null", () => gcmTagOf(null));
attempt("aad undefined", () => gcmTagOf(undefined));
attempt("aad boolean", () => gcmTagOf(true));
attempt("aad object", () => gcmTagOf({}));
attempt("aad array", () => gcmTagOf([1, 2]));
attempt("aad missing", () => {
  const cipher = crypto.createCipheriv("aes-128-gcm", key16, nonce);
  return cipher.setAAD();
});

/* setAAD answers the cipher itself, so calls chain. */
console.log(
  "chained",
  crypto
    .createCipheriv("aes-128-gcm", key16, nonce)
    .setAAD(empty)
    .setAAD(aad)
    .setAAD(empty)
    .update(plaintext)
    .length,
);

/* CCM validates its AAD options first, as its own row describes. */
attempt("ccm aad without length", () =>
  crypto.createCipheriv("aes-128-ccm", key16, Buffer.alloc(12), { authTagLength: 16 }).setAAD(aad),
);
attempt("ccm empty aad without length", () =>
  crypto.createCipheriv("aes-128-ccm", key16, Buffer.alloc(12), { authTagLength: 16 }).setAAD(empty),
);
console.log(
  "ccm aad",
  (() => {
    const cipher = crypto.createCipheriv("aes-128-ccm", key16, Buffer.alloc(12), { authTagLength: 16 });
    cipher.setAAD(aad, { plaintextLength: plaintext.length });
    const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return `${body.toString("hex")}:${cipher.getAuthTag().toString("hex")}`;
  })(),
);
