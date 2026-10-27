// ECDH private keys: setPrivateKey reads strings in their encoding and
// views as bytes, keeps leading zero bytes out of getPrivateKey, accepts
// values just below the curve order, and replaces the public key with
// d·G. generateKeys always makes a new pair.
import { createECDH } from "node:crypto";

const ecdh = createECDH("prime256v1");
ecdh.setPrivateKey(Buffer.from("0000000000000001ff", "hex"));
console.log(ecdh.getPrivateKey("hex"), ecdh.getPrivateKey().length);
ecdh.setPrivateKey("abc", "binary");
console.log(ecdh.getPrivateKey("hex"), ecdh.getPublicKey("hex", "compressed"));
ecdh.setPrivateKey("YWJj", "base64");
console.log(ecdh.getPrivateKey("hex"));
ecdh.setPrivateKey("616263", "hex");
console.log(ecdh.getPrivateKey("base64url"));
ecdh.setPrivateKey(new Uint16Array([0x0102, 0x0304]));
console.log(ecdh.getPrivateKey("hex"));

// n - 1 is the largest private key; its public key is -G.
const nMinus1 = "ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632550";
ecdh.setPrivateKey(nMinus1, "hex");
console.log(ecdh.getPrivateKey("hex") === nMinus1, ecdh.getPublicKey("hex", "compressed"));
ecdh.setPrivateKey(Buffer.from([1]));
console.log(ecdh.getPublicKey("hex", "compressed"));

// A key longer than the order is fine when its value is below it.
ecdh.setPrivateKey(Buffer.concat([Buffer.alloc(40), Buffer.from([3])]));
console.log(ecdh.getPrivateKey("hex"));

// secp521r1's order is a 521-bit number: 66 bytes with a 0x01 top byte.
const big = createECDH("secp521r1");
big.setPrivateKey(Buffer.concat([Buffer.from([1]), Buffer.alloc(65, 0x22)]));
console.log(big.getPrivateKey().length, big.getPublicKey(null, "compressed").length);
try {
  big.setPrivateKey(Buffer.alloc(66, 0xff));
} catch (e) {
  console.log((e as Error).name, (e as { code?: string }).code);
}
console.log(big.getPrivateKey().length);

// generateKeys makes a new private key every time.
const random = createECDH("secp256k1");
random.setPrivateKey(Buffer.from([2]));
const before = random.getPrivateKey("hex");
random.generateKeys();
console.log(random.getPrivateKey("hex") === before, random.getPrivateKey().length <= 32);
const first: string = random.generateKeys("base64", "compressed");
const second: string = random.generateKeys("base64", "compressed");
console.log(first.length, first === second);
