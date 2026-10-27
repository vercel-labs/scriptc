// AES-CCM through createCipheriv and createDecipheriv: RFC 3610 and NIST
// SP 800-38C vectors, every tag and IV length, AAD with plaintextLength,
// the message-length caps of 12- and 13-byte IVs, a decipher's failed
// authentication reported by final(), the one-update rule, the AAD and
// tag calls in each state, and as a stream.
const crypto = require("crypto");

function attempt(label, run) {
  try {
    const v = run();
    console.log(label, "ok", Buffer.isBuffer(v) ? v.toString("hex") : v);
  } catch (e) {
    console.log(label, e.name, e.code, JSON.stringify(e.message), JSON.stringify(Object.keys(e)));
  }
}
const hex = (s) => Buffer.from(s, "hex");

// NIST SP 800-38C examples C.1 to C.3.
const nistKey = hex("404142434445464748494a4b4c4d4e4f");
for (const [iv, aad, pt, tagLen] of [
  ["10111213141516", "0001020304050607", "20212223", 4],
  ["1011121314151617", "000102030405060708090a0b0c0d0e0f", "202122232425262728292a2b2c2d2e2f", 6],
  ["101112131415161718191a1b", "000102030405060708090a0b0c0d0e0f10111213", "202122232425262728292a2b2c2d2e2f3031323334353637", 8],
]) {
  attempt(`nist iv ${iv.length / 2}`, () => {
    const c = crypto.createCipheriv("aes-128-ccm", nistKey, hex(iv), { authTagLength: tagLen });
    c.setAAD(hex(aad), { plaintextLength: pt.length / 2 });
    return Buffer.concat([c.update(hex(pt)), c.final(), c.getAuthTag()]);
  });
}
// RFC 3610 packet vector 1.
attempt("rfc3610 #1", () => {
  const c = crypto.createCipheriv("aes-128-ccm", hex("c0c1c2c3c4c5c6c7c8c9cacbcccdcecf"), hex("00000003020100a0a1a2a3a4a5"), { authTagLength: 8 });
  c.setAAD(hex("0001020304050607"), { plaintextLength: 23 });
  return Buffer.concat([c.update(hex("08090a0b0c0d0e0f101112131415161718191a1b1c1d1e")), c.final(), c.getAuthTag()]);
});

const key = Buffer.alloc(16, 1);
const pt = Buffer.from("hello world, ccm mode, three blocks of it!");
for (const size of [16, 24, 32])
  for (const name of [`aes-${size * 8}-ccm`, `id-aes${size * 8}-ccm`, `AES-${size * 8}-CCM`])
    attempt(name, () => {
      const c = crypto.createCipheriv(name, Buffer.alloc(size, 3), Buffer.alloc(12, 2), { authTagLength: 10 });
      return Buffer.concat([c.update(pt), c.final(), c.getAuthTag()]);
    });
for (const tagLen of [2, 3, 4, 5, 6, 8, 10, 12, 14, 15, 16, 18])
  attempt(`tag ${tagLen}`, () => {
    const c = crypto.createCipheriv("aes-128-ccm", key, Buffer.alloc(12), { authTagLength: tagLen });
    return Buffer.concat([c.update(pt), c.final(), c.getAuthTag()]);
  });
for (const ivLen of [0, 6, 7, 8, 11, 12, 13, 14])
  attempt(`iv ${ivLen}`, () => {
    const c = crypto.createCipheriv("aes-128-ccm", key, Buffer.alloc(ivLen, 9), { authTagLength: 16 });
    return Buffer.concat([c.update(pt), c.final(), c.getAuthTag()]);
  });
attempt("no tag length", () => crypto.createCipheriv("aes-128-ccm", key, Buffer.alloc(12)));
attempt("no tag length, mixed case", () => crypto.createDecipheriv("Aes-128-Ccm", key, Buffer.alloc(12)));
attempt("tag length string", () => crypto.createCipheriv("aes-128-ccm", key, Buffer.alloc(12), { authTagLength: "16" }));
attempt("bad iv and no tag length", () => crypto.createCipheriv("aes-128-ccm", key, Buffer.alloc(5)));
attempt("bad key", () => crypto.createCipheriv("aes-128-ccm", Buffer.alloc(15), Buffer.alloc(12), { authTagLength: 16 }));

const iv = Buffer.alloc(12, 2), aad = Buffer.from("header");
function seal(steps) {
  const c = crypto.createCipheriv("aes-128-ccm", key, iv, { authTagLength: 16 });
  const parts = [];
  for (const step of steps) {
    try {
      const out = step(c);
      if (Buffer.isBuffer(out)) parts.push(out.toString("hex"));
    } catch (e) {
      parts.push(`<${e.code ?? e.name}: ${e.message}>`);
    }
  }
  try {
    parts.push("tag " + c.getAuthTag().toString("hex"));
  } catch (e) {
    parts.push(`<${e.code}: ${e.message}>`);
  }
  return parts.join(" ");
}
const update = (data) => (c) => c.update(data);
const final = () => (c) => c.final();
const setAAD = (data, options) => (c) => (c.setAAD(data, options), Buffer.alloc(0));
console.log("plain", seal([update(pt), final()]));
console.log("aad", seal([setAAD(aad, { plaintextLength: pt.length }), update(pt), final()]));
console.log("aad without length", seal([setAAD(aad), update(pt), final()]));
console.log("aad bad length", seal([setAAD(aad, { plaintextLength: -1 }), update(pt), final()]));
console.log("aad length mismatch", seal([setAAD(aad, { plaintextLength: 5 }), update(pt), final()]));
console.log("aad twice", seal([setAAD(aad, { plaintextLength: pt.length }), setAAD(aad, { plaintextLength: pt.length }), update(pt), final()]));
console.log("empty aad", seal([setAAD(Buffer.alloc(0), { plaintextLength: pt.length }), update(pt), final()]));
console.log("aad after update", seal([update(pt), setAAD(aad, { plaintextLength: 3 }), final()]));
console.log("update twice", seal([update(pt), update(pt), final()]));
console.log("update empty twice", seal([update(Buffer.alloc(0)), update(Buffer.alloc(0)), final()]));
console.log("no update", seal([final()]));
console.log("aad, no update", seal([setAAD(aad, { plaintextLength: pt.length }), final()]));
console.log("aad length 0, no update", seal([setAAD(aad, { plaintextLength: 0 }), final()]));
console.log("tag before final", seal([update(pt)]));
console.log("final twice", seal([update(pt), final(), final()]));
console.log("update after final", seal([update(pt), final(), update(pt)]));
console.log("auto padding", seal([(c) => (c.setAutoPadding(false), Buffer.alloc(0)), update(pt), final()]));
console.log("strings", seal([(c) => Buffer.from(c.update("abcd", "utf8", "hex"), "hex"), (c) => Buffer.from(c.final("hex"), "hex")]));

// Message-length caps: 2^16 - 1 bytes with a 13-byte IV, 2^24 - 1 with 12.
for (const [ivLen, size] of [[13, 65535], [13, 65536], [12, 65536]])
  attempt(`length ${size}, iv ${ivLen}`, () => {
    const c = crypto.createCipheriv("aes-128-ccm", key, Buffer.alloc(ivLen), { authTagLength: 4 });
    return crypto.createHash("sha256").update(c.update(Buffer.alloc(size, 1))).digest("hex").slice(0, 16);
  });
attempt("aad length 65536, iv 13", () => crypto.createCipheriv("aes-128-ccm", key, Buffer.alloc(13), { authTagLength: 4 }).setAAD(aad, { plaintextLength: 65536 }));
attempt("aad length 16777216, iv 12", () => crypto.createCipheriv("aes-128-ccm", key, Buffer.alloc(12), { authTagLength: 4 }).setAAD(aad, { plaintextLength: 16777216 }));

const sealer = crypto.createCipheriv("aes-128-ccm", key, iv, { authTagLength: 16 });
sealer.setAAD(aad, { plaintextLength: pt.length });
const ct = Buffer.concat([sealer.update(pt), sealer.final()]);
const tag = sealer.getAuthTag();
function open(steps) {
  const d = crypto.createDecipheriv("aes-128-ccm", key, iv, { authTagLength: 16 });
  const parts = [];
  for (const step of steps) {
    try {
      const out = step(d);
      if (Buffer.isBuffer(out)) parts.push(JSON.stringify(out.toString()));
    } catch (e) {
      parts.push(`<${e.code ?? e.name}: ${e.message}>`);
    }
  }
  return parts.join(" ");
}
const setAuthTag = (t) => (d) => (d.setAuthTag(t), Buffer.alloc(0));
console.log("open", open([setAuthTag(tag), setAAD(aad, { plaintextLength: ct.length }), update(ct), final()]));
console.log("open, tag after aad", open([setAAD(aad, { plaintextLength: ct.length }), setAuthTag(tag), update(ct), final()]));
console.log("open without tag", open([setAAD(aad, { plaintextLength: ct.length }), update(ct), final()]));
console.log("open bad tag", open([setAuthTag(Buffer.alloc(16)), setAAD(aad, { plaintextLength: ct.length }), update(ct), final()]));
console.log("open without aad", open([setAuthTag(tag), update(ct), final()]));
console.log("open tampered", open([setAuthTag(tag), setAAD(aad, { plaintextLength: ct.length }), update(Buffer.concat([ct.subarray(0, 5), Buffer.from([ct[5] ^ 1]), ct.subarray(6)])), final()]));
console.log("open tag after update", open([setAAD(aad, { plaintextLength: ct.length }), update(ct), setAuthTag(tag), final()]));
console.log("open tag twice", open([setAuthTag(tag), setAuthTag(tag), setAAD(aad, { plaintextLength: ct.length }), update(ct), final()]));
console.log("open tag wrong length", open([setAuthTag(tag.subarray(0, 8))]));
console.log("open update twice", open([setAuthTag(tag), setAAD(aad, { plaintextLength: ct.length }), update(ct), update(ct), final()]));
console.log("open final only", open([setAuthTag(tag), final()]));
console.log("open length mismatch", open([setAuthTag(tag), setAAD(aad, { plaintextLength: 3 }), update(ct), final()]));
console.log("open getAuthTag", open([(d) => d.getAuthTag()]));
console.log("open empty message", (() => {
  const c = crypto.createCipheriv("aes-128-ccm", key, iv, { authTagLength: 8 });
  c.update(Buffer.alloc(0));
  c.final();
  const t = c.getAuthTag();
  const d = crypto.createDecipheriv("aes-128-ccm", key, iv, { authTagLength: 8 });
  d.setAuthTag(t);
  return JSON.stringify(Buffer.concat([d.update(Buffer.alloc(0)), d.final()]).toString());
})());

// An empty message is still authenticated: its tag covers the nonce, the
// AAD and the declared length, so a wrong tag, other AAD or another
// plaintextLength fails in final(), as does a decipher without an update.
const empty = Buffer.alloc(0);
const sealEmpty = (aadBuf) => {
  const c = crypto.createCipheriv("aes-128-ccm", key, iv, { authTagLength: 16 });
  if (aadBuf) c.setAAD(aadBuf, { plaintextLength: 0 });
  c.update(empty);
  c.final();
  return c.getAuthTag();
};
const emptyTag = sealEmpty(aad);
const emptyTagNoAad = sealEmpty(null);
const flipped = Buffer.from(emptyTag);
flipped[0] ^= 1;
const openEmpty = (steps) => {
  const d = crypto.createDecipheriv("aes-128-ccm", key, iv, { authTagLength: 16 });
  const out = [];
  try {
    for (const step of steps) {
      const v = step(d);
      if (Buffer.isBuffer(v)) out.push(v);
    }
    return `ok ${JSON.stringify(Buffer.concat(out).toString())}`;
  } catch (e) {
    return `${e.name} ${e.code} ${JSON.stringify(e.message)} after ${out.length} outputs`;
  }
};
console.log("empty tag", emptyTag.toString("hex"), emptyTagNoAad.toString("hex"));
console.log("empty, right tag", openEmpty([setAuthTag(emptyTag), setAAD(aad, { plaintextLength: 0 }), update(empty), final()]));
console.log("empty, wrong tag", openEmpty([setAuthTag(Buffer.alloc(16, 9)), setAAD(aad, { plaintextLength: 0 }), update(empty), final()]));
console.log("empty, flipped tag", openEmpty([setAuthTag(flipped), setAAD(aad, { plaintextLength: 0 }), update(empty), final()]));
console.log("empty, other aad", openEmpty([setAuthTag(emptyTag), setAAD(Buffer.from("other"), { plaintextLength: 0 }), update(empty), final()]));
console.log("empty, plaintextLength 5", openEmpty([setAuthTag(emptyTag), setAAD(aad, { plaintextLength: 5 }), update(empty), final()]));
console.log("empty, no update", openEmpty([setAuthTag(emptyTag), setAAD(aad, { plaintextLength: 0 }), final()]));
console.log("empty, no tag", openEmpty([setAAD(aad, { plaintextLength: 0 }), update(empty), final()]));
console.log("empty, no aad, right tag", openEmpty([setAuthTag(emptyTagNoAad), update(empty), final()]));
console.log("empty, no aad, wrong tag", openEmpty([setAuthTag(Buffer.alloc(16, 9)), update(empty), final()]));
console.log("empty, aad dropped", openEmpty([setAuthTag(emptyTag), update(empty), final()]));
console.log("empty, a string update", openEmpty([setAuthTag(Buffer.alloc(16, 9)), (d) => d.update(""), final()]));

// As a stream: one write and the end.
const stream = crypto.createCipheriv("aes-128-ccm", key, iv, { authTagLength: 12 });
const chunks = [];
stream.on("data", (chunk) => chunks.push(chunk));
stream.on("end", () => console.log("stream", Buffer.concat(chunks).toString("hex"), stream.getAuthTag().toString("hex")));
stream.end(pt);
