// createDiffieHellman, getDiffieHellman and DiffieHellman errors from
// JavaScript: argument types and ranges, the keyEncoding and generator
// forms, OpenSSL's generator and modulus errors with their library and
// reason properties, parameter sizes, group names, encodings, keys read
// before they exist, public keys outside (1, p - 1), key generation and
// secrets on primes outside 512 to 10000 bits, and members a
// DiffieHellmanGroup does not have.
import crypto from "node:crypto";

// Values the declared overloads reject reach the calls through an
// untyped function, as they would from other untyped code.
const loose = (value) => value;

function attempt(label, run) {
  try {
    const result = run();
    if (Buffer.isBuffer(result)) console.log(label, "ok", result.toString("hex"));
    else if (typeof result === "object" && result !== null)
      console.log(label, "ok", result.getGenerator("hex"), result.getPrime().length);
    else console.log(label, "ok", JSON.stringify(result));
  } catch (e) {
    const extra = e.library === undefined ? "" : ` [${Object.keys(e).join(",")}] ${e.library} / ${e.reason}`;
    console.log(label, e.name, e.code, e.message + extra);
  }
}

const prime = crypto.getDiffieHellman("modp1").getPrime();

attempt("size missing", () => crypto.createDiffieHellman(loose(undefined)));
attempt("size null", () => crypto.createDiffieHellman(loose(null)));
attempt("size boolean", () => crypto.createDiffieHellman(loose(true)));
attempt("size object", () => crypto.createDiffieHellman(loose({})));
attempt("size bigint", () => crypto.createDiffieHellman(loose(5n)));
attempt("size fraction", () => crypto.createDiffieHellman(1.5));
attempt("size NaN", () => crypto.createDiffieHellman(NaN));
attempt("size 2^31", () => crypto.createDiffieHellman(2 ** 31));
attempt("size 2^40", () => crypto.createDiffieHellman(2 ** 40));
attempt("size -1", () => crypto.createDiffieHellman(-1));
attempt("size -0", () => crypto.createDiffieHellman(-0));
attempt("size 1", () => crypto.createDiffieHellman(1));
attempt("size 1 bad generator", () => crypto.createDiffieHellman(1, 1));
attempt("size 2 generator 1", () => crypto.createDiffieHellman(2, 1));
attempt("size 2", () => crypto.createDiffieHellman(2));
attempt("size 511", () => crypto.createDiffieHellman(511));
attempt("size 10001", () => crypto.createDiffieHellman(10001));
attempt("size generator string", () => crypto.createDiffieHellman(64, loose("02")));
attempt("size generator view", () => crypto.createDiffieHellman(64, loose(Buffer.from([2]))));

attempt("generator 0", () => crypto.createDiffieHellman(prime, 0));
attempt("generator 1", () => crypto.createDiffieHellman(prime, 1));
attempt("generator -1", () => crypto.createDiffieHellman(prime, -1));
attempt("generator fraction", () => crypto.createDiffieHellman(prime, 2.5));
attempt("generator 2^31", () => crypto.createDiffieHellman(prime, 2 ** 31));
attempt("generator NaN", () => crypto.createDiffieHellman(prime, NaN));
attempt("generator null", () => crypto.createDiffieHellman(prime, loose(null)));
attempt("generator empty string", () => crypto.createDiffieHellman(prime, loose("")));
attempt("generator true", () => crypto.createDiffieHellman(prime, loose(true)));
attempt("generator object", () => crypto.createDiffieHellman(prime, loose({})));
attempt("generator view 1", () => crypto.createDiffieHellman(prime, Buffer.from([1])));
attempt("generator view 0", () => crypto.createDiffieHellman(prime, Buffer.from([0])));
attempt("generator view empty", () => crypto.createDiffieHellman(prime, Buffer.alloc(0)));
attempt("generator view 0002", () => crypto.createDiffieHellman(prime, Buffer.from([0, 2])));
attempt("generator = p", () => crypto.createDiffieHellman(prime, prime));
attempt("generator > p", () => crypto.createDiffieHellman(prime, Buffer.concat([Buffer.from([1]), prime])));
attempt("generator string", () => crypto.createDiffieHellman(prime, loose("abc")));
attempt("generator string hex", () => crypto.createDiffieHellman(prime, loose("05"), loose("hex")));
attempt("generator bad encoding", () => crypto.createDiffieHellman(prime, loose("05"), loose("nope")));
attempt("generator uint16", () => crypto.createDiffieHellman(prime, new Uint16Array([0x0300])));

attempt("prime hex", () => crypto.createDiffieHellman(prime.toString("hex"), "hex"));
attempt("prime base64 generator", () => crypto.createDiffieHellman(prime.toString("base64"), "base64", 5));
attempt("prime utf8", () => crypto.createDiffieHellman("abc").verifyError);
attempt("prime buffer encoding", () => crypto.createDiffieHellman("abc", "buffer"));
attempt("keyEncoding as generator", () => crypto.createDiffieHellman("abc", loose("nope")).verifyError);
attempt("keyEncoding as generator with encoding", () => crypto.createDiffieHellman("abc", loose("nope"), loose("hex")));
attempt("keyEncoding number", () => crypto.createDiffieHellman(prime, loose(5)));
attempt("keyEncoding on a view", () => crypto.createDiffieHellman(prime, loose("hex"), 5));
attempt("prime ArrayBuffer", () => crypto.createDiffieHellman(new Uint8Array(prime).buffer));
attempt("prime DataView", () => crypto.createDiffieHellman(new DataView(new ArrayBuffer(3))).verifyError);
attempt("prime zero", () => crypto.createDiffieHellman(Buffer.alloc(4)).getPrime());

attempt("group unknown", () => crypto.getDiffieHellman("modp3"));
attempt("group empty", () => crypto.getDiffieHellman(""));
attempt("group ffdhe", () => crypto.createDiffieHellmanGroup("ffdhe2048"));
attempt("group case", () => crypto.getDiffieHellman("MoDp2"));
attempt("group missing", () => crypto.getDiffieHellman(loose(undefined)));
attempt("group number", () => crypto.getDiffieHellman(loose(14)));

const group = crypto.getDiffieHellman("modp2");
attempt("group public before keys", () => group.getPublicKey());
attempt("group private before keys", () => group.getPrivateKey());
attempt("group secret before keys", () => group.computeSecret(Buffer.from([5])));
const untypedGroup = loose(group);
attempt("group setPublicKey", () => untypedGroup.setPublicKey(Buffer.from([5])));
attempt("group setPrivateKey", () => untypedGroup.setPrivateKey(Buffer.from([5])));
group.generateKeys();
attempt("secret 0", () => group.computeSecret(Buffer.from([0])));
attempt("secret empty", () => group.computeSecret(Buffer.alloc(0)));
attempt("secret 1", () => group.computeSecret(Buffer.from([0, 1])));
attempt("secret p - 1", () => {
  const key = Buffer.from(group.getPrime());
  key[key.length - 1]--;
  return group.computeSecret(key);
});
attempt("secret p", () => group.computeSecret(group.getPrime()));
attempt("secret 2", () => group.computeSecret(Buffer.from([2])).length);
attempt("secret number", () => group.computeSecret(loose(5)));
attempt("secret bad input encoding", () => group.computeSecret("ab", loose("nope")));
attempt("secret bad output encoding", () => untypedGroup.computeSecret(Buffer.from([2]), null, "nope"));
attempt("getPrime bad encoding", () => untypedGroup.getPrime("nope"));
attempt("getPrime HEX", () => untypedGroup.getPrime("HEX").slice(0, 8));
attempt("getGenerator utf16le", () => untypedGroup.getGenerator("utf16le"));
attempt("verifyError call", () => untypedGroup.verifyError());
attempt("unknown member", () => untypedGroup.bogus());

const fresh = crypto.createDiffieHellman(prime);
attempt("public before keys", () => fresh.getPublicKey());
attempt("private before keys", () => fresh.getPrivateKey());
attempt("secret before keys", () => fresh.computeSecret(Buffer.from([5])));
attempt("setPublicKey number", () => fresh.setPublicKey(loose(5)));
attempt("setPrivateKey bad encoding", () => fresh.setPrivateKey("ab", loose("nope")));
attempt("setPublicKey 0", () => loose(fresh.setPublicKey(Buffer.from([0]))).getPublicKey());
attempt("setPrivateKey utf8", () => loose(fresh.setPrivateKey("ab")).getPrivateKey("hex"));

// Primes outside 512 to 10000 bits: key generation and secrets fail, but a
// private key the program sets still yields a public key.
for (const value of [23, 1, 0, 24]) {
  const label = `p ${value}`;
  const dh = crypto.createDiffieHellman(Buffer.from([value]));
  attempt(`${label} generateKeys`, () => dh.generateKeys());
  attempt(`${label} secret 2`, () => dh.computeSecret(Buffer.from([2])));
  attempt(`${label} secret 5`, () => dh.computeSecret(Buffer.from([5])));
  dh.setPrivateKey(Buffer.from([3]));
  attempt(`${label} generateKeys with key`, () => dh.generateKeys());
  attempt(`${label} public with key`, () => dh.getPublicKey());
  attempt(`${label} secret with key`, () => dh.computeSecret(Buffer.from([5])));
}
const even = Buffer.from(prime);
even[even.length - 1] = 0xfe;
const evenDh = crypto.createDiffieHellman(even);
attempt("even generateKeys", () => evenDh.generateKeys());
evenDh.setPrivateKey(Buffer.from([3]));
attempt("even generateKeys with key", () => evenDh.generateKeys());
attempt("p 23 generator 30", () =>
  loose(crypto.createDiffieHellman(Buffer.from([23]), 30).setPrivateKey(Buffer.from([2]))).generateKeys(),
);
attempt("p 9", () => loose(crypto.createDiffieHellman(Buffer.from([9])).setPrivateKey(Buffer.from([3]))).generateKeys());

// Secrets of 0, 1 and p - 1 fail like any other derivation failure: a peer
// key of order 3 or 6 modulo a prime with p ≡ 1 (mod 6), and a peer key
// sharing the factor of a square modulus.
const smooth = Buffer.from(
  "ce306415e770bb1cde0380e3c5cf4e8110b5c8e82ca36b1d9074fa1e9d1ed41b0ae295f19288302647d2da0003fcac6fa21d8953afce2c30171844815ec7d6df",
  "hex",
);
const orderThree = Buffer.from(
  "6be4b47bb9f8143334dab6349ac191ef7208ae3d5e684a2c318d43acc45ebd2a27d79b075c6e14a4e6a75899d98ce05af71ef05e1869b1add76d1622ab5e7b1d",
  "hex",
);
const orderSix = Buffer.from(
  "624baf9a2d78a6e9a928caaf2b0dbc919ead1aaace3b20f15ee7b671d8c016f0e30afaea361a1b81612b81662a6fcc14aafe98f597647a823fab2e5eb3695bc2",
  "hex",
);
function withPrivateKey(modulus, key) {
  const dh = crypto.createDiffieHellman(modulus);
  dh.setPrivateKey(Buffer.from([key]));
  return dh;
}
attempt("secret 1", () => withPrivateKey(smooth, 3).computeSecret(orderThree).toString("hex"));
attempt("secret p - 1", () => withPrivateKey(smooth, 3).computeSecret(orderSix).toString("hex"));
attempt("secret of order 3, key 4", () => withPrivateKey(smooth, 4).computeSecret(orderThree).toString("hex").slice(0, 16));
const factor = BigInt("0xdf22630cec2362c510f444af6784da7a3a714ed787eb3d6bf9158d18c087cc5d");
const square = Buffer.from((factor * factor).toString(16).padStart(128, "0"), "hex");
const factorKey = Buffer.from(factor.toString(16).padStart(128, "0"), "hex");
attempt("secret 0", () => withPrivateKey(square, 2).computeSecret(factorKey).toString("hex"));
