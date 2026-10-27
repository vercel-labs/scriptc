// crypto.getCipherInfo: every getCiphers() name, OpenSSL's aliases in any
// case and its legacy-provider ciphers, lookups by nid, the keyLength and
// ivLength options (exact lengths, CCM's 7 to 13 bytes, OCB's 1 to 15 and
// any length for GCM; the legacy ciphers answer undefined for either),
// and Node's argument errors.
const crypto = require("crypto");

for (const name of crypto.getCiphers()) console.log(name, JSON.stringify(crypto.getCipherInfo(name)));
for (const name of ["AES-128-CBC", "Aes256", "id-aes128-CCM", "chacha20-POLY1305", "des", "bf", "bf-cbc", "rc4", "seed-cbc", "cast5-cbc", "rc2-cbc", "idea-cbc", "des-ecb", "desx", "nope", ""])
  console.log(JSON.stringify(name), JSON.stringify(crypto.getCipherInfo(name)));
for (const nid of [0, -1, 1, 5, 31, 91, 419, 427, 895, 896, 901, 1018, 1198, 1248, 99999])
  console.log("nid", nid, JSON.stringify(crypto.getCipherInfo(nid)));

const options = [
  { keyLength: 16 },
  { keyLength: 32 },
  { ivLength: 16 },
  { ivLength: 12 },
  { ivLength: 7 },
  { ivLength: 13 },
  { ivLength: 14 },
  { ivLength: 0 },
  { ivLength: 1 },
  { ivLength: 15 },
  { ivLength: 1000 },
  { keyLength: 16, ivLength: 12 },
  { keyLength: undefined, ivLength: undefined },
  {},
];
for (const name of ["aes-128-cbc", "aes-128-gcm", "aes-128-ccm", "aes-128-ocb", "aes-128-ecb", "chacha20-poly1305", "aes-128-wrap-pad", "bf-cbc", "rc4"])
  for (const option of options) console.log(name, JSON.stringify(option), JSON.stringify(crypto.getCipherInfo(name, option)));

function attempt(label, run) {
  try {
    console.log(label, "ok", JSON.stringify(run()));
  } catch (e) {
    console.log(label, e.name, e.code, e.message);
  }
}
attempt("no argument", () => crypto.getCipherInfo());
attempt("null", () => crypto.getCipherInfo(null));
attempt("boolean", () => crypto.getCipherInfo(true));
attempt("object", () => crypto.getCipherInfo({}));
attempt("fraction", () => crypto.getCipherInfo(1.5));
attempt("NaN", () => crypto.getCipherInfo(NaN));
attempt("2^31", () => crypto.getCipherInfo(2 ** 31));
attempt("options null", () => crypto.getCipherInfo("aes-128-cbc", null));
attempt("options number", () => crypto.getCipherInfo("aes-128-cbc", 5));
attempt("options string", () => crypto.getCipherInfo("aes-128-cbc", "x"));
attempt("options array", () => crypto.getCipherInfo("aes-128-cbc", []));
attempt("keyLength string", () => crypto.getCipherInfo("aes-128-cbc", { keyLength: "16" }));
attempt("keyLength fraction", () => crypto.getCipherInfo("aes-128-cbc", { keyLength: 16.5 }));
attempt("ivLength 2^31", () => crypto.getCipherInfo("aes-128-cbc", { ivLength: 2 ** 31 }));
attempt("ivLength null", () => crypto.getCipherInfo("aes-128-cbc", { ivLength: null }));
attempt("unknown name with bad options", () => crypto.getCipherInfo("nope", { keyLength: "x" }));
const info = crypto.getCipherInfo("aes-256-gcm", { ivLength: 7 });
console.log(Object.keys(info).join(), Object.getPrototypeOf(info) === Object.prototype);

// The options are read as destructuring reads them: inherited properties
// and getters count, and both are read before either is validated.
attempt("getter keyLength", () => crypto.getCipherInfo("aes-128-cbc", { get keyLength() { return 17; } }));
attempt("getter ivLength", () => crypto.getCipherInfo("aes-128-cbc", { get ivLength() { return 5; } }));
attempt("getter valid", () => crypto.getCipherInfo("aes-128-cbc", { get keyLength() { return 16; } }));
attempt("inherited keyLength", () => crypto.getCipherInfo("aes-128-cbc", Object.create({ keyLength: 17 })));
attempt("inherited valid", () => crypto.getCipherInfo("aes-128-cbc", Object.create({ keyLength: 16, ivLength: 16 })));
class LengthOptions {
  constructor(ivLength) {
    this.ivLength = ivLength;
  }
}
attempt("class field", () => crypto.getCipherInfo("aes-128-cbc", new LengthOptions(5)));
attempt("class field valid", () => crypto.getCipherInfo("aes-128-cbc", new LengthOptions(16)));
attempt("getter wrong type", () => crypto.getCipherInfo("aes-128-cbc", { get keyLength() { return "x"; } }));
attempt("getter throws", () => crypto.getCipherInfo("aes-128-cbc", { get keyLength() { throw new Error("getter"); } }));
const reads = [];
attempt("read order", () =>
  crypto.getCipherInfo("aes-128-cbc", {
    get ivLength() {
      reads.push("ivLength");
      return "x";
    },
    get keyLength() {
      reads.push("keyLength");
      return "y";
    },
  }),
);
console.log("reads", reads.join());
