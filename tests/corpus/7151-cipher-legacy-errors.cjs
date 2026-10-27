// createCipheriv errors for the legacy modes, in Node's order: the IV
// length each mode takes (none for ECB), the key length, OpenSSL's
// "unsupported" for the ciphers its legacy provider holds, and the block
// modes' final-block and padding failures; the AEAD-only methods throw
// Node's invalid-state errors on the stream modes.
const crypto = require("crypto");

function attempt(label, run) {
  try {
    const value = run();
    console.log(label, "ok", Buffer.isBuffer(value) ? value.toString("hex") : value);
  } catch (e) {
    console.log(label, e.name, e.code, e.message, e.library, e.reason, JSON.stringify(e.opensslErrorStack));
  }
}

const k16 = Buffer.alloc(16, 1), k24 = Buffer.alloc(24, 1), k32 = Buffer.alloc(32, 1);
attempt("ecb null iv", () => crypto.createCipheriv("aes-128-ecb", k16, null).final());
attempt("ecb empty iv", () => crypto.createCipheriv("aes-128-ecb", k16, Buffer.alloc(0)).final());
attempt("ecb 16-byte iv", () => crypto.createCipheriv("aes-128-ecb", k16, Buffer.alloc(16)));
attempt("cfb 15-byte iv", () => crypto.createCipheriv("aes-128-cfb", k16, Buffer.alloc(15)));
attempt("cfb null iv", () => crypto.createCipheriv("aes-128-cfb", k16, null));
attempt("ofb key 15", () => crypto.createCipheriv("aes-128-ofb", Buffer.alloc(15), Buffer.alloc(16)));
attempt("des3 16-byte iv", () => crypto.createCipheriv("des-ede3-cbc", k24, Buffer.alloc(16)));
attempt("des3 16-byte key", () => crypto.createCipheriv("des-ede3-cbc", k16, Buffer.alloc(8)));
attempt("des-ede 24-byte key", () => crypto.createCipheriv("des-ede-cbc", k24, Buffer.alloc(8)));
attempt("des-ede3 ecb with iv", () => crypto.createCipheriv("des-ede3", k24, Buffer.alloc(8)));
attempt("chacha20 12-byte iv", () => crypto.createCipheriv("chacha20", k32, Buffer.alloc(12)));
attempt("chacha20 authTagLength ignored", () => crypto.createCipheriv("chacha20", k32, Buffer.alloc(16), { authTagLength: 16 }).update("x"));
attempt("upper-case name", () => crypto.createCipheriv("DES-EDE3-CBC", k24, Buffer.alloc(8)).final());
attempt("des-cbc", () => crypto.createCipheriv("des-cbc", Buffer.alloc(8), Buffer.alloc(8)));
attempt("des-cbc bad iv", () => crypto.createCipheriv("des-cbc", Buffer.alloc(8), Buffer.alloc(3)));
attempt("des-cbc bad key", () => crypto.createCipheriv("des-cbc", Buffer.alloc(3), Buffer.alloc(8)));
attempt("bf-cbc", () => crypto.createDecipheriv("bf-cbc", k16, Buffer.alloc(8)));
attempt("rc4", () => crypto.createCipheriv("rc4", k16, null));
attempt("rc4 with iv", () => crypto.createCipheriv("rc4", k16, Buffer.alloc(8)));
attempt("seed-ecb", () => crypto.createCipheriv("seed-ecb", k16, null));
attempt("unknown cipher", () => crypto.createCipheriv("aes-128-xyz", k16, Buffer.alloc(16)));

attempt("cfb getAuthTag", () => {
  const c = crypto.createCipheriv("aes-128-cfb", k16, Buffer.alloc(16));
  c.update("x");
  c.final();
  return c.getAuthTag();
});
attempt("ofb setAAD", () => crypto.createCipheriv("aes-128-ofb", k16, Buffer.alloc(16)).setAAD(Buffer.alloc(1)));
attempt("chacha20 setAuthTag", () => crypto.createDecipheriv("chacha20", k32, Buffer.alloc(16)).setAuthTag(Buffer.alloc(16)));
attempt("cfb update sizes", () => {
  const c = crypto.createCipheriv("aes-128-cfb", k16, Buffer.alloc(16));
  return [c.update("abc").length, c.update("defghijklmnopqrstu").length, c.final().length].join(",");
});
attempt("cfb1 setAutoPadding(false)", () => {
  const c = crypto.createCipheriv("aes-128-cfb1", k16, Buffer.alloc(16));
  c.setAutoPadding(false);
  return Buffer.concat([c.update("abc"), c.final()]);
});
attempt("ecb unpadded short", () => {
  const c = crypto.createCipheriv("aes-128-ecb", k16, null);
  c.setAutoPadding(false);
  c.update(Buffer.alloc(31, 7));
  return c.final();
});
attempt("des3 unpadded short", () => {
  const c = crypto.createCipheriv("des-ede3-cbc", k24, Buffer.alloc(8));
  c.setAutoPadding(false);
  c.update(Buffer.alloc(7));
  return c.final();
});
attempt("des3 bad decrypt", () => {
  const d = crypto.createDecipheriv("des-ede3-cbc", k24, Buffer.alloc(8));
  d.update(Buffer.alloc(16, 9));
  return d.final();
});
attempt("ecb decrypt 15 bytes", () => {
  const d = crypto.createDecipheriv("aes-128-ecb", k16, null);
  d.update(Buffer.alloc(15));
  return d.final();
});
attempt("ofb update after final", () => {
  const c = crypto.createCipheriv("aes-128-ofb", k16, Buffer.alloc(16));
  c.final();
  return c.update("x");
});
