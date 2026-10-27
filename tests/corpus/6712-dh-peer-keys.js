// DiffieHellman computeSecret's peer key checks, and keys, primes and
// generators with leading zero bytes: under the RFC 5114 groups a peer key
// outside the order-q subgroup is invalid, while other parameters only
// check the range; a key longer than the prime is too large, and leading
// zeros of any length are ignored.
import crypto from "node:crypto";

function attempt(label, run) {
  try {
    console.log(label, "ok", JSON.stringify(run()));
  } catch (e) {
    console.log(label, e.name, e.code, e.message);
  }
}

const zeros = Buffer.alloc(100000);
const padded = (bytes) => Buffer.concat([zeros, bytes]);

// Each group's parameters, and a peer key of small order: h^((p - 1) / r)
// for a small prime r dividing (p - 1) / q.
const groups = [
  {
    label: "RFC 5114 1024-bit",
    order: 7,
    p: "B10B8F96A080E01DDE92DE5EAE5D54EC52C99FBCFB06A3C69A6A9DCA52D23B616073E28675A23D189838EF1E2EE652C013ECB4AEA906112324975C3CD49B83BFACCBDD7D90C4BD7098488E9C219A73724EFFD6FAE5644738FAA31A4FF55BCCC0A151AF5F0DC8B4BD45BF37DF365C1A65E68CFDA76D4DA708DF1FB2BC2E4A4371",
    g: "A4D1CBD5C3FD34126765A442EFB99905F8104DD258AC507FD6406CFF14266D31266FEA1E5C41564B777E690F5504F213160217B4B01B886A5E91547F9E2749F4D7FBD7D3B9A92EE1909D0D2263F80A76A6A24C087A091F531DBF0A0169B6A28AD662A4D18E73AFA32D779D5918D08BC8858F4DCEF97C2A24855E6EEB22B3B2E5",
    small: "24986e0c35fbae0d16a21b2aab7eac0dc32e9ca8c24c1eb9387366ee8a6df2bee49b6f46ea2525d208c1bc3d87e3749586616e0161a305f670830ba1fa9e4c5a1bd5ae9f4dc2032f1fd99bbcf3f4444a09d4da3ccbde680580ee8d78feced92d1efb235fc9f25c8525a4e5a453ccf7375119cee48b05421c093d10c8b6e90ab8",
  },
  {
    label: "RFC 5114 2048-bit, 224-bit q",
    order: 3,
    p: "AD107E1E9123A9D0D660FAA79559C51FA20D64E5683B9FD1B54B1597B61D0A75E6FA141DF95A56DBAF9A3C407BA1DF15EB3D688A309C180E1DE6B85A1274A0A66D3F8152AD6AC2129037C9EDEFDA4DF8D91E8FEF55B7394B7AD5B7D0B6C12207C9F98D11ED34DBF6C6BA0B2C8BBC27BE6A00E0A0B9C49708B3BF8A317091883681286130BC8985DB1602E714415D9330278273C7DE31EFDC7310F7121FD5A07415987D9ADC0A486DCDF93ACC44328387315D75E198C641A480CD86A1B9E587E8BE60E69CC928B2B9C52172E413042E9B23F10B0E16E79763C9B53DCF4BA80A29E3FB73C16B8E75B97EF363E2FFA31F71CF9DE5384E71B81C0AC4DFFE0C10E64F",
    g: "AC4032EF4F2D9AE39DF30B5C8FFDAC506CDEBE7B89998CAF74866A08CFE4FFE3A6824A4E10B9A6F0DD921F01A70C4AFAAB739D7700C29F52C57DB17C620A8652BE5E9001A8D66AD7C17669101999024AF4D027275AC1348BB8A762D0521BC98AE247150422EA1ED409939D54DA7460CDB5F6C6B250717CBEF180EB34118E98D119529A45D6F834566E3025E316A330EFBB77A86F0C1AB15B051AE3D428C8F8ACB70A8137150B8EEB10E183EDD19963DDD9E263E4770589EF6AA21E7F5F2FF381B539CCE3409D13CD566AFBB48D6C019181E1BCFE94B30269EDFE72FE9B6AA4BD7B5A0F1C71CFFF4C19C418E1F6EC017981BC087F2A7065B384B890D3191F2BFA",
    small: "73ef184cd50bd427992f4bbeaf1d7712f8cb8264929f533ded004618b29064e3583963fc634df866ef9aa5f158077765219401ad4bf0a2c42204241c8a728af1012cfd399a76f13a0e2cb153c0888a9eb0e05312610923777d185f46bf865bbfe86a0e79a6761d7e153cb46e2221dc3415a7e78c22d33c3d1e2363c041bb57badd344969ee2a1c4917d26ab51a20bc343b4db9964871b0918b2b8e97ff7d297e8b8ca2329426755fdf302a6401030c0f0206a0da004cac53d4408d2ff47cff332435d1f01cbeee301b8dda896be231fd38264f1a5c2b51365a8e74e608a2510c26c92c8d091e18577e854c43d5dc3b2779552f6723878deb5ec58bce2da61abe",
  },
  {
    label: "RFC 5114 2048-bit, 256-bit q",
    order: 7,
    p: "87A8E61DB4B6663CFFBBD19C651959998CEEF608660DD0F25D2CEED4435E3B00E00DF8F1D61957D4FAF7DF4561B2AA3016C3D91134096FAA3BF4296D830E9A7C209E0C6497517ABD5A8A9D306BCF67ED91F9E6725B4758C022E0B1EF4275BF7B6C5BFC11D45F9088B941F54EB1E59BB8BC39A0BF12307F5C4FDB70C581B23F76B63ACAE1CAA6B7902D52526735488A0EF13C6D9A51BFA4AB3AD8347796524D8EF6A167B5A41825D967E144E5140564251CCACB83E6B486F6B3CA3F7971506026C0B857F689962856DED4010ABD0BE621C3A3960A54E710C375F26375D7014103A4B54330C198AF126116D2276E11715F693877FAD7EF09CADB094AE91E1A1597",
    g: "3FB32C9B73134D0B2E77506660EDBD484CA7B18F21EF205407F4793A1A0BA12510DBC15077BE463FFF4FED4AAC0BB555BE3A6C1B0C6B47B1BC3773BF7E8C6F62901228F8C28CBB18A55AE31341000A650196F931C77A57F2DDF463E5E9EC144B777DE62AAAB8A8628AC376D282D6ED3864E67982428EBC831D14348F6F2F9193B5045AF2767164E1DFC967C1FB3F2E55A4BD1BFFE83B9C80D052B985D182EA0ADB2A3B7313D3FE14C8484B1E052588B9B7D2BBD2DF016199ECD06E1557CD0915B3353BBB64E0EC377FD028370DF92B52C7891428CDC67EB6184B523D1DB246C32F63078490F00EF8D647D148D47954515E2327CFEF98C582664B4C0F6CC41659",
    small: "7e22fad9cc23b5949616a26b060dcec3557a81d98dc45f51943f4e29b06dd73e6fbf201c01c4c2620b81698048fcb21655d1276bfb402a41c3af50528f2df02b3440a3b7a1855dfe31a549ddce9563ed18fe1530a3a649f87fa4d427d6d2e1b73cf3848177651080f2ca96628fed411c331d9e28d28da5f0c65f2516f9bb4c72e4c9050f5d654bcc0139e66fbc582ae32d345ad84a249d9cea131c6a9af59ecaefbc190ca265394eb8190ff91a6af58327060ca4900829eaa3a1c26f86737d7510bfd55c430bcc1f2db6a62c3bfe1717e5236945c475bb7b36dc2fa5ab06b089325dfd864a6b044622e62a5638ce23f319cf564826ce1e5c1bc1166896c5f205",
  },
];

for (const group of groups) {
  const p = Buffer.from(group.p, "hex");
  const g = Buffer.from(group.g, "hex");
  const alice = crypto.createDiffieHellman(p, g);
  const bob = crypto.createDiffieHellman(p, g);
  alice.generateKeys();
  bob.generateKeys();
  const name = group.label;
  attempt(`${name}: verifyError`, () => alice.verifyError);
  attempt(`${name}: agreed`, () => alice.computeSecret(bob.getPublicKey()).equals(bob.computeSecret(alice.getPublicKey())));
  attempt(`${name}: order ${group.order}`, () => alice.computeSecret(Buffer.from(group.small, "hex")).length);
  attempt(`${name}: 2`, () => alice.computeSecret(Buffer.from([2])).length);
  attempt(`${name}: p - 2`, () => {
    const key = Buffer.from(p);
    key[key.length - 1] -= 2;
    return alice.computeSecret(key).length;
  });
  attempt(`${name}: p - 1`, () => {
    const key = Buffer.from(p);
    key[key.length - 1] -= 1;
    return alice.computeSecret(key).length;
  });
  attempt(`${name}: without keys`, () => crypto.createDiffieHellman(p, g).computeSecret(Buffer.from([2])).length);
  // The same prime with another generator is not the named group. The
  // private key is a multiple of neither 3 nor 7, so the small-order key
  // gives a secret other than 1.
  const other = crypto.createDiffieHellman(p, 2);
  other.setPrivateKey(Buffer.from("0123456789abcdee", "hex"));
  attempt(`${name}, generator 2: order ${group.order}`, () => other.computeSecret(Buffer.from(group.small, "hex")).length);
  attempt(`${name}, generator 2: 2`, () => other.computeSecret(Buffer.from([2])).length);
}

// The safe prime groups check only the range: 11 is a quadratic
// non-residue modulo the 2048-bit MODP prime.
const modp14 = crypto.getDiffieHellman("modp14");
modp14.generateKeys();
attempt("modp14: non-residue", () => modp14.computeSecret(Buffer.from([11])).length);
const explicit = crypto.createDiffieHellman(modp14.getPrime(), modp14.getGenerator());
explicit.generateKeys();
attempt("modp14 explicit: non-residue", () => explicit.computeSecret(Buffer.from([11])).length);

// Keys longer than the prime, and leading zeros.
const peer = crypto.createDiffieHellman(modp14.getPrime(), 2);
peer.generateKeys();
const secret = modp14.computeSecret(peer.getPublicKey());
attempt("100000 bytes of 0xff", () => modp14.computeSecret(Buffer.alloc(100000, 0xff)).length);
attempt("prime and one byte", () => modp14.computeSecret(Buffer.concat([Buffer.from([1]), modp14.getPrime()])).length);
attempt("hex of 100000 bytes", () => modp14.computeSecret(Buffer.alloc(100000, 0x7f).toString("hex"), "hex").length);
attempt("zero-padded key", () => modp14.computeSecret(padded(peer.getPublicKey())).equals(secret));
attempt("zero-padded hex key", () => modp14.computeSecret(padded(peer.getPublicKey()).toString("hex"), "hex").equals(secret));
attempt("zeros", () => modp14.computeSecret(zeros).length);
attempt("zero-padded 1", () => modp14.computeSecret(padded(Buffer.from([1]))).length);
attempt("zero-padded p - 1", () => {
  const key = Buffer.from(modp14.getPrime());
  key[key.length - 1] -= 1;
  return modp14.computeSecret(padded(key)).length;
});
attempt("zero-padded public key", () => {
  const dh = crypto.createDiffieHellman(modp14.getPrime(), 2);
  dh.setPublicKey(padded(peer.getPublicKey()));
  return dh.getPublicKey().equals(peer.getPublicKey());
});
attempt("zero-padded private key", () => {
  const dh = crypto.createDiffieHellman(modp14.getPrime(), 2);
  dh.setPrivateKey(padded(peer.getPrivateKey()));
  return [dh.getPrivateKey().equals(peer.getPrivateKey()), dh.generateKeys().equals(peer.getPublicKey())];
});
attempt("zero-padded prime and generator", () => {
  const dh = crypto.createDiffieHellman(padded(modp14.getPrime()), padded(Buffer.from([2])));
  return [dh.verifyError, dh.getPrime().equals(modp14.getPrime()), dh.getGenerator("hex")];
});
attempt("generator of 100000 bytes", () => crypto.createDiffieHellman(modp14.getPrime(), Buffer.alloc(100000, 0xff)).verifyError);
attempt("zero-padded generator 1", () => crypto.createDiffieHellman(modp14.getPrime(), padded(Buffer.from([1]))).verifyError);
