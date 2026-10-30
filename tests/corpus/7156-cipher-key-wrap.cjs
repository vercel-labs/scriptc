// The AES key-wrap ciphers through createCipheriv and createDecipheriv:
// RFC 3394 and RFC 5649 vectors under every name (aes-N-wrap, aesN-wrap,
// id-aesN-wrap, the -pad forms and the -inv ciphers), the input and IV
// lengths each takes, integrity failures, and the one-update rule.
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
const wrap = (name, key, iv, input) => {
  const c = crypto.createCipheriv(name, key, iv);
  return Buffer.concat([c.update(input), c.final()]);
};
const unwrap = (name, key, iv, input) => {
  const d = crypto.createDecipheriv(name, key, iv);
  return Buffer.concat([d.update(input), d.final()]);
};
const iv8 = hex("a6a6a6a6a6a6a6a6"), iv4 = hex("a65959a6");

// RFC 3394 section 4.
const kek = hex("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f");
const keyData = hex("00112233445566778899aabbccddeeff000102030405060708090a0b0c0d0e0f");
for (const [kekBits, dataBits] of [[128, 128], [192, 128], [256, 128], [192, 192], [256, 192], [256, 256]]) {
  const k = kek.subarray(0, kekBits / 8), d = keyData.subarray(0, dataBits / 8);
  for (const name of [`aes-${kekBits}-wrap`, `aes${kekBits}-wrap`, `id-aes${kekBits}-wrap`, `ID-AES${kekBits}-WRAP`]) {
    attempt(`${name} ${dataBits}`, () => wrap(name, k, iv8, d));
    attempt(`${name} ${dataBits} unwrap`, () => unwrap(name, k, iv8, wrap(name, k, iv8, d)));
  }
}
// RFC 5649 section 6.
const kek5649 = hex("5840df6e29b02af1ab493b705bf16ea1ae8338f4dcc176a8");
for (const data of ["c37b7e6492584340bed12207808941155068f738", "466f7250617369"])
  for (const name of ["aes-192-wrap-pad", "aes192-wrap-pad", "id-aes192-wrap-pad"]) {
    attempt(`${name} ${data.length / 2}`, () => wrap(name, kek5649, iv4, hex(data)));
    attempt(`${name} ${data.length / 2} unwrap`, () => unwrap(name, kek5649, iv4, wrap(name, kek5649, iv4, hex(data))));
  }

const k128 = kek.subarray(0, 16);
for (const size of [0, 1, 7, 8, 9, 15, 16, 17, 24, 40]) {
  attempt(`wrap ${size} bytes`, () => wrap("id-aes128-wrap", k128, iv8, Buffer.alloc(size, 5)));
  attempt(`wrap-pad ${size} bytes`, () => {
    const w = wrap("id-aes128-wrap-pad", k128, iv4, Buffer.alloc(size, 5));
    return w.toString("hex") + " -> " + unwrap("id-aes128-wrap-pad", k128, iv4, w).toString("hex");
  });
}
for (const size of [8, 16, 20, 24, 32])
  for (const name of ["id-aes128-wrap", "id-aes128-wrap-pad"]) {
    const iv = name.endsWith("pad") ? iv4 : iv8;
    attempt(`${name} unwrap ${size} bytes`, () => unwrap(name, k128, iv, Buffer.alloc(size, 1)));
  }
attempt("other iv", () => wrap("id-aes128-wrap", k128, Buffer.alloc(8, 1), keyData.subarray(0, 16)));
attempt("unwrap with another iv", () => unwrap("id-aes128-wrap", k128, Buffer.alloc(8, 1), wrap("id-aes128-wrap", k128, iv8, keyData.subarray(0, 16))));
attempt("pad other iv", () => wrap("id-aes128-wrap-pad", k128, Buffer.alloc(4, 7), Buffer.from("key")));
attempt("pad unwrap with another iv", () => unwrap("id-aes128-wrap-pad", k128, Buffer.alloc(4, 7), wrap("id-aes128-wrap-pad", k128, iv4, Buffer.from("key"))));
attempt("pad tampered length", () => {
  const w = wrap("id-aes128-wrap-pad", k128, iv4, Buffer.alloc(20, 9));
  w[3] ^= 1;
  return unwrap("id-aes128-wrap-pad", k128, iv4, w);
});
for (const name of ["aes-128-wrap-inv", "aes128-wrap-inv", "aes-256-wrap-inv", "aes-128-wrap-pad-inv", "aes256-wrap-pad-inv"]) {
  const bits = Number(name.match(/\d+/)[0]);
  const iv = name.includes("pad") ? iv4 : iv8;
  attempt(name, () => {
    const w = wrap(name, kek.subarray(0, bits / 8), iv, keyData.subarray(0, 24));
    return w.toString("hex") + " -> " + unwrap(name, kek.subarray(0, bits / 8), iv, w).toString("hex");
  });
}
attempt("null iv", () => crypto.createCipheriv("id-aes128-wrap", k128, null));
attempt("iv 16", () => crypto.createCipheriv("id-aes128-wrap", k128, Buffer.alloc(16)));
attempt("pad iv 8", () => crypto.createCipheriv("id-aes128-wrap-pad", k128, iv8));
attempt("key 24", () => crypto.createCipheriv("id-aes128-wrap", Buffer.alloc(24), iv8));

function steps(list) {
  const c = crypto.createCipheriv("id-aes128-wrap", k128, iv8);
  return list
    .map((step) => {
      try {
        const out = step(c);
        return Buffer.isBuffer(out) ? out.toString("hex") || '""' : String(out);
      } catch (e) {
        return `<${e.code ?? e.name}: ${e.message}>`;
      }
    })
    .join(" ");
}
const data = keyData.subarray(0, 16);
console.log("update twice", steps([(c) => c.update(data), (c) => c.update(data), (c) => c.final()]));
console.log("final only", steps([(c) => c.final()]));
console.log("final twice", steps([(c) => c.update(data), (c) => c.final(), (c) => c.final()]));
console.log("update after final", steps([(c) => c.update(data), (c) => c.final(), (c) => c.update(data)]));
console.log("bad then good", steps([(c) => c.update(Buffer.alloc(12)), (c) => c.update(data), (c) => c.final()]));
console.log("bad then final", steps([(c) => c.update(Buffer.alloc(12)), (c) => c.final()]));
console.log("empty then data", steps([(c) => c.update(Buffer.alloc(0)), (c) => c.update(data), (c) => c.final()]));
console.log("hex", steps([(c) => c.update(data, undefined, "hex"), (c) => c.final("hex")]));
console.log("auto padding", steps([(c) => c.setAutoPadding(false) === c, (c) => c.update(data)]));
console.log("setAAD", steps([(c) => c.setAAD(Buffer.alloc(1))]));
console.log("getAuthTag", steps([(c) => c.update(data), (c) => c.final(), (c) => c.getAuthTag()]));
