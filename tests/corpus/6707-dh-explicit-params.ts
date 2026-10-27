// crypto.createDiffieHellman over explicit parameters: fixed private keys
// give Node's public keys and secrets, verifyError reports DH_check's
// findings, and parameters that equal an OpenSSL named group draw private
// keys of the group's length.
import { createDiffieHellman, getDiffieHellman, type DiffieHellman } from "node:crypto";

// A 512-bit safe prime with p ≡ 23 (mod 24).
const P512 =
  "f29864297728009aab9d4220c05ca2d80a5e4ac2f016cd098543a2486bde8bcb" +
  "deed9eab7029c8d2b7a681f9495bfc7b1c39c6db64457bb79beeb74a4b78f5ff";

function bitLength(bytes: Buffer): number {
  if (bytes.length === 0) return 0;
  return (bytes.length - 1) * 8 + bytes[0]!.toString(2).length;
}

function fixed(prime: Buffer, generator: number | Buffer, key: string): DiffieHellman {
  const dh = createDiffieHellman(prime, generator);
  dh.setPrivateKey(key, "hex");
  return dh;
}

const prime512 = Buffer.from(P512, "hex");
for (const generator of [2, 3, 5, Buffer.from([0x0b])]) {
  const alice = fixed(prime512, generator, "0123456789abcdef0123456789abcdef");
  const bob = fixed(prime512, generator, "fedcba9876543210fedcba9876543210ff");
  const alicePublic: string = alice.generateKeys("hex");
  const bobPublic: Buffer = bob.generateKeys();
  const secret: string = alice.computeSecret(bobPublic, null, "hex");
  console.log(alice.getGenerator("hex"), alice.verifyError, alicePublic.slice(0, 32), bobPublic.length);
  console.log(secret, secret === bob.computeSecret(alicePublic, "hex", "hex"));
}

// Secrets pad to the prime's length; public keys are minimal.
const modp1 = getDiffieHellman("modp1").getPrime();
const small = fixed(modp1, 2, "01");
console.log(small.generateKeys("hex"), small.getPrivateKey("hex"));
const big = fixed(modp1, 2, "ff".repeat(100));
console.log(big.generateKeys().length, big.getPrivateKey().length);
const padded: Buffer = small.computeSecret(Buffer.from([4]));
console.log(padded.length, padded.subarray(0, 4).toString("hex"), padded.subarray(-2).toString("hex"));
console.log(big.computeSecret(Buffer.from([2]), null, "base64url"));

// A private key of 0 still yields a public key; reading it back and
// deriving a secret from it fail. A private key of 1 answers the peer's
// key.
function report(run: () => unknown): void {
  try {
    const result = run();
    console.log(Buffer.isBuffer(result) ? result.toString("hex") : result);
  } catch (error) {
    const e = error as Error & { code?: string };
    console.log(e.name, e.code, e.message);
  }
}
const zero = fixed(prime512, 2, "00");
console.log(zero.generateKeys("hex"));
report(() => zero.getPrivateKey());
report(() => zero.computeSecret(Buffer.from([5])));
report(() => fixed(prime512, 2, "01").computeSecret(Buffer.from([5])));

// A private key longer than the prime: 8800 bits.
const long = fixed(modp1, 2, "ff".repeat(1100));
console.log(long.generateKeys("hex").slice(0, 32), long.computeSecret(Buffer.from([7]), null, "hex").slice(-32));

// setPublicKey and setPrivateKey answer the object and replace the keys.
const keys = createDiffieHellman(prime512);
keys.setPublicKey(Buffer.from([0, 0, 7]));
keys.setPrivateKey("0005", "hex");
console.log(keys.getPublicKey("hex"), keys.getPrivateKey("hex"));
console.log(keys.generateKeys("hex").length, keys.getPublicKey("hex") !== "07");

// verifyError for small, even, composite and non-safe primes and for
// unsuitable generators.
const cases: [string, number | string][] = [
  ["01", 2],
  ["02", 2],
  ["03", 2],
  ["0d", 2],
  ["15", 2],
  ["17", 2],
  ["17", 5],
  ["17", "16"],
  ["17", "1e"],
  ["18", 2],
  ["000017", 2],
  ["05", 2],
  ["05", 5],
  ["07", 2],
  ["09", 2],
  ["0b", 5],
  ["0f", 2],
  ["11", 2],
  ["2f", 2],
  ["3b", 5],
  ["0231", 2],
  ["0451", 2],
  ["07ff", 2],
];
for (const [prime, generator] of cases) {
  const g = typeof generator === "number" ? generator : Buffer.from(generator, "hex");
  console.log(prime, generator, createDiffieHellman(Buffer.from(prime, "hex"), g).verifyError);
}
const almost = Buffer.from(P512, "hex");
almost[almost.length - 1] = 0xfe;
console.log(createDiffieHellman(almost).verifyError);
const composite = Buffer.from(P512, "hex");
composite[composite.length - 1] = 0xfd;
console.log(createDiffieHellman(composite).verifyError);
const generatorPMinus1 = Buffer.from(P512, "hex");
generatorPMinus1[generatorPMinus1.length - 1] = 0xfe;
console.log(createDiffieHellman(prime512, generatorPMinus1).verifyError);

// Generated keys: bits(p) - 2 bits for other primes, at most the named
// group's key length for RFC 3526 and RFC 5114 parameters.
const generated = createDiffieHellman(prime512);
generated.generateKeys();
console.log(bitLength(generated.getPrivateKey()));
const modp14 = getDiffieHellman("modp14").getPrime();
const named = createDiffieHellman(modp14, Buffer.from([0, 2]));
named.generateKeys();
console.log(named.verifyError, bitLength(named.getPrivateKey()) <= 225);
const notNamed = createDiffieHellman(modp1);
notNamed.generateKeys();
console.log(bitLength(notNamed.getPrivateKey()));
const rfc5114 = createDiffieHellman(
  Buffer.from(
    "b10b8f96a080e01dde92de5eae5d54ec52c99fbcfb06a3c69a6a9dca52d23b616073e28675a23d189838ef1e2ee652c0" +
      "13ecb4aea906112324975c3cd49b83bfaccbdd7d90c4bd7098488e9c219a73724effd6fae5644738faa31a4ff55bccc0" +
      "a151af5f0dc8b4bd45bf37df365c1a65e68cfda76d4da708df1fb2bc2e4a4371",
    "hex",
  ),
  Buffer.from(
    "a4d1cbd5c3fd34126765a442efb99905f8104dd258ac507fd6406cff14266d31266fea1e5c41564b777e690f5504f213" +
      "160217b4b01b886a5e91547f9e2749f4d7fbd7d3b9a92ee1909d0d2263f80a76a6a24c087a091f531dbf0a0169b6a28a" +
      "d662a4d18e73afa32d779d5918d08bc8858f4dcef97c2a24855e6eeb22b3b2e5",
    "hex",
  ),
);
rfc5114.generateKeys();
console.log(rfc5114.verifyError, bitLength(rfc5114.getPrivateKey()) <= 160);
// RFC 5114's 2048-bit group with a 256-bit subgroup draws 224-bit keys.
const rfc5114q256 = createDiffieHellman(
  Buffer.from(
    "87a8e61db4b6663cffbbd19c651959998ceef608660dd0f25d2ceed4435e3b00e00df8f1d61957d4faf7df4561b2aa30" +
      "16c3d91134096faa3bf4296d830e9a7c209e0c6497517abd5a8a9d306bcf67ed91f9e6725b4758c022e0b1ef4275bf7b" +
      "6c5bfc11d45f9088b941f54eb1e59bb8bc39a0bf12307f5c4fdb70c581b23f76b63acae1caa6b7902d52526735488a0e" +
      "f13c6d9a51bfa4ab3ad8347796524d8ef6a167b5a41825d967e144e5140564251ccacb83e6b486f6b3ca3f7971506026" +
      "c0b857f689962856ded4010abd0be621c3a3960a54e710c375f26375d7014103a4b54330c198af126116d2276e11715f" +
      "693877fad7ef09cadb094ae91e1a1597",
    "hex",
  ),
  Buffer.from(
    "3fb32c9b73134d0b2e77506660edbd484ca7b18f21ef205407f4793a1a0ba12510dbc15077be463fff4fed4aac0bb555" +
      "be3a6c1b0c6b47b1bc3773bf7e8c6f62901228f8c28cbb18a55ae31341000a650196f931c77a57f2ddf463e5e9ec144b" +
      "777de62aaab8a8628ac376d282d6ed3864e67982428ebc831d14348f6f2f9193b5045af2767164e1dfc967c1fb3f2e55" +
      "a4bd1bffe83b9c80d052b985d182ea0adb2a3b7313d3fe14c8484b1e052588b9b7d2bbd2df016199ecd06e1557cd0915" +
      "b3353bbb64e0ec377fd028370df92b52c7891428cdc67eb6184b523d1db246c32f63078490f00ef8d647d148d4795451" +
      "5e2327cfef98c582664b4c0f6cc41659",
    "hex",
  ),
);
let widest = 0;
for (let i = 0; i < 8; i++) {
  const keys = createDiffieHellman(rfc5114q256.getPrime(), rfc5114q256.getGenerator());
  keys.generateKeys();
  widest = Math.max(widest, bitLength(keys.getPrivateKey()));
}
console.log(rfc5114q256.verifyError, widest <= 224, widest > 200);
